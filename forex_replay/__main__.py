"""Command line entry point.

    python -m forex_replay replay   [--journal impulse_candle] [--start "2025-03-03 07:00"]
    python -m forex_replay backtest [--strategy asian_breakout] [--spread 0.2]
    python -m forex_replay report   strategies/impulse_candle/trades.csv [--plot equity.png]
    python -m forex_replay app      (v2 browser app)
    python -m forex_replay data     (rebuild the app's market data from MT5 exports)
    python -m forex_replay site     (build the app as a static website, for free hosting)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import DEFAULT_DATA_FILE, EURUSD_M5, JOURNALS_DIR, RESULTS_DIR, Instrument


def _instrument(args) -> Instrument:
    return Instrument(symbol=args.symbol, timeframe=args.timeframe, pip_size=args.pip_size,
                      digits=EURUSD_M5.digits)


def cmd_replay(args) -> None:
    from .data import load_candles
    from .gui import ReplayApp

    candles = load_candles(args.data)
    app = ReplayApp(
        candles, _instrument(args), JOURNALS_DIR / args.journal, start=args.start,
        spread_pips=args.spread, window=args.window, speed_ms=args.speed, risk_pct=args.risk,
    )
    app.run()


def cmd_backtest(args) -> None:
    import matplotlib
    matplotlib.use("Agg")

    from .backtest import run_backtest
    from .data import load_candles
    from .plotting import plot_equity, save
    from .stats import format_report
    from .strategies import STRATEGIES

    instrument = _instrument(args)
    candles = load_candles(args.data)
    if args.date_from:
        candles = candles.loc[args.date_from:]
    if args.date_to:
        candles = candles.loc[:args.date_to]

    strategy = STRATEGIES[args.strategy](instrument)
    result = run_backtest(candles, strategy, instrument, spread_pips=args.spread)

    out_dir = Path(args.out) if args.out else RESULTS_DIR / args.strategy
    out_dir.mkdir(parents=True, exist_ok=True)
    result.journal.to_csv(out_dir / "trades.csv", index=False)
    print(f"{args.strategy}: {candles.index[0]:%Y-%m-%d} to {candles.index[-1]:%Y-%m-%d}, "
          f"spread {args.spread} pips")
    print(format_report(result.journal, args.risk))
    if len(result.journal):
        chart = save(plot_equity(result.journal, f"{args.strategy} - equity curve (R)"),
                     out_dir / "equity_curve.png")
        print(f"Saved {out_dir / 'trades.csv'} and {chart}")


def cmd_report(args) -> None:
    import matplotlib
    matplotlib.use("Agg")

    from .journal import load_journal
    from .plotting import plot_equity, save
    from .stats import format_report

    journal = load_journal(args.journal_csv)
    print(format_report(journal, args.risk))
    if args.plot and len(journal):
        print(f"Saved {save(plot_equity(journal, 'Equity curve (R)'), args.plot)}")


def cmd_app(args) -> None:
    from .server import run

    run(port=args.port, open_browser=not args.no_browser, rebuild=args.rebuild)


def cmd_data(args) -> None:
    from .datapipe import build, summary

    manifest, report = build(start=args.start)
    print(summary(manifest, report))


def cmd_update(args) -> None:
    from .updater import run_update

    result = run_update(source=args.source, push_to_github=args.push)
    print(result["text"])
    if not result["ok"]:
        sys.exit(1)


def cmd_site(args) -> None:
    from .site import build_site

    result = build_site(Path(args.out))
    print(f"Website written to {result['out']}: {result['files']} files, {result['bytes'] / 1e6:.1f} MB")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m forex_replay",
                                     description="Forex bar-replay simulator and backtester")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--data", default=str(DEFAULT_DATA_FILE), help="OHLC CSV (MT5 export)")
    common.add_argument("--symbol", default=EURUSD_M5.symbol)
    common.add_argument("--timeframe", default=EURUSD_M5.timeframe)
    common.add_argument("--pip-size", type=float, default=EURUSD_M5.pip_size)
    common.add_argument("--spread", type=float, default=0.0, help="spread in pips (default 0)")
    common.add_argument("--risk", type=float, default=1.0,
                        help="%% of account risked per trade, for the prop-firm view (default 1)")

    sub = parser.add_subparsers(dest="command", required=True)

    replay = sub.add_parser("replay", parents=[common], help="interactive bar replay")
    replay.add_argument("--journal", default="impulse_candle",
                        help="journal name; trades go to strategies/<name>/trades.csv")
    replay.add_argument("--start", help='start date/time, e.g. "2025-03-03 07:00"')
    replay.add_argument("--window", type=int, default=100, help="candles on screen")
    replay.add_argument("--speed", type=int, default=200, help="autoplay ms per candle")
    replay.set_defaults(func=cmd_replay)

    backtest = sub.add_parser("backtest", parents=[common], help="run an automated strategy")
    backtest.add_argument("--strategy", default="asian_breakout")
    backtest.add_argument("--from", dest="date_from")
    backtest.add_argument("--to", dest="date_to")
    backtest.add_argument("--out", help="output folder (default results/<strategy>)")
    backtest.set_defaults(func=cmd_backtest)

    report = sub.add_parser("report", parents=[common], help="statistics for a journal CSV")
    report.add_argument("journal_csv")
    report.add_argument("--plot", help="save an equity-curve PNG here")
    report.set_defaults(func=cmd_report)

    app = sub.add_parser("app", help="v2: open the browser replay app")
    app.add_argument("--port", type=int, default=8765)
    app.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    app.add_argument("--rebuild", action="store_true", help="rebuild market data first")
    app.set_defaults(func=cmd_app)

    data = sub.add_parser("data", help="v2: rebuild market data from the MT5 exports in data/")
    data.add_argument("--start", default="2025-08-01", help="first UTC date to keep")
    data.set_defaults(func=cmd_data)

    upd = sub.add_parser("update", help="v2: add the newest candles (MT5 on this computer, else Yahoo), checked")
    upd.add_argument("--source", choices=["auto", "mt5", "yahoo"], default="auto",
                     help="auto: MT5 if it can be reached, otherwise Yahoo Finance for the missing days")
    upd.add_argument("--push", action="store_true", help="commit the data files and push them to GitHub (main only)")
    upd.set_defaults(func=cmd_update)

    site = sub.add_parser("site", help="v2: build the app as a static website (backtests saved in the browser)")
    site.add_argument("--out", default="_site", help="folder to write the website into")
    site.set_defaults(func=cmd_site)
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main(sys.argv[1:])
