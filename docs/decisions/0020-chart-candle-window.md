# 0020: The chart library holds only the candles around the screen

- **Date:** 5 Nov 2026
- **Status:** accepted
- **Decided by:** Yuvraj Sharma (replay got slower and slower after many candles), with Claude on the cause and the fix

## What was slow

Measured on the website copy with 40 saved backtests, a replay of 30,000 M5 candles and 109 trades:

- The app's own work per candle (trading, panel, journal, autosave) stayed about the same the whole time: 1.1 to 1.6 ms.
- Drawing the chart after one candle grew with the number of candles in the chart: 1.8 ms with 678 M15 candles, 7.8 ms with 13,433, 19 ms with 30,199. Indicators added about the same again per line, and RSI/ATR panels more (51 ms per candle with everything on).
- A bare Lightweight Charts chart outside the app did the same (2 ms at 1,000 candles, 10 ms at 30,000, for changing the last candle only). The library does work across every candle it holds each time one changes.

So a replay started a long way back in the data, or run for a long time, lost frames candle by candle.

## The fix

`ChartView` (web/js/chart.js) gives the library only candles `base`..`end - 1`: about 1,000 either side of the screen. `this.candles` stays the whole timeframe, so the indicators, order blocks and drawings are worked out on every candle as before; only what is sent to the library is a slice. Its index ("logical" position) is ours minus `base`, and nothing outside `ChartView` sees that: the primitives and the drawing layer go through `visibleRange()`, `xOf(i)` and `indexAtX(x)`, and every move of the view goes through `setRange()`.

- Scrolling or zooming to within 200 candles of an end of the window loads the candles around the view.
- During a replay, with the newest candle on screen, candles more than 2,000 behind the screen are dropped every 1,000 or so. Adding candles at the left or dropping them keeps the newest candle where it is, so the view does not move.
- Looking at history during a replay: the window stops at what is on screen; the new candles are added when you scroll back to them.

The library applies a new range only at its next animation frame, so the range asked for is remembered until it reports the change, and the window is looked at once per frame (`checkWindowSoon`), never in the middle of an update.

After: the same replay costs about 1.7 ms of work and 5 to 7 ms to draw per candle with everything on, from the first candle to the 30,000th.

## Not changed

The online autosave writes every saved backtest as one IndexedDB record every 1.5 s while a replay runs (12 ms with 40 backtests, 1.2 MB). That grows with the number of saved backtests, not with candles, so it was left; one record per backtest is the next step if it ever shows.
