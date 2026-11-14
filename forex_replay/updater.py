"""Market data update on request: new EURUSD M5 candles, checked, then kept with the other exports.

Nothing runs by itself: the "Update data" button in the app (POST /api/update) or this command does it.

    python -m forex_replay update                  MT5 if it can be reached, otherwise Yahoo
    python -m forex_replay update --source mt5     only the MT5 terminal on this computer
    python -m forex_replay update --source yahoo   only Yahoo Finance (what the nightly cloud job uses)
    python -m forex_replay backfill --from 2023-01-01   older candles from HistData.com, before the first one in data/
    ... --source mt5                               the same from the MT5 terminal instead
    ... --push                                     then commit the data files and push them to GitHub

MT5 hands out only as many candles per symbol and timeframe as its "Max bars in chart" setting
(Tools > Options > Charts); at the usual 100,000 that is about 15 months of M5. For older years set it
to Unlimited and restart MetaTrader 5.

Two sources, never mixed up:

* MT5 (the broker's own candles, read with MetaQuotes' MetaTrader5 package from the terminal on
  this computer) go to data/EURUSD_M5_mt5_auto.csv. They are the real thing: same prices,
  spreads and server clock as the other MT5 exports, and they win over every other file.
* Yahoo Finance (free, no account) only fills candles newer than the last MT5 candle, for days
  the computer was off. They go to data/EURUSD_M5_yahoo_fill.csv, which loses to every other
  file, so the next MT5 update replaces them. Yahoo has no volume or spread: the spread is set to
  the broker's median of the last 20 days and the volume to 0.

Before anything is kept it is checked ("auto-correct"): candles are sorted, duplicates dropped,
weekend candles dropped, high and low widened to hold the open and close, the candle still
forming dropped, and spikes (a lone wick over 15 times the median range with the price back
where it was, or a gap of over 1% from the previous close) dropped. Each fix is counted and printed.
"""
from __future__ import annotations

import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from .datapipe import DATA_DIR, EURUSD, SymbolSpec, find_exports, read_mt5_csv, utc_to_server

AUTO_FILE = "EURUSD_M5_mt5_auto.csv"  # wins over every other export
HISTORY_FILE = "EURUSD_M5_mt5_history.csv"  # older candles fetched with `backfill`, an ordinary export
HISTDATA_FILE = "EURUSD_M5_histdata.csv"  # older candles from HistData.com, loses to every broker export
FILL_FILE = "EURUSD_M5_yahoo_fill.csv"  # loses to every other export
HEADER = ["<DATE>", "<TIME>", "<OPEN>", "<HIGH>", "<LOW>", "<CLOSE>", "<TICKVOL>", "<VOL>", "<SPREAD>"]
OVERLAP = timedelta(days=2)  # read again the last two days, so a day cut short last time is completed
SPIKE_RANGE = 15  # a candle this many times the median range is a bad tick
SPIKE_GAP = 0.01  # or one opening 1% away from the previous close


