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


def test_backfill_adds_older_candles_before_the_first_one_and_the_build_keeps_them():
    from forex_replay.updater import HISTORY_FILE, backfill, run_backfill
    with tempfile.TemporaryDirectory() as tmp:
        data = export_dir(tmp)  # Mon 7 to Fri 11 Sep 2026
        week_before = candles("2026-08-31 00:00", 288 * 5, price=1.15)  # Mon 31 Aug to Fri 4 Sep
        asked = []

        def history(start, end):
            asked.append((start, end))
            return pd.concat([week_before, candles("2026-09-07 00:00", 10)]), "EURUSD"  # overlap is ignored

        result = backfill("2026-08-31", data_dir=data, history_fetch=history, source="mt5")
        assert asked == [(pd.Timestamp("2026-08-31"), pd.Timestamp("2026-09-07 00:00"))]
        assert result["added"] == 288 * 5 and result["first"] == pd.Timestamp("2026-08-31 00:00") and not result["notes"]
        assert (data / HISTORY_FILE).exists()
        manifest, _ = datapipe.build(data_dir=data, out_root=Path(tmp) / "web")  # no start date: everything
        assert manifest["bars"] == 288 * 10

        nothing = backfill("2026-09-08", data_dir=data, history_fetch=history)  # already covered
        assert nothing["added"] == 0 and len(asked) == 1

        empty = run_backfill("2026-01-01", data_dir=data, out_root=Path(tmp) / "web",
                             filler=lambda start, data_dir: backfill(start, data_dir=data_dir,
                                                                     source="mt5",
                                                                     history_fetch=lambda a, b: (candles("2026-08-31", 0), "EURUSD")))
        assert empty["ok"] and empty["added"] == 0 and "Max bars in chart" in empty["text"]


def test_histdata_clock_reads_as_new_york_standard_time_with_european_daylight_saving():
    import io
    import zipfile

    from forex_replay.histdata import fetch_histdata, read_zip

    rows = ["20250303 120000;1.040000;1.040100;1.039900;1.040050;0",  # winter: 17:00 UTC, server 19:00
            "20250312 120000;1.090000;1.090100;1.089900;1.090050;0",  # US summer, Europe not yet: 17:00 UTC, server 20:00
            "20250312 120100;1.090050;1.090300;1.089800;1.090200;0",
            "20250602 120000;1.140000;1.140100;1.139900;1.140050;0"]  # both summer: 16:00 UTC, server 19:00
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("DAT_ASCII_EURUSD_M1_2025.csv", "\n".join(rows) + "\n")
    m1 = read_zip(buf.getvalue())
    assert [str(t) for t in m1.index] == ["2025-03-03 19:00:00", "2025-03-12 20:00:00", "2025-03-12 20:01:00", "2025-06-02 19:00:00"]
    df, name = fetch_histdata(pd.Timestamp("2025-03-01"), pd.Timestamp("2025-06-01"), spread=3,
                              downloader=lambda pair, year, month=None: buf.getvalue(), today=pd.Timestamp("2026-01-01"))
    assert name == "HistData.com" and list(df.index.astype(str)) == ["2025-03-03 19:00:00", "2025-03-12 20:00:00"]
    bar = df.iloc[1]
    assert (bar.open, bar.high, bar.low, bar.close, bar.volume, bar.spread) == (1.09, 1.0903, 1.0898, 1.0902, 0, 3)


def test_clean_keeps_a_news_candle_and_drops_a_lone_wick():
    df = candles("2026-09-08 10:00", 60, step=0.00001)  # a quiet morning: 1.5-point candles
    news, wick = df.index[30], df.index[45]
    df.loc[news, ["high", "low", "close"]] = [df.loc[news, "open"] + 0.0001, df.loc[news, "open"] - 0.0060, df.loc[news, "open"] - 0.0055]
    df.loc[df.index[31]:, ["open", "high", "low", "close"]] -= 0.0055  # the price stays down after the news
    df.loc[wick, "high"] = df.loc[wick, "open"] + 0.0050  # a bad tick: up and straight back
    out, fixes = clean(df)
    assert news in out.index and wick not in out.index and fixes["spikes"] == 1


def test_histdata_hours_it_lacks_are_filled_from_the_other_source_and_nothing_else():
    import io
    import zipfile

    from forex_replay.histdata import fetch_histdata

    stamps = pd.date_range("2025-06-02 03:00", "2025-06-02 08:59", freq="1min")  # stamps; server = +7h
    stamps = stamps[(stamps.hour != 5)]  # 05:00-05:59 missing (server 12:00-12:59)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("x.csv", "\n".join(f"{t:%Y%m%d %H%M%S};1.140000;1.140100;1.139900;1.140050;0" for t in stamps) + "\n")
    asked = []

    def filler(pair, days):
        asked.append(days)
        idx = pd.date_range("2025-06-02 10:00", "2025-06-02 15:59", freq="1min")  # server clock, overlaps HistData
        return pd.DataFrame({"open": 1.2, "high": 1.2, "low": 1.2, "close": 1.2}, index=idx)

    df, name = fetch_histdata(pd.Timestamp("2025-06-01"), pd.Timestamp("2025-06-03"), downloader=lambda *a, **k: buf.getvalue(),
                              today=pd.Timestamp("2026-01-01"), filler=filler)
    assert asked == [[pd.Timestamp("2025-06-02")]] and "Dukascopy for 1 missing hours" in name
    assert (df.loc["2025-06-02 12:00":"2025-06-02 12:55", "close"] == 1.2).all() and len(df.loc["2025-06-02 12:00":"2025-06-02 12:55"]) == 12
    assert (df.drop(df.loc["2025-06-02 12:00":"2025-06-02 12:55"].index)["close"] == 1.14005).all()
