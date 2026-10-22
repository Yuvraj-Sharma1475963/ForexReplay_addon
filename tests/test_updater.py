import tempfile
from pathlib import Path

import pandas as pd
import pytest

from forex_replay import datapipe
from forex_replay.updater import AUTO_FILE, FILL_FILE, clean, median_spread, read_existing, update, write_export


def candles(start, n, price=1.16000, spread=7, step=0.00010):
    """n M5 candles on the server clock from `start`, rising slowly."""
    index = pd.date_range(start, periods=n, freq="5min", name="server_time")
    rows = []
    for i in range(n):
        o = round(price + i * step, 5)
        c = round(o + step, 5)
        rows.append({"open": o, "high": round(c + 0.00005, 5), "low": round(o - 0.00005, 5), "close": c, "volume": 50, "spread": spread})
    return pd.DataFrame(rows, index=index)


def export_dir(tmp):
    data = Path(tmp) / "data"
    write_export(candles("2026-09-07 00:00", 288 * 5), data / "EURUSD_M5_mt5_2026-09.csv")  # Mon 7 to Fri 11 Sep
    return data


def test_clean_fixes_what_can_be_fixed_and_drops_the_rest():
    df = candles("2026-09-11 23:30", 12)  # Friday night into Saturday on the server clock
    df.loc[df.index[1], "high"] = df.loc[df.index[1], "open"] - 0.0002  # high below the open
    df = pd.concat([df, df.iloc[[2]]])  # a duplicate
    df.loc[df.index[3], "close"] = df.loc[df.index[3], "close"] * 1.03  # a 3% spike
    odd = candles("2026-09-11 23:31", 1)  # off the 5-minute grid (a partial candle)
    out, fixes = clean(pd.concat([df, odd]), now_server=pd.Timestamp("2026-09-11 23:50"))
    assert fixes["duplicates"] == 1 and fixes["off_grid"] == 1 and fixes["ohlc_fixed"] >= 1
    assert fixes["weekend"] == 6  # Saturday 00:00 to 00:25
    assert fixes["forming"] == 2  # at 23:50 the 23:50 and 23:55 candles are not finished; 23:45 closed at 23:50
    assert fixes["spikes"] >= 1
    assert (out["high"] >= out[["open", "close"]].max(axis=1)).all() and (out["low"] <= out[["open", "close"]].min(axis=1)).all()
    assert out.index.is_monotonic_increasing and out.index.dayofweek.max() < 5


def test_mt5_update_adds_new_candles_and_replaces_the_yahoo_fill():
    with tempfile.TemporaryDirectory() as tmp:
        data = export_dir(tmp)
        write_export(candles("2026-09-14 00:00", 100, spread=9), data / FILL_FILE)  # Yahoo filled Monday while the PC was off
        new = pd.concat([candles("2026-09-10 00:00", 288 * 2, price=1.17),  # Thursday and Friday again
                         candles("2026-09-14 00:00", 60, price=1.2277)])  # Monday 14 to 05:00, opening at Friday's close

        def mt5(since):
            assert since == pd.Timestamp("2026-09-11 23:55") - pd.Timedelta(days=2)  # the last two days again
            return new, pd.Timestamp("2026-09-14 05:00"), "EURUSD.r"

        result = update("mt5", data_dir=data, mt5_fetch=mt5)
        assert result["source"] == "MT5 (EURUSD.r)" and result["file"] == AUTO_FILE
        assert result["last"] == pd.Timestamp("2026-09-14 04:55")
        assert result["added"] == 60  # Monday's candles; Thursday and Friday were already there
        _, fill = read_existing(data)  # filled candles MT5 now has are gone; the 40 after its last candle stay
        assert len(fill) == 40 and fill.index.min() == pd.Timestamp("2026-09-14 05:00")
        assert "60 Yahoo candles replaced by MT5" in result["notes"]
        manifest, _ = datapipe.build(start="2026-09-01", data_dir=data, out_root=Path(tmp) / "web")
        assert manifest["bars"] == 288 * 5 + 60 + 40