# ----------------------------------------------------------------- checking ("auto-correct")
def clean(df: pd.DataFrame, bar_seconds: int = 300, now_server: pd.Timestamp | None = None) -> tuple[pd.DataFrame, dict]:
    """Candles on the server clock, made safe to keep. Returns (candles, what was fixed)."""
    fixes = {"duplicates": 0, "weekend": 0, "off_grid": 0, "forming": 0, "missing_prices": 0, "ohlc_fixed": 0, "spikes": 0}
    if df.empty:
        return df, fixes
    df = df.sort_index()
    dup = df.index.duplicated(keep="last")
    fixes["duplicates"] = int(dup.sum())
    df = df[~dup]
    missing = df[["open", "high", "low", "close"]].isna().any(axis=1)
    fixes["missing_prices"] = int(missing.sum())
    df = df[~missing]
    seconds = (df.index - pd.Timestamp("1970-01-01")) // pd.Timedelta(seconds=1)
    off_grid = np.asarray(seconds) % bar_seconds != 0  # a candle not on the 5-minute grid is a partial one
    fixes["off_grid"] = int(off_grid.sum())
    df = df[~off_grid]
    weekend = df.index.dayofweek >= 5  # Saturday and Sunday on the server clock: the market is shut
    fixes["weekend"] = int(weekend.sum())
    df = df[~weekend]
    if now_server is not None:  # the candle still forming is not a candle yet
        forming = df.index + pd.Timedelta(seconds=bar_seconds) > now_server
        fixes["forming"] = int(forming.sum())
        df = df[~forming]
    if df.empty:
        return df, fixes
    df = df.copy()
    hi = df[["open", "high", "low", "close"]].max(axis=1)
    lo = df[["open", "high", "low", "close"]].min(axis=1)
    bad = (hi != df["high"]) | (lo != df["low"])
    fixes["ohlc_fixed"] = int(bad.sum())
    df["high"], df["low"] = hi, lo
    rng = df["high"] - df["low"]
    median = rng.rolling(48, min_periods=12, center=True).median().fillna(rng.median())
    prev_close = df["close"].shift(1)
    gap = (df["open"] - prev_close).abs() / prev_close
    gap[pd.Series(df.index, index=df.index).diff() > pd.Timedelta(hours=12)] = 0  # a Monday open may really gap
    # A bad tick is a lone wick: a huge range with the price back where it was by the close or the next
    # open. A news candle (CPI, NFP) is just as big but moves the price, so it stays. The median is at
    # least a pip, so the tiny ranges of a holiday morning do not make ordinary candles look huge.
    before = prev_close.fillna(df["open"])
    after = df["open"].shift(-1).fillna(df["close"])
    back = np.minimum((df["close"] - before).abs(), (after - before).abs()) < rng / 4
    huge = rng > SPIKE_RANGE * median.clip(lower=1e-4)
    spike = (huge & (back | (rng / df["low"] > SPIKE_GAP))) | (gap > SPIKE_GAP)  # over 1% in five minutes is not news
    fixes["spikes"] = int(spike.sum())
    return df[~spike], fixes


# ----------------------------------------------------------------- the two sources
def fetch_mt5(since_server: pd.Timestamp, symbol: str = "EURUSD") -> tuple[pd.DataFrame, pd.Timestamp, str]:
    """M5 candles from the MT5 terminal on this computer, from `since_server` (server clock) to now.
    Returns (candles on the server clock, the server's time now, the broker's symbol name)."""
    try:
        import MetaTrader5 as mt5
    except ImportError as err:
        raise RuntimeError("the MetaTrader5 package is not installed (pip install MetaTrader5)") from err
    if not mt5.initialize():
        code, text = mt5.last_error()
        raise RuntimeError(f"MT5 is not reachable ({text}). Open MetaTrader 5 and log in, with 'Save password' ticked.")
    try:
        names = [s.name for s in (mt5.symbols_get(f"{symbol}*") or [])]
        name = symbol if symbol in names else next((n for n in names if n.upper().startswith(symbol)), None)
        if not name or not mt5.symbol_select(name, True):
            raise RuntimeError(f"this broker has no {symbol} symbol (found: {', '.join(names[:5]) or 'none'})")
        tick = mt5.symbol_info_tick(name)
        now_server = pd.Timestamp(tick.time, unit="s") if tick else None  # MT5 gives server-clock seconds
        end = (now_server or pd.Timestamp.utcnow().tz_localize(None)) + pd.Timedelta(days=1)
        rates = mt5.copy_rates_range(name, mt5.TIMEFRAME_M5, since_server.to_pydatetime(), end.to_pydatetime())
        if rates is None:
            raise RuntimeError(f"MT5 gave no candles ({mt5.last_error()[1]})")
    finally:
        mt5.shutdown()
    df = pd.DataFrame(rates)
    if df.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume", "spread"]), now_server, name
    df.index = pd.DatetimeIndex(pd.to_datetime(df["time"], unit="s"), name="server_time")
    df = df.rename(columns={"tick_volume": "volume"})[["open", "high", "low", "close", "volume", "spread"]]
    return df, now_server, name


