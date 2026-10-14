import csv
import json
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from forex_replay import backtests
from forex_replay.journal import COLUMNS
from forex_replay.server import make_server

UTC_2026_03_05_0900 = 1772701200  # Thu 5 Mar 2026 09:00 UTC; server time is UTC+2 in winter


def closed_trade(trade_id=1, **changes):
    trade = {
        "id": trade_id, "status": "CLOSED", "side": "BUY", "orderType": "MARKET",
        "placedTime": UTC_2026_03_05_0900, "entryTime": UTC_2026_03_05_0900 + 300,
        "exitTime": UTC_2026_03_05_0900 + 3600,
        "entryPrice": 108500, "exitPrice": 108700, "stopLoss": 108400, "takeProfit": 108700,
        "plannedRisk": 100, "pnl": 200, "resultR": 2.0, "plannedRewardR": 2.0,
        "mfeR": 2.0, "maeR": 0.3, "exitReason": "TAKE_PROFIT",
    }
    trade.update(changes)
    return trade


def backtest(trades, backtest_id="bt-1", journal="test_journal"):
    return {
        "version": 1, "id": backtest_id, "journal": journal, "name": "test", "symbol": "EURUSD",
        "digits": 5, "pipPoints": 10, "startTime": UTC_2026_03_05_0900, "furthestTime": UTC_2026_03_05_0900 + 7200,
        "settings": {"startingBalance": 10000}, "actions": [], "drawings": [], "trades": trades,
        "saved": "2026-10-03T12:00:00Z",
    }


def read_journal(root):
    with (root / "test_journal" / "trades.csv").open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def test_saving_writes_the_file_and_journals_closed_trades_once():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        open_trade = closed_trade(2, status="OPEN", exitTime=None, exitPrice=None, pnl=None, resultR=None)
        result = backtests.save("test_journal", "bt-1", backtest([closed_trade(1), open_trade]), root)
        assert result["journalAdded"] == 1
        assert json.loads((root / "test_journal" / "backtests" / "bt-1.json").read_text())["id"] == "bt-1"

        # Saved again after the second trade closed: only the new one is added.
        later = closed_trade(2, exitPrice=108400, pnl=-100, resultR=-1.0, exitReason="STOP_LOSS")
        assert backtests.save("test_journal", "bt-1", backtest([closed_trade(1), later]), root)["journalAdded"] == 1
        assert backtests.save("test_journal", "bt-1", backtest([closed_trade(1), later]), root)["journalAdded"] == 0
        rows = read_journal(root)
        assert [r["trade_id"] for r in rows] == ["1", "2"]
        assert list(rows[0].keys()) == COLUMNS


def test_journal_rows_use_v1_format_and_the_broker_server_clock():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        backtests.save("test_journal", "bt-1", backtest([closed_trade(1)]), root)
        row = read_journal(root)[0]
        assert row["run_id"] == "bt-1"
        assert row["entry_time"] == "2026-03-05 11:05:00"  # 09:05 UTC + 2h server time in March
        assert row["entry_price"] == "1.085" and row["stop_loss"] == "1.084"
        assert row["risk_pips"] == "10.0" and row["pnl_pips"] == "20.0" and row["result_r"] == "2.0"
        assert row["session"] == "London" and row["weekday"] == "Thursday" and row["duration_min"] == "55.0"


def test_unsafe_names_and_damaged_backtests_are_refused():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for journal, backtest_id in [("..", "x"), ("a/b", "x"), ("ok", "../../evil"), ("", "x")]:
            with pytest.raises(backtests.BacktestError):
                backtests.path_for(journal, backtest_id, root)
        with pytest.raises(backtests.BacktestError):
            backtests.save("test_journal", "bt-2", backtest([]), root)  # id inside says bt-1
        damaged = backtest([])
        del damaged["actions"]
        with pytest.raises(backtests.BacktestError):
            backtests.save("test_journal", "bt-1", damaged, root)
        assert not any(root.rglob("*.json"))


def test_list_and_delete_keep_the_journal():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        backtests.save("test_journal", "bt-1", backtest([closed_trade(1)]), root)
        listed = backtests.list_backtests(root)
        assert [b["id"] for b in listed] == ["bt-1"] and "actions" not in listed[0]
        backtests.delete("test_journal", "bt-1", root)
        assert backtests.list_backtests(root) == []
        assert len(read_journal(root)) == 1
        with pytest.raises(FileNotFoundError):
            backtests.load("test_journal", "bt-1", root)


