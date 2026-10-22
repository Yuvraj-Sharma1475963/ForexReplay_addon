"""Data pipeline: MT5 exports -> clean UTC candles -> compact monthly files for the web app.

Steps
1. Read every MT5 export in data/ (both the "Export Bars" tab format and the
   older comma format). Later files win where candles overlap.
2. Convert broker server time to UTC. This broker's server clock is New York
   time + 7 hours all year (the week always opens Monday 00:05 server time,
   even in the weeks where US and EU daylight saving disagree), so
   UTC = (server - 7h) interpreted as America/New_York.
3. Check quality: bad OHLC, duplicates, and gaps inside the trading week.
4. Write one binary file per UTC month plus manifest.json and quality.json.

Binary format (little-endian int32, 7 fields per bar, 28 bytes):
    time (unix seconds UTC, bar open), open, high, low, close (in points,
    price * 10^digits), tick volume, spread (points)
Prices are stored as integers so that the browser compares exact values:
a stop at 1.08500 is hit by a low of 1.08500, never missed by float rounding.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from .config import PROJECT_ROOT

SERVER_OFFSET_FROM_NEW_YORK = pd.Timedelta(hours=7)
FIELDS = ["time", "open", "high", "low", "close", "volume", "spread"]
BYTES_PER_BAR = 4 * len(FIELDS)
PIPELINE_VERSION = 2  # bump when the output files change, so existing installs rebuild
WEB_DATA_DIR = PROJECT_ROOT / "web" / "data"
DATA_DIR = PROJECT_ROOT / "data"


@dataclass(frozen=True)
class SymbolSpec:
    symbol: str = "EURUSD"
    timeframe: str = "M5"
    digits: int = 5
    pip_points: int = 10  # 1 pip = 10 points for 5-digit FX quotes
    bar_seconds: int = 300


EURUSD = SymbolSpec()


# ----------------------------------------------------------------- reading
def read_mt5_csv(path: str | Path) -> pd.DataFrame:
    """Read an MT5 export. Returns server-time-indexed OHLC with volume and spread (points)."""
    path = Path(path)
    with path.open(encoding="utf-8-sig") as f:
        first = f.readline()

    if first.startswith("<DATE>"):  # MetaTrader "Export Bars" (tab separated)
        raw = pd.read_csv(path, sep="\t")
        raw.columns = [c.strip("<>").lower() for c in raw.columns]
        time = pd.to_datetime(raw["date"] + " " + raw["time"], format="%Y.%m.%d %H:%M:%S")
        df = pd.DataFrame({
            "open": raw["open"], "high": raw["high"], "low": raw["low"], "close": raw["close"],
            "volume": raw["tickvol"], "spread": raw.get("spread", 0),
        })
    elif first.lower().startswith("time,"):  # older export: time,open,high,low,close,tick_volume,...
        raw = pd.read_csv(path)
        time = pd.to_datetime(raw["time"])
        df = pd.DataFrame({
            "open": raw["open"], "high": raw["high"], "low": raw["low"], "close": raw["close"],
            "volume": raw.get("tick_volume", 0), "spread": raw.get("spread", 0),
        })
    else:
        raise ValueError(f"{path.name}: not a recognised MT5 export (header: {first.strip()[:60]})")

    df.index = pd.DatetimeIndex(time, name="server_time")
    df["source"] = path.name
    return df


def merge_exports(frames: list[pd.DataFrame]) -> tuple[pd.DataFrame, int]:
    """Combine exports; where two files have the same candle, the later file wins.
    Returns (merged, number of overlapping candles replaced)."""
    combined = pd.concat(frames)
    duplicated = combined.index.duplicated(keep="last")
    merged = combined[~duplicated].sort_index()
    return merged, int(duplicated.sum())


def server_to_utc(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    """Broker server time (New York + 7h) -> UTC, handling US daylight saving exactly.
    The New York clock change happens at 02:00 on a Sunday, when the market is shut,
    so no candle is ever ambiguous; 'raise' makes sure of that."""
    ny = (index - SERVER_OFFSET_FROM_NEW_YORK).tz_localize(
        "America/New_York", ambiguous="raise", nonexistent="raise")
    return ny.tz_convert("UTC")


# ----------------------------------------------------------------- quality
def quality_report(df: pd.DataFrame, spec: SymbolSpec, replaced: int) -> dict:
    """Checks run on UTC-indexed candles (with the original server times kept for gap rules)."""
    o, h, l, c = (df[k] for k in ("open", "high", "low", "close"))
    bad = (h < np.maximum(o, c)) | (l > np.minimum(o, c)) | (h < l) | (df[["open", "high", "low", "close"]] <= 0).any(axis=1)

    # Gaps: time between consecutive candles beyond one bar. Weekend closes (Fri -> Sun/Mon)
    # and holiday closes are normal; short gaps inside the week are missing candles.
    t = df.index
    step = pd.Series(t[1:] - t[:-1], index=t[1:])
    gaps = step[step > pd.Timedelta(seconds=spec.bar_seconds)]
    minutes = gaps.dt.total_seconds() / 60
    weekend = minutes >= 36 * 60
    closure = (minutes >= 6 * 60) & ~weekend
    short = ~(weekend | closure)
    missing_bars = int(((minutes[short] / (spec.bar_seconds / 60)) - 1).round().sum())

    largest = minutes[short].sort_values(ascending=False).head(10)
    return {
        "bars": int(len(df)),
        "first_utc": t[0].isoformat(),
        "last_utc": t[-1].isoformat(),
        "sources": sorted(df["source"].unique().tolist()),
        "overlapping_candles_replaced": replaced,
        "bad_ohlc_candles": int(bad.sum()),
        "weekend_closes": int(weekend.sum()),
        "holiday_closes": [ts.isoformat() for ts in gaps[closure].index],
        "short_gaps": int(short.sum()),
        "missing_bars_in_short_gaps": missing_bars,
        "largest_short_gaps": [
            {"resumes_utc": ts.isoformat(), "minutes": int(m)} for ts, m in largest.items()
        ],
        "spread_points": {
            "median": float(df["spread"].median()),
            "p95": float(df["spread"].quantile(0.95)),
            "max": int(df["spread"].max()),
        },
    }


# ----------------------------------------------------------------- writing
def to_rows(df: pd.DataFrame, spec: SymbolSpec) -> np.ndarray:
    """(n, 7) int32 array in FIELDS order."""
    scale = 10 ** spec.digits
    utc_seconds = (df.index.tz_convert("UTC").as_unit("s").asi8).astype(np.int64)
    rows = np.column_stack([
        utc_seconds,
        np.rint(df["open"].to_numpy() * scale),
        np.rint(df["high"].to_numpy() * scale),
        np.rint(df["low"].to_numpy() * scale),
        np.rint(df["close"].to_numpy() * scale),
        df["volume"].to_numpy(),
        df["spread"].to_numpy(),
    ]).astype(np.int64)
    if rows.min() < np.iinfo(np.int32).min or rows.max() > np.iinfo(np.int32).max:
        raise ValueError("Value outside int32 range")
    return rows.astype("<i4")


def from_bytes(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype="<i4").reshape(-1, len(FIELDS))


def write_dataset(df: pd.DataFrame, spec: SymbolSpec, out_root: Path, report: dict) -> dict:
    out_dir = out_root / spec.symbol / spec.timeframe
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.bin"):
        old.unlink()

    months = []
    utc = df.index.tz_convert("UTC")
    for period, part in df.groupby(utc.strftime("%Y-%m")):
        rows = to_rows(part, spec)
        name = f"{period}.bin"
        (out_dir / name).write_bytes(rows.tobytes())
        months.append({
            "month": period,
            "file": f"{spec.symbol}/{spec.timeframe}/{name}",
            "bars": int(len(rows)),
            "first": int(rows[0, 0]),
            "last": int(rows[-1, 0]),
        })

    manifest = {
        "version": PIPELINE_VERSION,
        "symbol": spec.symbol,
        "timeframe": spec.timeframe,
        "bar_seconds": spec.bar_seconds,
        "digits": spec.digits,
        "pip_points": spec.pip_points,
        "price_source": "bid",
        "clock": "UTC (converted from broker server time = New York + 7h)",
        "format": {"fields": FIELDS, "type": "int32", "endian": "little", "bytes_per_bar": BYTES_PER_BAR},
        "bars": int(len(df)),
        "first": months[0]["first"],
        "last": months[-1]["last"],
        "months": months,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (out_root / spec.symbol / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (out_root / spec.symbol / "quality.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    reference = {"fields": ["time", "open", "high", "low", "close", "volume"], **reference_candles(df, spec)}
    (out_root / spec.symbol / "reference.json").write_text(json.dumps(reference), encoding="utf-8")
    return manifest


# ----------------------------------------------------------------- reference candles
REFERENCE_TIMEFRAMES = {"H4": "4h", "D1": "1D"}


def utc_to_server(index: pd.DatetimeIndex) -> pd.DatetimeIndex:
    """UTC -> naive broker server time (New York + 7h)."""
    return index.tz_convert("America/New_York").tz_localize(None) + SERVER_OFFSET_FROM_NEW_YORK


def reference_candles(df: pd.DataFrame, spec: SymbolSpec) -> dict:
    """H4 and D1 candles computed with pandas, bucketed on the broker server clock.
    The browser builds the same candles in JavaScript; a test compares the two,
    so the two implementations cannot silently disagree."""
    scale = 10 ** spec.digits
    server = utc_to_server(df.index)
    out = {}
    for name, freq in REFERENCE_TIMEFRAMES.items():
        bucket = server.floor(freq)
        grouped = df.groupby(bucket)
        table = pd.DataFrame({
            "open": grouped["open"].first(), "high": grouped["high"].max(),
            "low": grouped["low"].min(), "close": grouped["close"].last(),
            "volume": grouped["volume"].sum(),
        })
        starts = server_to_utc(pd.DatetimeIndex(table.index)).as_unit("s").asi8
        prices = np.rint(table[["open", "high", "low", "close"]].to_numpy() * scale).astype(int)
        out[name] = [[int(t), *map(int, row), int(v)]
                     for t, row, v in zip(starts, prices, table["volume"].to_numpy())]
    return out


# ----------------------------------------------------------------- entry point
def find_exports(data_dir: Path = DATA_DIR, symbol: str = "EURUSD", timeframe: str = "M5") -> list[Path]:
    """Exports for a symbol/timeframe, in the order they are merged: later files win overlaps.

    The daily update's files have a fixed place (updater.py): the Yahoo fill first, so every real
    export beats it, and the MT5 daily file last, so the broker's newest candles win. The exports
    in between go oldest file first, as before.
    """
    files = [p for p in data_dir.glob(f"{symbol}_{timeframe}*.csv")]
    rank = lambda p: 0 if p.stem.endswith("_fill") else 2 if p.stem.endswith("_mt5_auto") else 1
    return sorted(files, key=lambda p: (rank(p), p.stat().st_mtime))


def build(start: str = "2025-08-01", spec: SymbolSpec = EURUSD, data_dir: Path = DATA_DIR,
          out_root: Path = WEB_DATA_DIR, files: list[Path] | None = None) -> tuple[dict, dict]:
    files = files if files is not None else find_exports(data_dir, spec.symbol, spec.timeframe)
    if not files:
        raise FileNotFoundError(f"No {spec.symbol}_{spec.timeframe}*.csv exports in {data_dir}")

    merged, replaced = merge_exports([read_mt5_csv(f) for f in files])
    merged.index = server_to_utc(merged.index)
    merged = merged[merged.index >= pd.Timestamp(start, tz="UTC")]
    if merged.empty:
        raise ValueError(f"No candles on or after {start}")

    report = quality_report(merged, spec, replaced)
    if report["bad_ohlc_candles"]:
        raise ValueError(f"{report['bad_ohlc_candles']} candles have impossible OHLC values; fix the export")
    manifest = write_dataset(merged, spec, out_root, report)
    return manifest, report


def is_stale(spec: SymbolSpec = EURUSD, data_dir: Path = DATA_DIR, out_root: Path = WEB_DATA_DIR) -> bool:
    """True when the web data is missing or older than any export."""
    manifest = out_root / spec.symbol / "manifest.json"
    exports = find_exports(data_dir, spec.symbol, spec.timeframe)
    if not manifest.exists():
        return True
    if json.loads(manifest.read_text(encoding="utf-8")).get("version") != PIPELINE_VERSION:
        return True
    return any(f.stat().st_mtime > manifest.stat().st_mtime for f in exports)


def summary(manifest: dict, report: dict) -> str:
    fmt = lambda s: datetime.fromtimestamp(s, timezone.utc).strftime("%d %b %Y %H:%M UTC")
    return (f"{manifest['symbol']} {manifest['timeframe']}: {manifest['bars']:,} candles, "
            f"{fmt(manifest['first'])} to {fmt(manifest['last'])}, {len(manifest['months'])} monthly files\n"
            f"Quality: {report['bad_ohlc_candles']} bad candles, {report['short_gaps']} short gaps "
            f"({report['missing_bars_in_short_gaps']} missing candles), "
            f"{len(report['holiday_closes'])} holiday closes, "
            f"{report['overlapping_candles_replaced']:,} overlapping candles merged")