def fetch_yahoo(digits: int = 5, days: int = 30, opener=None) -> pd.DataFrame:
    """EURUSD M5 candles from Yahoo Finance for the last `days` (at most 60), on the server clock, volume 0."""
    import json
    import urllib.request

    url = f"https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?interval=5m&range={min(days, 60)}d"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (ForexReplay data update)"})
    with (opener or urllib.request.urlopen)(request, timeout=30) as response:
        result = json.loads(response.read())["chart"]["result"][0]
    quote = result["indicators"]["quote"][0]
    utc = pd.DatetimeIndex(pd.to_datetime(result["timestamp"], unit="s", utc=True))
    df = pd.DataFrame({k: quote[k] for k in ("open", "high", "low", "close")}, index=utc).astype(float).round(digits)
    df["volume"] = 0
    df.index = pd.DatetimeIndex(utc_to_server(df.index), name="server_time")
    return df


# ----------------------------------------------------------------- the files
def read_existing(data_dir: Path, spec: SymbolSpec = EURUSD) -> tuple[pd.DataFrame | None, pd.DataFrame | None]:
    """(every export except the Yahoo fill, merged; the Yahoo fill), each on the server clock or None."""
    files = find_exports(data_dir, spec.symbol, spec.timeframe)
    real = [read_mt5_csv(f) for f in files if f.name != FILL_FILE]
    fill = [read_mt5_csv(f) for f in files if f.name == FILL_FILE]
    merged = pd.concat(real).sort_index() if real else None
    if merged is not None:
        merged = merged[~merged.index.duplicated(keep="last")]
    return merged, (fill[0] if fill else None)


def write_export(df: pd.DataFrame, path: Path, keep: pd.DataFrame | None = None) -> int:
    """Write candles in MT5's Export Bars format. Rows already in `keep` stay unless replaced. Returns rows written."""
    if keep is not None and not keep.empty:
        df = pd.concat([keep[["open", "high", "low", "close", "volume", "spread"]], df])
        df = df[~df.index.duplicated(keep="last")]
    df = df.sort_index()
    out = pd.DataFrame({
        "<DATE>": df.index.strftime("%Y.%m.%d"), "<TIME>": df.index.strftime("%H:%M:%S"),
        "<OPEN>": df["open"].map(lambda v: f"{v:.5f}"), "<HIGH>": df["high"].map(lambda v: f"{v:.5f}"),
        "<LOW>": df["low"].map(lambda v: f"{v:.5f}"), "<CLOSE>": df["close"].map(lambda v: f"{v:.5f}"),
        "<TICKVOL>": df["volume"].astype(int), "<VOL>": 0, "<SPREAD>": df["spread"].astype(int),
    })
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    out.to_csv(tmp, sep="\t", index=False, lineterminator="\n")
    tmp.replace(path)
    return len(out)


def median_spread(df: pd.DataFrame | None, days: int = 20) -> int:
    """The broker's typical spread in points over the last `days` of real candles (for Yahoo, which has none)."""
    if df is None or df.empty or "spread" not in df:
        return 0
    recent = df[df.index >= df.index.max() - pd.Timedelta(days=days)]["spread"]
    recent = recent[recent > 0]
    return int(np.median(recent)) if len(recent) else 0


