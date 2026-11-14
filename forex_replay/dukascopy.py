"""EURUSD M1 bid candles from Dukascopy's public datafeed, used only to fill hours HistData.com is missing.

One LZMA file per UTC day (datafeed.dukascopy.com/datafeed/EURUSD/<year>/<month-1>/<day>/BID_candles_min_1.bi5),
24-byte records: seconds into the day, open, close, low, high (in 1e-5 points), volume. The server
answers many requests with 503 or a timeout, so each file is asked for again with a growing pause.
Prices are within about 0.3 pip of the broker's (compared over March 2025).
"""
from __future__ import annotations

import lzma
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

from .datapipe import utc_to_server

URL = "https://datafeed.dukascopy.com/datafeed/{pair}/{y}/{m:02d}/{d:02d}/BID_candles_min_1.bi5"
AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ForexReplay backfill"
RECORD = np.dtype(">i4,>i4,>i4,>i4,>i4,>f4")


def download_day(pair: str, day: pd.Timestamp, tries: int = 8, opener=None) -> bytes:
    url = URL.format(pair=pair.upper(), y=day.year, m=day.month - 1, d=day.day)
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": AGENT})
            return (opener or urllib.request.urlopen)(req, timeout=30).read()
        except OSError as err:
            last = err
            time.sleep(1 + 2 * attempt)
    raise RuntimeError(f"Dukascopy {pair} {day:%d %b %Y}: {last}")


def read_day(data: bytes, day: pd.Timestamp, points: float = 1e5, digits: int = 5) -> pd.DataFrame:
    """M1 bid candles of one UTC day, on the broker's server clock (minutes without trades dropped)."""
    if not data:
        return pd.DataFrame(columns=["open", "high", "low", "close"])
    a = np.frombuffer(lzma.decompress(data), dtype=RECORD)
    a = a[a["f5"] > 0]
    utc = pd.DatetimeIndex(pd.to_datetime(int(day.value // 10**9) + a["f0"].astype(np.int64), unit="s", utc=True))
    df = pd.DataFrame({"open": a["f1"], "high": a["f4"], "low": a["f3"], "close": a["f2"]}, index=utc).astype(float) / points
    df.index = pd.DatetimeIndex(utc_to_server(utc), name="server_time")
    return df.round(digits)


def fetch_days(pair: str, days, workers: int = 3, downloader=download_day) -> pd.DataFrame:
    """M1 candles for the given UTC days (a day that cannot be had is skipped)."""
    days = sorted({pd.Timestamp(d).normalize() for d in days})

    def one(day):
        try:
            return read_day(downloader(pair, day), day)
        except (RuntimeError, lzma.LZMAError):
            return None

    with ThreadPoolExecutor(workers) as pool:
        parts = [p for p in pool.map(one, days) if p is not None and not p.empty]
    return pd.concat(parts).sort_index() if parts else pd.DataFrame(columns=["open", "high", "low", "close"])
