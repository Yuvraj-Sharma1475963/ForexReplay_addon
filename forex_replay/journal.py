"""CSV trade journal: one row per closed trade."""

from __future__ import annotations

import csv
from pathlib import Path

import pandas as pd

from .broker import Trade
from .config import Instrument
from .datapipe import utc_to_server
from .sessions import session_of

# v1's columns. A journal written before day 10 of v2 has exactly these.
V1_COLUMNS = [
    "trade_id", "run_id", "symbol", "side", "order_type",
    "placed_time", "entry_time", "exit_time",
    "entry_price", "exit_price", "stop_loss", "take_profit",
    "risk_pips", "pnl_pips", "result_r", "planned_rr", "mfe_r", "mae_r",
    "exit_reason", "session", "weekday", "duration_min",
]
# Added for the browser app: size and money, and what the trader wrote about the trade.
# Tags and screenshots are lists joined with "; ". The v1 replay window leaves them empty.
EXTRA_COLUMNS = ["lots", "pnl_usd", "commission_usd", "note", "tags", "screenshots"]
COLUMNS = V1_COLUMNS + EXTRA_COLUMNS
NOTE_COLUMNS = ["note", "tags", "screenshots"]  # the only fields that may change after a row is written
TIME_COLUMNS = ["placed_time", "entry_time", "exit_time"]


def trade_to_row(trade: Trade, instrument: Instrument, run_id: str) -> dict:
    digits = instrument.digits

    def fmt_time(value):
        return "" if value is None else pd.Timestamp(value).strftime("%Y-%m-%d %H:%M:%S")

    def rnd(value, places):
        return "" if value is None else round(float(value), places)

    duration = None
    if trade.entry_time is not None and trade.exit_time is not None:
        duration = (trade.exit_time - trade.entry_time).total_seconds() / 60

    return {
        "trade_id": trade.id,
        "run_id": run_id,
        "symbol": instrument.symbol,
        "side": trade.side.value,
        "order_type": trade.order_type.value,
        "placed_time": fmt_time(trade.placed_time),
        "entry_time": fmt_time(trade.entry_time),
        "exit_time": fmt_time(trade.exit_time),
        "entry_price": rnd(trade.entry_price, digits),
        "exit_price": rnd(trade.exit_price, digits),
        "stop_loss": rnd(trade.stop_loss, digits),
        "take_profit": rnd(trade.take_profit, digits),
        "risk_pips": rnd(instrument.to_pips(trade.planned_risk), 1),
        "pnl_pips": rnd(None if trade.pnl is None else instrument.to_pips(trade.pnl), 1),
        "result_r": rnd(trade.result_r, 2),
        "planned_rr": rnd(trade.planned_reward_r, 2),
        "mfe_r": rnd(trade.mfe_r, 2),
        "mae_r": rnd(trade.mae_r, 2),
        "exit_reason": "" if trade.exit_reason is None else trade.exit_reason.value,
        "session": session_of(trade.entry_time) if trade.entry_time is not None else "",
        "weekday": "" if trade.entry_time is None else pd.Timestamp(trade.entry_time).day_name(),
        "duration_min": rnd(duration, 0),
        **{column: "" for column in EXTRA_COLUMNS},
    }


def note_fields(trade: dict) -> dict:
    """The note, tags and screenshots of a trade sent by the browser, as journal text."""
    def joined(value):
        return "; ".join(str(v) for v in value) if isinstance(value, list) else ""
    note = trade.get("note") if isinstance(trade.get("note"), str) else ""
    return {"note": note, "tags": joined(trade.get("tags")), "screenshots": joined(trade.get("screenshots"))}


def web_trade_to_row(trade: dict, *, symbol: str, digits: int, pip_points: int, run_id: str) -> dict:
    """The same row as trade_to_row, for a closed trade sent by the browser app.

    The browser works in whole points and UTC seconds. The journal keeps v1's
    format: prices as decimals and times on the broker server clock, so rows
    from the browser and from the v1 replay window can be read together.
    """
    scale = 10 ** digits
    times = {key: trade.get(key) for key in ("placedTime", "entryTime", "exitTime")}
    known = [t for t in times.values() if t is not None]
    server = dict(zip(
        [k for k, t in times.items() if t is not None],
        utc_to_server(pd.to_datetime(known, unit="s", utc=True)) if known else [],
    ))

    def fmt_time(key):
        return server[key].strftime("%Y-%m-%d %H:%M:%S") if key in server else ""

    def price(points):
        return "" if points is None else round(points / scale, digits)

    def rnd(value, places):
        return "" if value is None else round(float(value), places)

    entry = server.get("entryTime")
    duration = None
    if times["entryTime"] is not None and times["exitTime"] is not None:
        duration = (times["exitTime"] - times["entryTime"]) / 60
    pnl = trade.get("pnl")
    return {
        "trade_id": trade["id"],
        "run_id": run_id,
        "symbol": symbol,
        "side": trade["side"],
        "order_type": trade["orderType"],
        "placed_time": fmt_time("placedTime"),
        "entry_time": fmt_time("entryTime"),
        "exit_time": fmt_time("exitTime"),
        "entry_price": price(trade.get("entryPrice")),
        "exit_price": price(trade.get("exitPrice")),
        "stop_loss": price(trade.get("stopLoss")),
        "take_profit": price(trade.get("takeProfit")),
        "risk_pips": rnd(trade["plannedRisk"] / pip_points, 1),
        "pnl_pips": rnd(None if pnl is None else pnl / pip_points, 1),
        "result_r": rnd(trade.get("resultR"), 2),
        "planned_rr": rnd(trade.get("plannedRewardR"), 2),
        "mfe_r": rnd(trade.get("mfeR"), 2),
        "mae_r": rnd(trade.get("maeR"), 2),
        "exit_reason": trade.get("exitReason") or "",
        "session": "" if entry is None else session_of(entry),
        "weekday": "" if entry is None else entry.day_name(),
        "duration_min": rnd(duration, 0),
        "lots": rnd(trade.get("lots"), 2),
        "pnl_usd": rnd(trade.get("money"), 2),
        "commission_usd": rnd(trade.get("commission"), 2),
        **note_fields(trade),
    }