# ----------------------------------------------------------------- one update
def update(source: str = "auto", data_dir: Path = DATA_DIR, spec: SymbolSpec = EURUSD,
           mt5_fetch=fetch_mt5, yahoo_fetch=fetch_yahoo, now_utc: datetime | None = None) -> dict:
    """Add the new candles. Returns what happened: {source, added, last, fixes, file, notes}."""
    real, fill = read_existing(data_dir, spec)
    last_real = real.index.max() if real is not None and not real.empty else None
    notes = []
    if source in ("auto", "mt5"):
        try:
            since = (last_real - OVERLAP) if last_real is not None else pd.Timestamp("2025-08-01")
            df, now_server, name = mt5_fetch(since)
            df, fixes = clean(df, spec.bar_seconds, now_server)
            path = data_dir / AUTO_FILE
            before = read_mt5_csv(path) if path.exists() else None
            new = df.index.difference(real.index) if real is not None else df.index
            write_export(df, path, keep=before)
            if fill is not None:  # the fill is no longer needed where MT5 now has candles
                pruned = fill[fill.index > df.index.max()] if not df.empty else fill
                if len(pruned) != len(fill):
                    if pruned.empty:
                        (data_dir / FILL_FILE).unlink()
                    else:
                        write_export(pruned.drop(columns=["source"]), data_dir / FILL_FILE)
                    notes.append(f"{len(fill) - len(pruned)} Yahoo candles replaced by MT5")
            return {"source": f"MT5 ({name})", "added": int(len(new)), "last": df.index.max() if not df.empty else last_real,
                    "fixes": fixes, "file": AUTO_FILE, "notes": notes}
        except RuntimeError as err:
            if source == "mt5":
                raise
            notes.append(f"MT5 skipped: {err}")
    # Yahoo: only the candles after the last real one
    df = yahoo_fetch(spec.digits)
    now = pd.Timestamp(now_utc or datetime.now(timezone.utc))
    now_server = utc_to_server(pd.DatetimeIndex([now if now.tzinfo else now.tz_localize("UTC")]))[0]
    df, fixes = clean(df, spec.bar_seconds, now_server)
    if last_real is not None:
        df = df[df.index > last_real]
    df["spread"] = median_spread(real)
    keep = fill.drop(columns=["source"]) if fill is not None else None
    if keep is not None and last_real is not None:
        keep = keep[keep.index > last_real]
    had = set(keep.index) if keep is not None else set()
    added = int(sum(1 for t in df.index if t not in had))
    if not df.empty or (fill is not None and keep is not None and len(keep) != len(fill)):
        write_export(df, data_dir / FILL_FILE, keep=keep)
    return {"source": "Yahoo Finance (fill)", "added": added, "last": df.index.max() if not df.empty else (keep.index.max() if keep is not None and not keep.empty else last_real),
            "fixes": fixes, "file": FILL_FILE, "notes": notes}


def fetch_mt5_history(start_server: pd.Timestamp, end_server: pd.Timestamp, symbol: str = "EURUSD",
                      chunk: pd.Timedelta = pd.Timedelta(days=60), tries: int = 3, sleep=None) -> tuple[pd.DataFrame, str]:
    """Older M5 candles from the MT5 terminal, [start, end) on the server clock, fetched in chunks. The terminal
    downloads old history from the broker when asked, so a chunk that comes back empty is asked for again."""
    import time

    try:
        import MetaTrader5 as mt5
    except ImportError as err:
        raise RuntimeError("the MetaTrader5 package is not installed (pip install MetaTrader5)") from err
    if not mt5.initialize():
        raise RuntimeError(f"MT5 is not reachable ({mt5.last_error()[1]}). Open MetaTrader 5 and log in.")
    parts = []
    try:
        names = [s.name for s in (mt5.symbols_get(f"{symbol}*") or [])]
        name = symbol if symbol in names else next((n for n in names if n.upper().startswith(symbol)), None)
        if not name or not mt5.symbol_select(name, True):
            raise RuntimeError(f"this broker has no {symbol} symbol")
        a = start_server
        while a < end_server:
            b = min(a + chunk, end_server)
            rates = None
            for _ in range(tries):
                rates = mt5.copy_rates_range(name, mt5.TIMEFRAME_M5, a.to_pydatetime(), b.to_pydatetime())
                # outside the history it holds, MT5 answers with its oldest candle: that is not this chunk
                if rates is not None and len(rates) and a <= pd.Timestamp(int(rates[-1]["time"]), unit="s") < b:
                    break
                (sleep or time.sleep)(2)
            if rates is not None and len(rates):
                df = pd.DataFrame(rates)
                df.index = pd.DatetimeIndex(pd.to_datetime(df["time"], unit="s"), name="server_time")
                parts.append(df.rename(columns={"tick_volume": "volume"})[["open", "high", "low", "close", "volume", "spread"]])
            a = b
    finally:
        mt5.shutdown()
    if not parts:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume", "spread"]), name
    df = pd.concat(parts)
    df = df[(df.index >= start_server) & (df.index < end_server)]
    return df[~df.index.duplicated(keep="last")].sort_index(), name


