# 0021: Liquidity levels

- **Date:** 11 Nov 2026
- **Status:** accepted
- **Decided by:** Yuvraj Sharma (asked for an indicator that shows the important liquidity points; chose previous day/week, Asia and equal highs/lows with sweeps), with Claude on the design

## What and why

Price is often drawn to where stop orders rest: just past the previous day's and week's extremes, the Asia session's range (swept at the London open), and highs or lows that line up at the same price. The trader's ADR plan already measures how far price pushes past such a level, so seeing which levels are still waiting and which were just taken is useful while replaying.

`web/js/liquidity.js` works out four kinds, each with its own switch in the Indicators dialog (remembered in the browser, on both charts):

- **PDH / PDL**: the last completed trading day's high and low (days run 17:00 to 17:00 New York, the server day used everywhere else), drawn through the next day.
- **PWH / PWL**: the same for the last completed week (server days Monday to Friday), drawn through the next week.
- **Asia H / L**: the Tokyo session's range, 09:00-18:00 Tokyo (00:00-09:00 UTC all year, Tokyo has no daylight saving), drawn from its close until the next session opens. It is fixed rather than taken from the editable session list, so the levels do not change when the session shading is edited. Not drawn above H1: a 4-hour candle cannot show a 9-hour range.
- **EQH / EQL**: a swing high (low) within a tolerance (1.5 pips by default) of an earlier one that price has not traded more than the tolerance through since. A swing point has `length` candles (5 by default) lower highs (higher lows) on each side. More points at the same price join the level (labelled ×3, ×4) and it sits at the outermost of them. It runs until swept.

A level is **swept** when a wick trades through it: high above a high level, low below a low level (equal is not through). The line then turns dashed, stops on that candle with a cross, and is labelled "swept". A level that is not swept ends with its period (day, week, next Asia session); equal levels run until swept.

## No look-ahead

As with the other indicators, it reads only the chart's candles, which in a replay are the revealed ones. A day's levels appear on the first candle of the next day; the Asia levels on the first candle after the session; a swing point `length` candles after it formed, so an equal level appears that many candles after its second point. The forming candle is worked out on a copy of the state (as in smc.js), so a sweep by a forming candle shows at once.

## Speed and tests

The state after every closed candle is kept, so a replay step works out one candle; the full calculation over 30,500 M15 candles took 19 ms in the browser, and a replay step with all four kinds on took 0.4 ms on average (the whole key press, chart included).

`web/tests/liquidity.test.mjs`: a replay played candle by candle equals a full calculation and after a step back; hidden candles change nothing; hand-built candles give the right PDH/PDL, a sweep on the right candle, a day level ending with its day, the Asia range put up at 09:00 UTC (and nothing on H4), an equal high known only once its second point is confirmed and not found with a tighter tolerance; damaged settings fall back to the defaults.

## Not yet done

Untouched swing highs and lows (left out on purpose: many lines), other sessions' ranges (London), a "close back inside" (failed break) marker, an ADR-based tolerance instead of pips, alerts.