def test_server_saves_only_json_and_serves_the_list():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        server = make_server(port=18785, root=root, journals_root=root / "strategies")
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}/api/backtests"
        try:
            body = json.dumps(backtest([closed_trade(1)])).encode()

            def put(content_type):
                request = urllib.request.Request(f"{base}/test_journal/bt-1", data=body, method="PUT",
                                                 headers={"Content-Type": content_type})
                return urllib.request.urlopen(request)

            with pytest.raises(urllib.error.HTTPError) as refused:  # what a form on another site could send
                put("text/plain")
            assert refused.value.code == 400
            with put("application/json") as r:
                assert json.loads(r.read())["journalAdded"] == 1
            with urllib.request.urlopen(base) as r:
                assert [b["id"] for b in json.loads(r.read())["backtests"]] == ["bt-1"]
            with urllib.request.urlopen(f"{base}/test_journal/bt-1") as r:
                assert json.loads(r.read())["trades"][0]["id"] == 1
            with pytest.raises(urllib.error.HTTPError) as missing:
                urllib.request.urlopen(f"{base}/test_journal/nope")
            assert missing.value.code == 404
        finally:
            server.shutdown()
            server.server_close()


def test_an_old_v1_journal_is_widened_and_keeps_its_rows():
    from forex_replay.journal import V1_COLUMNS
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        path = root / "test_journal" / "trades.csv"
        path.parent.mkdir(parents=True)
        old = dict.fromkeys(V1_COLUMNS, "")
        old.update(trade_id="1", run_id="legacy-run-1", result_r="1.07")
        with path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=V1_COLUMNS)
            writer.writeheader()
            writer.writerow(old)
        backtests.save("test_journal", "bt-1", backtest([closed_trade(1)]), root)
        rows = read_journal(root)
        assert list(rows[0].keys()) == COLUMNS
        assert (rows[0]["run_id"], rows[0]["result_r"], rows[0]["note"]) == ("legacy-run-1", "1.07", "")
        assert rows[1]["run_id"] == "bt-1"


def test_money_and_notes_reach_the_journal_and_notes_can_change_later():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        trade = closed_trade(1, lots=1.5, money=296.0, commission=6.0, note="Clean sweep of Asia high",
                             tags=["A+ setup", "London"], screenshots=["bt-1-t1-exit.png"])
        backtests.save("test_journal", "bt-1", backtest([trade]), root)
        row = read_journal(root)[0]
        assert (row["lots"], row["pnl_usd"], row["commission_usd"]) == ("1.5", "296.0", "6.0")
        assert (row["note"], row["tags"], row["screenshots"]) == ("Clean sweep of Asia high", "A+ setup; London", "bt-1-t1-exit.png")

        later = {**trade, "note": "Entered late", "tags": ["late entry"], "exitPrice": 1}  # a changed result is ignored
        result = backtests.save("test_journal", "bt-1", backtest([later]), root)
        assert (result["journalAdded"], result["journalUpdated"]) == (0, 1)
        row = read_journal(root)[0]
        assert (row["note"], row["tags"], row["exit_price"]) == ("Entered late", "late entry", "1.087")
        assert backtests.save("test_journal", "bt-1", backtest([later]), root)["journalUpdated"] == 0


def test_screenshots_must_be_png_with_a_safe_name():
    png = b"\x89PNG\r\n\x1a\n" + b"rest of the image"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        backtests.save_image("test_journal", "bt-1-t1-exit.png", png, root)
        assert backtests.load_image("test_journal", "bt-1-t1-exit.png", root) == png
        with pytest.raises(backtests.BacktestError):
            backtests.save_image("test_journal", "evil.png", b"<script>", root)
        for name in ["../x.png", "a.svg", "a.png.exe", "", "a b.png"]:
            with pytest.raises(backtests.BacktestError):
                backtests.image_path("test_journal", name, root)
        backtests.delete_image("test_journal", "bt-1-t1-exit.png", root)
        with pytest.raises(FileNotFoundError):
            backtests.load_image("test_journal", "bt-1-t1-exit.png", root)


def test_server_takes_screenshots_only_as_png():
    png = b"\x89PNG\r\n\x1a\n" + b"image"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        server = make_server(port=18795, root=root, journals_root=root / "strategies")
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_address[1]}/api/screenshots/test_journal/bt-1-t1-entry.png"
        try:
            def put(content_type):
                return urllib.request.urlopen(urllib.request.Request(url, data=png, method="PUT",
                                                                     headers={"Content-Type": content_type}))
            with pytest.raises(urllib.error.HTTPError) as refused:
                put("text/plain")
            assert refused.value.code == 400
            with put("image/png") as r:
                assert json.loads(r.read())["ok"] is True
            with urllib.request.urlopen(url) as r:
                assert r.headers["Content-Type"] == "image/png" and r.read() == png
        finally:
            server.shutdown()
            server.server_close()


def test_journals_are_listed_and_read_for_the_analytics_page():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        backtests.save("test_journal", "bt-1", backtest([closed_trade(1, note="a, b\nc")]), root)
        assert backtests.list_journals(root) == [{"name": "test_journal", "trades": 1}]
        rows = backtests.journal_rows("test_journal", root)
        assert rows[0]["result_r"] == "2.0" and rows[0]["note"] == "a, b\nc"
        with pytest.raises(backtests.BacktestError):
            backtests.journal_rows("../x", root)
        with pytest.raises(FileNotFoundError):
            backtests.journal_rows("nope", root)