def first_spread(df: pd.DataFrame | None, days: int = 20) -> int:
    """The broker's typical spread in points over the first `days` of real candles."""
    if df is None or df.empty or "spread" not in df:
        return 0
    early = df[df.index <= df.index.min() + pd.Timedelta(days=days)]["spread"].fillna(0)
    return int(np.median(early)) if len(early) else 0


def backfill(start: str, data_dir: Path = DATA_DIR, spec: SymbolSpec = EURUSD, history_fetch=None, source: str = "histdata") -> dict:
    """Add older candles (HistData.com, or the MT5 terminal) from `start` up to the first candle already in data/.
    Returns {source, added, first, until, fixes, file, notes}."""
    if source not in ("histdata", "mt5"):
        raise RuntimeError(f"unknown source {source!r}: use histdata or mt5")
    real, _ = read_existing(data_dir, spec)
    if real is None or real.empty:
        raise RuntimeError("there are no candles in data/ yet: run an update first")
    first = real.index.min()
    start_ts = pd.Timestamp(start)
    file = HISTDATA_FILE if source == "histdata" else HISTORY_FILE
    label = "HistData.com" if source == "histdata" else "MT5 history"
    if start_ts >= first:
        return {"source": label, "added": 0, "first": first, "until": first, "fixes": {}, "file": file,
                "notes": [f"data/ already starts on {first:%d %b %Y}."]}
    if source == "histdata":
        from .histdata import fetch_histdata

        spread = first_spread(real)
        df, name = (history_fetch or (lambda a, b: fetch_histdata(a, b, spec.symbol, spread=spread)))(start_ts, first)
    else:
        df, name = (history_fetch or fetch_mt5_history)(start_ts, first)
    df, fixes = clean(df, spec.bar_seconds)
    df = df[df.index < first]
    notes = []
    if df.empty and source == "histdata":
        notes.append("HistData.com gave no older candles.")
    elif df.empty:
        notes.append("MT5 gave no older candles. If 'Max bars in chart' (Tools > Options > Charts) is 100000, "
                     "set it to Unlimited, restart MetaTrader 5 and try again.")
    elif df.index.min() - start_ts > pd.Timedelta(days=7):
        notes.append(f"{label} only had candles from {df.index.min():%d %b %Y}"
                     + ("." if source == "histdata" else ": the broker's history (or the 'Max bars in chart' setting) stops there."))
    path = data_dir / file
    before = read_mt5_csv(path) if path.exists() else None
    if not df.empty:
        write_export(df, path, keep=before)
    return {"source": name if source == "histdata" else f"MT5 history ({name})", "added": int(len(df)),
            "first": df.index.min() if not df.empty else first, "until": first, "fixes": fixes, "file": file, "notes": notes}


