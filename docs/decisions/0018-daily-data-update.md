# 0018: The market data updates itself every day: MT5 on this computer, Yahoo as a backup

- **Date:** 23 Oct 2026
- **Status:** accepted
- **Decided by:** Yuvraj Sharma (no more manual exports; both sources), with Claude on the design

## Two sources, in a fixed order

1. **MT5, every evening on Yuvraj's computer.** `update_data.bat`, run by Windows Task Scheduler ("ForexReplay data update", daily at 23:30 India time, and as soon as the computer is on if it was off then), runs `python -m forex_replay update --push`. It reads the M5 candles since the last ones kept (the last two days again, so a day cut short is completed) from the MT5 terminal with MetaQuotes' `MetaTrader5` package, writes them to `data/EURUSD_M5_mt5_auto.csv` in the Export Bars format, rebuilds the web data, then commits only the data files and pushes, only from the `main` branch. GitHub Pages then publishes the website again. The log is `data/update.log`.
2. **Yahoo Finance, every night in the cloud.** `.github/workflows/data-update.yml` (22:30 UTC, Monday to Friday) runs `update --source yahoo`: candles newer than the last real candle go to `data/EURUSD_M5_yahoo_fill.csv`, then it starts the Website workflow. Yahoo has no volume or spread: the volume is 0 and the spread is the broker's median of the last 20 days.

Which file wins where two have the same candle is now fixed (`find_exports`): the Yahoo fill first (it loses to everything), then the manual exports oldest first, then the MT5 daily file (it wins). Before this the order was by file date on disk, which on GitHub's servers is just the checkout time. When MT5 next runs, the filled candles it now has are removed from the fill file.

Dukascopy was tried first for the backup: its data server answered 503 to every request from a script while its website loaded, so it was not used.

## The same feed as the existing data

Yuvraj's terminal is logged in to FundedNext (Five Percent Online Ltd), the company of the original export. On the 639 candles both have (9 to 11 Sep 2026), open, high, low and close differ by a median of 1 point, and shifting the clock by an hour either way makes the difference 33 points: the same prices on the same clock.

## Checks before anything is kept ("auto-correct")

Every new candle goes through `updater.clean`: sorted, duplicates dropped, candles off the 5-minute grid or still forming dropped, Saturday and Sunday (server clock) dropped, high and low widened to hold the open and close, and spikes dropped (a range over 15 times the median of its neighbours, or an open 1% from the previous close). Each fix is counted in the log. The whole data set is then built again, which refuses impossible candles, as before.

## No look-ahead

Nothing here reaches the replay except through the data files; a replay still reveals only candles before its clock.

## Not done

Only EURUSD M5. MT5 must be logged in (with the password saved) for the evening run; otherwise that day comes from Yahoo until the next MT5 run. GitHub turns off scheduled workflows in a repository with no activity for 60 days; the daily pushes keep it active.
