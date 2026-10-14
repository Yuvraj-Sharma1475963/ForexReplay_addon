"""Local web server for the ForexReplay browser app (Python standard library only).

    python -m forex_replay app

On start it (1) rebuilds the market-data files if an MT5 export is newer,
(2) downloads the TradingView Lightweight Charts file once if it is missing,
(3) serves web/ on http://127.0.0.1:8765 and opens it in your browser.

It also stores backtests for the app (see backtests.py):

    GET    /api/backtests                    list saved backtests
    GET    /api/backtests/<journal>/<id>     one backtest
    PUT    /api/backtests/<journal>/<id>     save it, and add its closed trades to the journal
    DELETE /api/backtests/<journal>/<id>     remove it (its journal rows stay)
    POST   /api/backtests/<journal>/<id>/move  {"to": journal}: move it, its rows and screenshots
    GET    /api/library                      strategy rules and version notes
    PUT    /api/library                      save them
    GET / PUT / DELETE /api/screenshots/<journal>/<name>.png   chart pictures for trades
    GET    /api/journals                     journal folders that have a trades.csv
    GET    /api/journal/<journal>            the rows of a journal, for the analytics page

Writes must be sent as application/json (screenshots as image/png). A web page on another site cannot
send that to this server without the browser asking first, and the server
never says yes, so only the app itself can write files.
"""

from __future__ import annotations

import json
import mimetypes
import threading
import urllib.request
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import __version__
from . import backtests
from .config import JOURNALS_DIR, PROJECT_ROOT

WEB_ROOT = PROJECT_ROOT / "web"
VENDOR_DIR = WEB_ROOT / "vendor"
CHART_LIB = VENDOR_DIR / "lightweight-charts.standalone.production.js"
CHART_LIB_URL = ("https://cdn.jsdelivr.net/npm/lightweight-charts@5/dist/"
                 "lightweight-charts.standalone.production.js")
DEFAULT_PORT = 8765

# Windows can map .js to text/plain through the registry, which stops browsers
# from running ES modules. Fix the types we serve explicitly.
MIME_TYPES = {
    ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
    ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml",
    ".bin": "application/octet-stream", ".png": "image/png", ".ico": "image/x-icon",
}
for ext, mime in MIME_TYPES.items():
    mimetypes.add_type(mime, ext)


def chart_library_version(path: Path = CHART_LIB) -> str | None:
    """Read the version from the library's licence banner, e.g. 'v5.0.8'."""
    if not path.exists():
        return None
    head = path.read_text(encoding="utf-8", errors="replace")[:400]
    for word in head.split():
        if word.startswith("v") and word[1:2].isdigit():
            return word.rstrip(",")
    return "unknown"