def test_the_website_build_copies_the_app_and_asks_not_to_be_listed():
    from forex_replay.site import build_site
    with tempfile.TemporaryDirectory() as tmp:
        web = Path(tmp) / "web"
        for folder in ("css", "js", "data/EURUSD", "vendor", "tests"):
            (web / folder).mkdir(parents=True)
        (web / "index.html").write_text("<!doctype html><html><head><title>x</title></head></html>")
        (web / "js" / "main.js").write_text("export {};")
        (web / "data" / "EURUSD" / "manifest.json").write_text("{}")
        (web / "vendor" / "lib.js").write_text("//")
        (web / "tests" / "a.test.mjs").write_text("//")
        out = Path(tmp) / "site"
        result = build_site(out, web_root=web, refresh=False)
        assert json.loads((out / "site.json").read_text())["static"] is True
        assert '<meta name="robots" content="noindex, nofollow">' in (out / "index.html").read_text()
        assert (out / "robots.txt").read_text().startswith("User-agent: *\nDisallow: /")
        assert "X-Robots-Tag: noindex" in (out / "_headers").read_text()
        assert (out / "data" / "EURUSD" / "manifest.json").exists() and not (out / "tests").exists()
        assert result["files"] == 7  # index, main.js, manifest, chart library, robots.txt, _headers, site.json
        build_site(out, web_root=web, refresh=False)  # building again over an earlier build is fine
        other = Path(tmp) / "something"
        other.mkdir()
        (other / "keep.txt").write_text("mine")
        with pytest.raises(ValueError):
            build_site(other, web_root=web, refresh=False)  # never wipes a folder that is not a build
        assert (other / "keep.txt").exists()
        with pytest.raises(ValueError):
            build_site(web / "out", web_root=web, refresh=False)


def test_moving_a_backtest_takes_its_rows_and_screenshots_and_leaves_others():
    png = b"\x89PNG\r\n\x1a\n" + b"image"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        shot = "bt-1-t1-entry.png"
        backtests.save("test_journal", "bt-1", backtest([closed_trade(1, screenshots=[shot]), closed_trade(2)]), root)
        backtests.save("test_journal", "bt-2", backtest([closed_trade(1)], backtest_id="bt-2"), root)
        backtests.save_image("test_journal", shot, png, root)

        result = backtests.move("test_journal", "bt-1", "other", root)
        assert (result["journalAdded"], result["journalRemoved"], result["screenshotsMoved"]) == (2, 2, 1)
        assert [(r["run_id"], r["trade_id"]) for r in read_journal(root)] == [("bt-2", "1")]  # only the other run stays
        assert [r["trade_id"] for r in backtests.journal_rows("other", root)] == ["1", "2"]
        assert backtests.load("other", "bt-1", root)["journal"] == "other"
        assert backtests.load_image("other", shot, root) == png
        with pytest.raises(FileNotFoundError):
            backtests.load("test_journal", "bt-1", root)

        with pytest.raises(backtests.BacktestError):  # not onto itself, nor onto a backtest already there
            backtests.move("test_journal", "bt-2", "test_journal", root)
        backtests.save("other", "bt-2", backtest([], backtest_id="bt-2", journal="other"), root)
        with pytest.raises(backtests.BacktestError):
            backtests.move("test_journal", "bt-2", "other", root)
        with pytest.raises(backtests.BacktestError):
            backtests.move("test_journal", "bt-2", "no spaces", root)


def test_server_moves_a_backtest():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        server = make_server(port=18805, root=root, journals_root=root / "strategies")
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}/api/backtests"
        try:
            backtests.save("test_journal", "bt-1", backtest([closed_trade(1)]), root / "strategies")
            request = urllib.request.Request(f"{base}/test_journal/bt-1/move", data=json.dumps({"to": "other"}).encode(),
                                             method="POST", headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request) as r:
                assert json.loads(r.read())["journalRemoved"] == 1
            with urllib.request.urlopen(base) as r:
                assert [(b["journal"], b["id"]) for b in json.loads(r.read())["backtests"]] == [("other", "bt-1")]
        finally:
            server.shutdown()
            server.server_close()


def test_the_strategy_library_keeps_rules_and_version_notes_and_drops_the_rest():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        assert backtests.load_library(root) == {"strategies": {}}
        backtests.save_library({"strategies": {
            "OB Retest": {"rules": "Enter on the retest of an order block", "versions": {"v1": "first", "v2": "London only"}, "extra": 1},
            "": {"rules": "no name"}, "Bad": "not an entry"}, "other": True}, root)
        assert backtests.load_library(root) == {"strategies": {
            "OB Retest": {"rules": "Enter on the retest of an order block", "versions": {"v1": "first", "v2": "London only"}}}}
        (root / backtests.LIBRARY_FILE).write_text("{damaged", encoding="utf-8")
        assert backtests.load_library(root) == {"strategies": {}}