def test_yahoo_fills_only_after_the_last_real_candle_with_the_brokers_spread():
    with tempfile.TemporaryDirectory() as tmp:
        data = export_dir(tmp)
        yahoo = candles("2026-09-11 20:00", 12 * 60, price=1.18)  # overlaps Friday, then the weekend, then Monday

        def no_mt5(since):
            raise RuntimeError("MT5 is not reachable")

        result = update("auto", data_dir=data, mt5_fetch=no_mt5, yahoo_fetch=lambda digits: yahoo.drop(columns=["spread"]),
                        now_utc=pd.Timestamp("2026-09-14 12:00", tz="UTC"))
        assert result["file"] == FILL_FILE and "MT5 skipped" in result["notes"][0]
        real, fill = read_existing(data)
        assert fill.index.min() > real.index.max()  # never over a real candle
        assert (fill.index.dayofweek < 5).all() and (fill["spread"] == 7).all()
        assert median_spread(real) == 7
        # The real exports win over the fill wherever both have a candle.
        assert datapipe.find_exports(data)[0].name == FILL_FILE
        with pytest.raises(RuntimeError):
            update("mt5", data_dir=data, mt5_fetch=no_mt5)


def test_the_mt5_daily_file_wins_over_other_exports():
    with tempfile.TemporaryDirectory() as tmp:
        data = Path(tmp)
        for name in (AUTO_FILE, "EURUSD_M5_mt5_2026-09.csv", FILL_FILE, "EURUSD_M5.csv"):
            write_export(candles("2026-09-07 00:00", 2), data / name)
        order = [p.name for p in datapipe.find_exports(data)]
        assert order[0] == FILL_FILE and order[-1] == AUTO_FILE


def test_run_update_does_one_click_and_never_raises():
    from forex_replay.updater import run_update
    with tempfile.TemporaryDirectory() as tmp:
        data = export_dir(tmp)
        monday = candles("2026-09-14 00:00", 24, price=1.2277)
        fake = lambda source, data_dir: update(source, data_dir=data_dir, mt5_fetch=lambda since: (monday, pd.Timestamp("2026-09-14 02:00"), "EURUSD"))
        pushed = []
        result = run_update("mt5", push_to_github=True, data_dir=data, out_root=Path(tmp) / "web", updater=fake,
                            pusher=lambda d, message: pushed.append(message) or "pushed to GitHub")
        assert result["ok"] and result["added"] == 24 and result["last"] == "2026-09-14T01:55:00"
        assert "pushed to GitHub" in result["text"] and pushed[0].startswith("Data: EURUSD M5 to 14 Sep 2026 01:55")

        def broken(source, data_dir):
            raise RuntimeError("MT5 is not reachable (Authorization failed)")
        failed = run_update("mt5", data_dir=data, updater=broken)
        assert not failed["ok"] and "Authorization failed" in failed["text"]


def test_the_update_button_route_takes_json_only_and_one_at_a_time(monkeypatch):
    import json
    import threading
    import urllib.error
    import urllib.request
    from forex_replay import server, updater
    from forex_replay.server import make_server

    calls = []
    monkeypatch.setattr(updater, "run_update", lambda push_to_github=False: calls.append(push_to_github) or {"ok": True, "added": 3, "last": None, "text": "done"})
    with tempfile.TemporaryDirectory() as tmp:
        srv = make_server(port=18815, root=Path(tmp), journals_root=Path(tmp) / "strategies")
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{srv.server_address[1]}/api/update"
        post = lambda ctype: urllib.request.urlopen(urllib.request.Request(url, data=json.dumps({"push": True}).encode(), method="POST", headers={"Content-Type": ctype}))
        try:
            with post("application/json") as r:
                assert json.loads(r.read())["added"] == 3 and calls == [True]
            with pytest.raises(urllib.error.HTTPError) as refused:  # a form on another site cannot start one
                post("text/plain")
            assert refused.value.code == 400
            server._update_lock.acquire()
            try:
                with pytest.raises(urllib.error.HTTPError) as busy:
                    post("application/json")
                assert busy.value.code == 409
            finally:
                server._update_lock.release()
        finally:
            srv.shutdown()
            srv.server_close()
