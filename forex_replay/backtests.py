"""Saved backtests from the browser app, kept as files next to the journals.

    strategies/<journal>/backtests/<id>.json   one file per backtest (resumable)
    strategies/<journal>/trades.csv            the journal: one row per closed trade
    strategies/<journal>/screenshots/<name>.png  chart pictures attached to trades

A backtest file holds what is needed to rebuild the run: where it started, the
account settings, every action taken (orders, closes, stop moves) with the time
it was taken, and the drawings. It also holds a copy of the trades as they
stood when saved; the browser rebuilds the run and checks it against that copy.

Saving a backtest appends its closed trades to the journal. The journal keys
rows by (run_id, trade_id) and the run id is the backtest id, so saving the
same backtest again never adds a trade twice.
"""

from __future__ import annotations

import csv
import json
import re
import threading
from pathlib import Path

from .config import JOURNALS_DIR, Instrument
from .journal import TradeJournal, note_fields, web_trade_to_row

FORMAT_VERSION = 1
MAX_BYTES = 5_000_000
MAX_IMAGE_BYTES = 5_000_000
NAME = re.compile(r"^[A-Za-z0-9_-]{1,48}$")
IMAGE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,80}\.png$")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

_lock = threading.Lock()  # the server is threaded; one save at a time keeps files and the journal whole


class BacktestError(ValueError):
    """A request the store refuses; the message is shown to the user."""


def check_name(value: str, what: str) -> str:
    if not isinstance(value, str) or not NAME.match(value):
        raise BacktestError(f"{what} may use only letters, digits, - and _ (up to 48 characters).")
    return value


def path_for(journal: str, backtest_id: str, root: Path = JOURNALS_DIR) -> Path:
    check_name(journal, "A journal name")
    check_name(backtest_id, "A backtest id")
    return root / journal / "backtests" / f"{backtest_id}.json"


def summary(data: dict) -> dict:
    """The fields the list in the app shows, without the action log and drawings."""
    keys = ("id", "name", "journal", "symbol", "startTime", "furthestTime", "created", "saved", "result", "settings", "challenge",
            "timeframe", "strategy", "strategyVersion", "status", "notes", "archived", "stage", "parentId", "parentJournal")
    return {key: data.get(key) for key in keys}


def list_backtests(root: Path = JOURNALS_DIR) -> list[dict]:
    """Every saved backtest, newest save first. Unreadable files are listed with the reason."""
    out = []
    for path in sorted(root.glob("*/backtests/*.json")):
        try:
            out.append(summary(json.loads(path.read_text(encoding="utf-8"))))
        except (OSError, ValueError) as err:
            out.append({"id": path.stem, "journal": path.parent.parent.name, "error": f"unreadable: {err}"})
    return sorted(out, key=lambda s: s.get("saved") or "", reverse=True)


def load(journal: str, backtest_id: str, root: Path = JOURNALS_DIR) -> dict:
    path = path_for(journal, backtest_id, root)
    if not path.exists():
        raise FileNotFoundError(f"No saved backtest {journal}/{backtest_id}.")
    return json.loads(path.read_text(encoding="utf-8"))


def validate(data: dict, journal: str, backtest_id: str) -> None:
    if not isinstance(data, dict):
        raise BacktestError("A backtest must be a JSON object.")
    if data.get("version") != FORMAT_VERSION:
        raise BacktestError(f"Unknown backtest format {data.get('version')!r}; expected {FORMAT_VERSION}.")
    if data.get("id") != backtest_id or data.get("journal") != journal:
        raise BacktestError("The backtest's id and journal do not match where it is being saved.")
    for key, kind in (("actions", list), ("drawings", list), ("trades", list), ("settings", dict)):
        if not isinstance(data.get(key), kind):
            raise BacktestError(f"The backtest has no valid '{key}'.")
    for key in ("startTime", "furthestTime", "digits", "pipPoints"):
        if not isinstance(data.get(key), int):
            raise BacktestError(f"The backtest has no valid '{key}'.")


def save(journal: str, backtest_id: str, data: dict, root: Path = JOURNALS_DIR) -> dict:
    """Write the backtest file (atomically) and add its new closed trades to the journal."""
    validate(data, journal, backtest_id)
    path = path_for(journal, backtest_id, root)
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        tmp.replace(path)  # a crash mid-write never leaves half a file

        symbol = str(data.get("symbol") or "EURUSD")
        log = TradeJournal(root / journal / "trades.csv", Instrument(symbol=symbol), run_id=backtest_id)
        added = 0
        closed = [t for t in data["trades"] if t.get("status") == "CLOSED"]
        for trade in closed:
            row = web_trade_to_row(trade, symbol=symbol, digits=data["digits"],
                                   pip_points=data["pipPoints"], run_id=backtest_id)
            added += log.log_row(row)
        updated = log.update_notes({str(t["id"]): note_fields(t) for t in closed})
    return {"ok": True, "journalAdded": added, "journalUpdated": updated,
            "journal": str(log.path.relative_to(root.parent))}