class TradeJournal:
    """Appends closed trades to a CSV file (created with a header if missing).

    Each trade is identified by (run_id, trade_id), so reloading a saved
    session and replaying forward again never logs the same trade twice.
    A journal with only the v1 columns is widened to the new ones (empty) when opened.
    """

    def __init__(self, path: str | Path, instrument: Instrument, run_id: str):
        self.path = Path(path)
        self.instrument = instrument
        self.run_id = run_id
        self._logged: set[tuple[str, str]] = set()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists() or self.path.stat().st_size == 0:
            with self.path.open("w", newline="", encoding="utf-8") as f:
                csv.DictWriter(f, fieldnames=COLUMNS).writeheader()
            return
        with self.path.open(newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            header = reader.fieldnames
            rows = list(reader)
        if header == V1_COLUMNS:
            self._rewrite([{**row, **{c: "" for c in EXTRA_COLUMNS}} for row in rows])
        elif header != COLUMNS:
            raise ValueError(
                f"{self.path} has an unexpected header. Move it aside or start a new journal.")
        self._logged = {(row["run_id"], row["trade_id"]) for row in rows}

    def _rewrite(self, rows: list[dict]) -> None:
        tmp = self.path.with_suffix(".tmp")
        with tmp.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=COLUMNS)
            writer.writeheader()
            writer.writerows(rows)
        tmp.replace(self.path)

    def update_notes(self, notes: dict[str, dict]) -> int:
        """Bring note, tags and screenshots of this run's rows up to date: {trade_id: fields}.

        Results never change once a trade is closed, but what the trader wrote about it can.
        Returns how many rows changed; the file is rewritten only if any did.
        """
        with self.path.open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        changed = 0
        for row in rows:
            fields = notes.get(row["trade_id"]) if row["run_id"] == self.run_id else None
            if fields and any(row.get(c, "") != fields[c] for c in NOTE_COLUMNS):
                row.update({c: fields[c] for c in NOTE_COLUMNS})
                changed += 1
        if changed:
            self._rewrite(rows)
        return changed

    def prune_run(self, run_id: str, keep: set[tuple[str, str]]) -> int:
        """Remove this run's rows that are not in `keep` ({(trade_id, entry_time)}): trades taken back
        with Undo. A taken-back trade's id is given to the next trade, so the entry time tells them apart."""
        with self.path.open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        kept = [row for row in rows if row["run_id"] != run_id or (str(row["trade_id"]), row["entry_time"]) in keep]
        if len(kept) != len(rows):
            self._rewrite(kept)
            self._logged = {(row["run_id"], row["trade_id"]) for row in kept}
        return len(rows) - len(kept)

    def drop_run(self, run_id: str) -> int:
        """Remove every row of one run (a backtest moved to another journal). Returns how many went."""
        with self.path.open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        keep = [row for row in rows if row["run_id"] != run_id]
        if len(keep) != len(rows):
            self._rewrite(keep)
            self._logged = {(row["run_id"], row["trade_id"]) for row in keep}
        return len(rows) - len(keep)

    def log(self, trade: Trade) -> bool:
        """Append a closed trade. Returns False if it was already in the journal."""
        return self.log_row(trade_to_row(trade, self.instrument, self.run_id))

    def log_row(self, row: dict) -> bool:
        """Append a row made by trade_to_row or web_trade_to_row, unless it is already there."""
        key = (str(row["run_id"]), str(row["trade_id"]))
        if key in self._logged:
            return False
        with self.path.open("a", newline="", encoding="utf-8") as f:
            csv.DictWriter(f, fieldnames=COLUMNS).writerow(row)
        self._logged.add(key)
        return True


def load_journal(path: str | Path) -> pd.DataFrame:
    """Read a journal CSV into a DataFrame with parsed timestamps, in logged order."""
    df = pd.read_csv(path)
    for col in TIME_COLUMNS:
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], errors="coerce")
    return df


def trades_to_frame(trades: list[Trade], instrument: Instrument, run_id: str = "") -> pd.DataFrame:
    """Same shape as a loaded journal, built from in-memory closed trades."""
    rows = [trade_to_row(t, instrument, run_id) for t in trades]
    df = pd.DataFrame(rows, columns=COLUMNS)
    for col in TIME_COLUMNS:
        df[col] = pd.to_datetime(df[col], errors="coerce")
    numeric = ["entry_price", "exit_price", "stop_loss", "take_profit", "risk_pips",
               "pnl_pips", "result_r", "planned_rr", "mfe_r", "mae_r", "duration_min"]
    df[numeric] = df[numeric].apply(pd.to_numeric, errors="coerce")
    return df
