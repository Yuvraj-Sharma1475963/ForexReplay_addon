"""Older EURUSD candles from HistData.com (free M1 bars, one zip per year), for `backfill --source histdata`.

HistData's clock is New York standard time (UTC-5) moved with European daylight saving: compared
with the broker's own candles over 2025 it lines up exactly once read that way (UTC = stamp + 5h,
taken as London time), and its prices then sit within 0.2-0.3 pip of the broker's (its closes
about 2 points lower). It has no volume and no spread: volume is 0 and the spread the broker's
usual one, as for the Yahoo fill. The file it fills, data/EURUSD_M5_histdata.csv, loses every
overlap to the broker's exports (datapipe.find_exports).
"""
from __future__ import annotations

import io
import re
import time
import urllib.parse
import urllib.request
import zipfile
from http.cookiejar import CookieJar

import pandas as pd

from .datapipe import utc_to_server

PAGE = "https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/{pair}/{period}"
GET = "https://www.histdata.com/get.php"
AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ForexReplay backfill"
FORM = re.compile(r'name="(tk|date|datemonth|platform|timeframe|fxpair)" id="\w+" value="([^"]*)"')


def download(pair: str, year: int, month: int | None = None, opener=None, tries: int = 3) -> bytes:
    """The zip HistData serves for a whole year (or one month of the current year)."""
    period = f"{year}" if month is None else f"{year}/{month}"
    page = PAGE.format(pair=pair.lower(), period=period)
    opener = opener or urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    last = None
    for attempt in range(tries):
        try:
            html = opener.open(urllib.request.Request(page, headers={"User-Agent": AGENT}), timeout=60).read().decode("utf-8", "replace")
            form = {}
            for key, value in FORM.findall(html):
                form.setdefault(key, value)  # the page holds the form twice
            if "tk" not in form:
                raise RuntimeError(f"HistData has no {pair} file for {period}")
            req = urllib.request.Request(GET, data=urllib.parse.urlencode(form).encode(), headers={"User-Agent": AGENT, "Referer": page})
            data = opener.open(req, timeout=120).read()
            if data[:2] == b"PK":
                return data
            last = RuntimeError(f"HistData sent no zip for {period}")
        except (OSError, RuntimeError) as err:
            last = err
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"could not download HistData {pair} {period}: {last}")


def read_zip(data: bytes, digits: int = 5) -> pd.DataFrame:
    """M1 bars from a HistData ASCII zip, on the broker's server clock."""
    z = zipfile.ZipFile(io.BytesIO(data))
    name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
    raw = pd.read_csv(io.BytesIO(z.read(name)), sep=";", header=None, names=["t", "open", "high", "low", "close", "v"])
    stamp = pd.DatetimeIndex(pd.to_datetime(raw["t"], format="%Y%m%d %H%M%S")) + pd.Timedelta(hours=5)
    # the London clock change is at 01:00 UTC on a Sunday, when the market is shut
    utc = stamp.tz_localize("Europe/London", ambiguous="NaT", nonexistent="NaT")
    keep = ~utc.isna()
    df = raw.loc[keep, ["open", "high", "low", "close"]].astype(float).round(digits)
    df.index = pd.DatetimeIndex(utc_to_server(utc[keep].tz_convert("UTC")), name="server_time")
    return df


def to_m5(m1: pd.DataFrame, spread: int = 0) -> pd.DataFrame:
    g = m1.resample("5min", label="left", closed="left")
    df = pd.DataFrame({"open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(), "close": g["close"].last()}).dropna()
    df["volume"] = 0
    df["spread"] = spread
    return df


def fetch_histdata(start_server: pd.Timestamp, end_server: pd.Timestamp, symbol: str = "EURUSD", spread: int = 0,
                   downloader=download, today: pd.Timestamp | None = None) -> tuple[pd.DataFrame, str]:
    """M5 candles [start, end) on the server clock: a zip per year, per month for the current year."""
    today = today or pd.Timestamp.now()
    parts = []
    for year in range(start_server.year, end_server.year + 1):
        if year < today.year:
            parts.append(read_zip(downloader(symbol, year)))
            continue
        first = start_server.month if year == start_server.year else 1
        last = end_server.month if year == end_server.year else 12
        for month in range(first, last + 1):
            try:
                parts.append(read_zip(downloader(symbol, year, month)))
            except RuntimeError:
                pass  # a month HistData has not published yet
    if not parts:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume", "spread"]), "HistData.com"
    m1 = pd.concat(parts).sort_index()
    m1 = m1[~m1.index.duplicated(keep="last")]
    df = to_m5(m1, spread)
    return df[(df.index >= start_server) & (df.index < end_server)], "HistData.com"