def run_backfill(start: str, push_to_github: bool = False, data_dir: Path = DATA_DIR, out_root: Path | None = None,
                 filler=None, pusher=None, source: str = "histdata") -> dict:
    """Older candles, then the web data rebuilt and optionally pushed, as run_update does. Never raises."""
    from .datapipe import WEB_DATA_DIR, build, summary

    try:
        result = filler(start, data_dir=data_dir) if filler else backfill(start, data_dir=data_dir, source=source)
    except RuntimeError as err:
        return {"ok": False, "added": 0, "text": f"Not backfilled: {err}"}
    fixes = ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in result["fixes"].items() if v) or "none needed"
    lines = [f"{result['source']}: {result['added']} older candles, from {result['first']:%a %d %b %Y %H:%M} "
             f"to {result['until']:%d %b %Y} server time.", f"Checks and fixes: {fixes}.", *result["notes"]]
    try:
        manifest, report = build(data_dir=data_dir, out_root=out_root or WEB_DATA_DIR)
        lines.append(summary(manifest, report))
    except (ValueError, FileNotFoundError) as err:
        return {"ok": False, "added": result["added"], "text": "\n".join(lines + [f"The data was not rebuilt: {err}"])}
    if push_to_github and result["added"]:
        lines.append((pusher or push)(data_dir, f"Data: EURUSD M5 history from {result['first']:%d %b %Y} ({result['source']})"))
    return {"ok": True, "added": result["added"], "text": "\n".join(lines)}


def describe(result: dict) -> str:
    fixes = ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in result["fixes"].items() if v) or "none needed"
    last = result["last"].strftime("%a %d %b %Y %H:%M server time") if result["last"] is not None else "–"
    lines = [f"{result['source']}: {result['added']} new candles, up to {last}.", f"Checks and fixes: {fixes}."]
    lines += result["notes"]
    return "\n".join(lines)


def run_update(source: str = "auto", push_to_github: bool = False, data_dir: Path = DATA_DIR, out_root: Path | None = None,
               updater=None, pusher=None) -> dict:
    """Everything one click does: add the candles, rebuild the web data (checking every candle),
    and optionally push. Returns {ok, added, last, text}; `text` is what to show. Never raises."""
    from .datapipe import WEB_DATA_DIR, build, summary

    try:
        result = (updater or update)(source=source, data_dir=data_dir)
    except RuntimeError as err:
        return {"ok": False, "added": 0, "last": None, "text": f"Not updated: {err}"}
    lines = [describe(result)]
    try:
        manifest, report = build(data_dir=data_dir, out_root=out_root or WEB_DATA_DIR)
        lines.append(summary(manifest, report))
    except (ValueError, FileNotFoundError) as err:
        return {"ok": False, "added": result["added"], "last": None, "text": "\n".join(lines + [f"The data was not rebuilt: {err}"])}
    if push_to_github:
        last = result["last"].strftime("%d %b %Y %H:%M") if result["last"] is not None else "?"
        lines.append((pusher or push)(data_dir, f"Data: EURUSD M5 to {last} server time ({result['source']})"))
    last = result["last"].isoformat() if result["last"] is not None else None
    return {"ok": True, "added": result["added"], "last": last, "text": "\n".join(lines)}


# ----------------------------------------------------------------- GitHub
def push(data_dir: Path, message: str, run=subprocess.run) -> str:
    """Commit the two data files (only those) and push them. Only on the main branch, so work on
    another branch is never pushed by accident. Returns what was done."""
    root = data_dir.parent
    git = lambda *args: run(["git", *args], cwd=root, capture_output=True, text=True)
    branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    if branch != "main":
        return f"not pushed: the project is on branch '{branch}', not main (the data is updated on this computer)"
    files = [f"data/{name}" for name in (AUTO_FILE, FILL_FILE, HISTORY_FILE, HISTDATA_FILE) if (data_dir / name).exists() or git("ls-files", f"data/{name}").stdout.strip()]
    git("add", "--all", "--", *files)
    if not git("diff", "--cached", "--name-only", "--", *files).stdout.strip():
        return "nothing new to push"
    commit = git("commit", "-m", message, "--", *files)
    if commit.returncode:
        return f"not pushed: commit failed: {commit.stderr.strip() or commit.stdout.strip()}"
    pull = git("pull", "--rebase", "--autostash", "origin", "main")
    if pull.returncode:
        git("rebase", "--abort")
        return f"committed here but not pushed: could not bring in GitHub's changes ({pull.stderr.strip()[:200]})"
    pushed = git("push", "origin", "main")
    return "pushed to GitHub" if pushed.returncode == 0 else f"committed here but not pushed: {pushed.stderr.strip()[:200]}"