def list_journals(root: Path = JOURNALS_DIR) -> list[dict]:
    """Every journal folder with a trades.csv, and how many rows it has."""
    out = []
    for path in sorted(root.glob("*/trades.csv")):
        if NAME.match(path.parent.name):
            with path.open(newline="", encoding="utf-8") as f:
                out.append({"name": path.parent.name, "trades": sum(1 for _ in csv.DictReader(f))})
    return out


def journal_rows(journal: str, root: Path = JOURNALS_DIR) -> list[dict]:
    """The rows of a journal as text, in the order they were logged (the analytics page reads these)."""
    path = root / check_name(journal, "A journal name") / "trades.csv"
    if not path.exists():
        raise FileNotFoundError(f"No journal {journal}.")
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def image_path(journal: str, name: str, root: Path = JOURNALS_DIR) -> Path:
    check_name(journal, "A journal name")
    if not isinstance(name, str) or not IMAGE_NAME.match(name):
        raise BacktestError("A screenshot name may use only letters, digits, - and _, and must end in .png.")
    return root / journal / "screenshots" / name


def save_image(journal: str, name: str, data: bytes, root: Path = JOURNALS_DIR) -> dict:
    """Store a PNG screenshot. Anything that is not a PNG is refused."""
    path = image_path(journal, name, root)
    if not data.startswith(PNG_SIGNATURE) or len(data) > MAX_IMAGE_BYTES:
        raise BacktestError("A screenshot must be a PNG image of at most 5 MB.")
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
    return {"ok": True, "path": str(path.relative_to(root.parent))}


def load_image(journal: str, name: str, root: Path = JOURNALS_DIR) -> bytes:
    path = image_path(journal, name, root)
    if not path.exists():
        raise FileNotFoundError(f"No screenshot {journal}/{name}.")
    return path.read_bytes()


def delete_image(journal: str, name: str, root: Path = JOURNALS_DIR) -> None:
    path = image_path(journal, name, root)
    with _lock:
        if path.exists():
            path.unlink()


def move(journal: str, backtest_id: str, to: str, root: Path = JOURNALS_DIR) -> dict:
    """Move a backtest to another journal: its file, its journal rows and its trades' screenshots.

    It is saved under the new journal first (which writes its rows there), then its screenshots
    move, then its rows leave the old journal and the old file goes. A backtest with the same id
    already in the new journal is refused rather than overwritten.
    """
    check_name(to, "A journal name")
    if to == journal:
        raise BacktestError("It is already in that journal.")
    data = load(journal, backtest_id, root)
    if path_for(to, backtest_id, root).exists():
        raise BacktestError(f"{to} already has a backtest {backtest_id}.")
    data["journal"] = to
    result = save(to, backtest_id, data, root)
    moved_images = 0
    names = {n for t in data.get("trades", []) for n in (t.get("screenshots") or []) if isinstance(n, str)}
    with _lock:
        for name in names:
            try:
                source, target = image_path(journal, name, root), image_path(to, name, root)
            except BacktestError:
                continue
            if source.exists() and not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                source.replace(target)
                moved_images += 1
        old_log = root / journal / "trades.csv"
        dropped = TradeJournal(old_log, Instrument(symbol=str(data.get("symbol") or "EURUSD")), run_id=backtest_id).drop_run(backtest_id) \
            if old_log.exists() else 0
        old = path_for(journal, backtest_id, root)
        if old.exists():
            old.unlink()
    return {**result, "journalRemoved": dropped, "screenshotsMoved": moved_images}


LIBRARY_FILE = "_library.json"  # strategies/_library.json: each strategy's rules and what each version changed


def clean_library(data) -> dict:
    """{"strategies": {name: {"rules": text, "versions": {version: text}}}}, with anything else dropped."""
    out = {"strategies": {}}
    strategies = data.get("strategies") if isinstance(data, dict) else None
    if not isinstance(strategies, dict):
        return out
    for name, entry in list(strategies.items())[:500]:
        if not isinstance(name, str) or not name.strip() or len(name) > 60 or not isinstance(entry, dict):
            continue
        versions = entry.get("versions") if isinstance(entry.get("versions"), dict) else {}
        out["strategies"][name] = {
            "rules": str(entry.get("rules") or "")[:8000],
            "versions": {str(v)[:20]: str(t or "")[:2000] for v, t in list(versions.items())[:100] if isinstance(v, str) and v.strip()},
        }
    return out


def load_library(root: Path = JOURNALS_DIR) -> dict:
    path = root / LIBRARY_FILE
    if not path.exists():
        return {"strategies": {}}
    try:
        return clean_library(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return {"strategies": {}}


def save_library(data, root: Path = JOURNALS_DIR) -> dict:
    library = clean_library(data)
    path = root / LIBRARY_FILE
    with _lock:
        root.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(library, indent=1), encoding="utf-8")
        tmp.replace(path)
    return {"ok": True}


def delete(journal: str, backtest_id: str, root: Path = JOURNALS_DIR) -> None:
    """Remove the backtest file. Its trades stay in the journal."""
    path = path_for(journal, backtest_id, root)
    with _lock:
        if not path.exists():
            raise FileNotFoundError(f"No saved backtest {journal}/{backtest_id}.")
        path.unlink()
