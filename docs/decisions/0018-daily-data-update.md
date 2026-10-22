# 0018: Market data updates with one click: MT5 on this computer, Yahoo as a backup

- **Date:** 23 Oct 2026 (made manual the same day)
- **Status:** accepted
- **Decided by:** Yuvraj Sharma (no more manual exports; both sources; nothing running in the background), with Claude on the design

## Only when asked

A first version ran every evening from Windows Task Scheduler and every night on GitHub. Yuvraj did not want anything working in the background on the laptop, so both schedules were removed the same day. An update runs only when started:

- **"Update data" in the app on this computer** (top bar). It calls `POST /api/update` on the app's local server, which runs `updater.run_update`: the newest candles from MT5, checked, the web data rebuilt, and (ticked by default) the data files committed and pushed to GitHub, which publishes the website again. One update at a time; a second click while one runs is told so. Afterwards "Reload chart with the new candles" saves the replay on screen, if any, and reloads.
- **`python -m forex_replay update [--push]`** or double-clicking **`update_data.bat`** (log in `data/update.log`) does the same from outside the app.
- **On the website** the button cannot reach MT5 on the computer, so it explains the two ways and links to GitHub: Actions → **Data update** → **Run workflow** (`.github/workflows/data-update.yml`, `workflow_dispatch` only) fills the missing hours from Yahoo Finance and starts the Website workflow.

## Two sources, in a fixed order

1. **MT5**, read with MetaQuotes' `MetaTrader5` package from the terminal on Yuvraj's computer: the candles since the last ones kept (the last two days again, so a day cut short is completed) go to `data/EURUSD_M5_mt5_auto.csv` in the Export Bars format. Pushing commits only the data files, and only from the `main` branch.
2. **Yahoo Finance** (free, no account), when MT5 cannot be reached or on GitHub: only candles newer than the last real candle, into `data/EURUSD_M5_yahoo_fill.csv`. Yahoo has no volume or spread: the volume is 0 and the spread is the broker's median of the last 20 days.

Which file wins where two have the same candle is fixed (`find_exports`): the Yahoo fill first (it loses to everything), then the manual exports oldest first, then the MT5 file (it wins). Before this the order was by file date on disk, which on GitHub's servers is just the checkout time. When MT5 next runs, the filled candles it now has are removed from the fill file.

Dukascopy was tried first for the backup: its data server answered 503 to every request from a script while its website loaded, so it was not used.

## The same feed as the existing data

Yuvraj's terminal is logged in to FundedNext (Five Percent Online Ltd), the company of the original export. On the 639 candles both have (9 to 11 Sep 2026), open, high, low and close differ by a median of 1 point, and shifting the clock by an hour either way makes the difference 33 points: the same prices on the same clock. The first update brought the data from 11 Sep to 22 Oct 2026 (90,997 candles, none bad).

## Checks before anything is kept ("auto-correct")

Every new candle goes through `updater.clean`: sorted, duplicates dropped, candles off the 5-minute grid or still forming dropped, Saturday and Sunday (server clock) dropped, high and low widened to hold the open and close, and spikes dropped (a range over 15 times the median of its neighbours, or an open 1% from the previous close). Each fix is counted in what the button shows. The whole data set is then built again, which refuses impossible candles, as before.

## No look-ahead

Nothing here reaches the replay except through the data files; a replay still reveals only candles before its clock.

## Not done

Only EURUSD M5. MT5 must be logged in with the password saved; otherwise the update takes the missing hours from Yahoo.