def ensure_chart_library() -> str | None:
    if CHART_LIB.exists():
        return chart_library_version()
    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    print("Downloading TradingView Lightweight Charts (one time)...")
    try:
        with urllib.request.urlopen(CHART_LIB_URL, timeout=30) as response:
            CHART_LIB.write_bytes(response.read())
    except OSError as err:
        print(f"  Could not download it ({err}).\n"
              f"  Download {CHART_LIB_URL}\n  and save it as {CHART_LIB}")
        return None
    version = chart_library_version()
    print(f"  Saved {CHART_LIB.name} ({version})")
    return version


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **MIME_TYPES}
    journals_root = JOURNALS_DIR

    def do_GET(self):  # noqa: N802 (http.server naming)
        route = self.path.split("?")[0]
        if route == "/api/health":
            self._json({"ok": True, "version": __version__,
                        "chart_library": chart_library_version()})
        elif route == "/api/backtests":
            self._json({"backtests": backtests.list_backtests(self.journals_root)})
        elif route.startswith("/api/backtests/"):
            self._backtest("GET")
        elif route.startswith("/api/screenshots/"):
            self._screenshot("GET")
        elif route == "/api/library":
            self._json(backtests.load_library(self.journals_root))
        elif route == "/api/journals":
            self._json({"journals": backtests.list_journals(self.journals_root)})
        elif route.startswith("/api/journal/"):
            try:
                self._json({"rows": backtests.journal_rows(route.split("/")[3], self.journals_root)})
            except FileNotFoundError as err:
                self._json({"error": str(err)}, 404)
            except backtests.BacktestError as err:
                self._json({"error": str(err)}, 400)
        else:
            super().do_GET()

    def do_PUT(self):  # noqa: N802
        if self.path.split("?")[0] == "/api/library":
            try:
                self._json(backtests.save_library(self._read_json(), self.journals_root))
            except (backtests.BacktestError, ValueError) as err:
                self._json({"error": str(err)}, 400)
        elif self.path.startswith("/api/screenshots/"):
            self._screenshot("PUT")
        else:
            self._backtest("PUT")

    def do_POST(self):  # noqa: N802
        parts = self.path.split("?")[0].split("/")  # ['', 'api', 'backtests', journal, id, 'move']
        if len(parts) != 6 or parts[:3] != ["", "api", "backtests"] or parts[5] != "move":
            self._json({"error": "Not found."}, 404)
            return
        try:
            body = self._read_json()
            self._json(backtests.move(parts[3], parts[4], body.get("to") if isinstance(body, dict) else None, self.journals_root))
        except FileNotFoundError as err:
            self._json({"error": str(err)}, 404)
        except (backtests.BacktestError, ValueError) as err:
            self._json({"error": str(err)}, 400)

    def do_DELETE(self):  # noqa: N802
        if self.path.startswith("/api/screenshots/"):
            self._screenshot("DELETE")
        else:
            self._backtest("DELETE")

    def _screenshot(self, method: str) -> None:
        parts = self.path.split("?")[0].split("/")  # ['', 'api', 'screenshots', journal, name]
        if len(parts) != 5:
            self._json({"error": "Not found."}, 404)
            return
        journal, name = parts[3], parts[4]
        try:
            if method == "GET":
                body = backtests.load_image(journal, name, self.journals_root)
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif method == "DELETE":
                backtests.delete_image(journal, name, self.journals_root)
                self._json({"ok": True})
            else:
                if self.headers.get("Content-Type", "").split(";")[0].strip() != "image/png":
                    raise backtests.BacktestError("Send the screenshot as image/png.")
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > backtests.MAX_IMAGE_BYTES:
                    raise backtests.BacktestError("The screenshot is empty or too large.")
                self._json(backtests.save_image(journal, name, self.rfile.read(length), self.journals_root))
        except FileNotFoundError as err:
            self._json({"error": str(err)}, 404)
        except backtests.BacktestError as err:
            self._json({"error": str(err)}, 400)

    def _backtest(self, method: str) -> None:
        parts = self.path.split("?")[0].split("/")  # ['', 'api', 'backtests', journal, id]
        if len(parts) != 5 or parts[:3] != ["", "api", "backtests"]:
            self._json({"error": "Not found."}, 404)
            return
        journal, backtest_id = parts[3], parts[4]
        try:
            if method == "GET":
                self._json(backtests.load(journal, backtest_id, self.journals_root))
            elif method == "DELETE":
                backtests.delete(journal, backtest_id, self.journals_root)
                self._json({"ok": True})
            else:
                self._json(backtests.save(journal, backtest_id, self._read_json(), self.journals_root))
        except FileNotFoundError as err:
            self._json({"error": str(err)}, 404)
        except (backtests.BacktestError, ValueError) as err:
            self._json({"error": str(err)}, 400)

    def _read_json(self):
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            raise backtests.BacktestError("Send the backtest as application/json.")
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > backtests.MAX_BYTES:
            raise backtests.BacktestError("The backtest is empty or too large to save.")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def end_headers(self):
        # Always serve fresh files while developing: no stale JavaScript after an update.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # keep the console quiet except for errors
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


def make_server(port: int = DEFAULT_PORT, root: Path = WEB_ROOT,
                journals_root: Path = JOURNALS_DIR) -> ThreadingHTTPServer:
    """Bind to localhost only; if the port is busy, try the next few."""
    handler = partial(type("AppHandler", (Handler,), {"journals_root": journals_root}), directory=str(root))
    last_error = None
    for candidate in range(port, port + 10):
        try:
            return ThreadingHTTPServer(("127.0.0.1", candidate), handler)
        except OSError as err:
            last_error = err
    raise OSError(f"No free port between {port} and {port + 9}: {last_error}")


def run(port: int = DEFAULT_PORT, open_browser: bool = True, rebuild: bool = False) -> None:
    from .datapipe import build, is_stale, summary

    if rebuild or is_stale():
        print("Building market data from your MT5 exports...")
        manifest, report = build()
        print("  " + summary(manifest, report).replace("\n", "\n  "))
    ensure_chart_library()

    server = make_server(port)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"\nForexReplay v{__version__} running at {url}")
    print("Keep this window open while you use the app. Press Ctrl+C to stop.\n")
    if open_browser:
        threading.Timer(0.8, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")
    finally:
        server.server_close()
