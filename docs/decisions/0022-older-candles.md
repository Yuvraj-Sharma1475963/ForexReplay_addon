# 0022: Every candle in the exports, and a backfill for older years

- **Date:** 14 Nov 2026
- **Status:** accepted; the default backfill source is HistData.com since [0023](0023-histdata-history.md)
- **Decided by:** Yuvraj Sharma (wanted past data too), with Claude on how

## What changed

The market data used to start on 1 Aug 2025, the date chosen when the app was first built ([0002](0002-market-data-and-clock.md)). `build()` cut every candle before it, although `data/EURUSD_M5.csv` already held EURUSD M5 from 25 Feb 2025.

That file is the same broker feed on the same server clock: over the 68,594 candles it shares with the August export, every close is identical but one (an hour's shift either way matches under 1%). So nothing stops it being used, and `build()` (with `python -m forex_replay data` and the website build) now keeps every candle the exports have unless `--start` is given. The data now runs from 25 Feb 2025: 127,711 candles instead of 95,573.

## Older years: `backfill`

`python -m forex_replay backfill --from 2023-01-01 [--push]` asks the MT5 terminal on this computer for candles from that date up to the first one already in `data/`, in 60-day pieces (asking again when a piece comes back empty, as the terminal downloads old history from the broker on request). They are checked like an update's and written to `data/EURUSD_M5_mt5_history.csv`, an ordinary export, so the other files win any overlap.

MT5 hands out only as many candles per symbol and timeframe as its **Max bars in chart** setting (Tools > Options > Charts). At the 100,000 it was set to, that is about 15 months of M5: on 14 Nov 2026 the terminal's oldest M5 candle was 14 Jul 2025. Setting it to Unlimited and restarting MetaTrader 5 is needed before a backfill can reach further; how far back the broker's history goes is not known until then. If MT5 gives nothing, the command says so and names the setting.

## Speed

With 127,711 candles the app loaded and replayed normally in the browser: M5 drawn in 36 ms, M15 in 3 ms, a replay step 0.4 ms (March 2025, with the chart window from [0020](0020-chart-candle-window.md)). Every month is still loaded at start, so several more years would make the first load slower; not measured.

## Not yet done

Loading months only when they are needed; a backfill button in the app (it is a command for now).
