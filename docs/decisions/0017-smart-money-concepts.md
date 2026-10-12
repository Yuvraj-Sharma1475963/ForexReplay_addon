# 0017: Order blocks and fair value gaps, ported from LuxAlgo's Smart Money Concepts

- **Date:** 12 Oct 2026
- **Status:** accepted
- **Decided by:** Yuvraj Sharma (wanted LuxAlgo's order blocks and fair value gaps in the replay, each with its own switch), with Claude on the port

## What and why

Order blocks are what the trader backtests against, and TradingView's "Smart Money Concepts [LuxAlgo]" is the version they know. So `web/js/smc.js` repeats that script's rules rather than a home-made definition: the same blocks on the same candles.

Ported: the swing legs (pivots of 50 candles, changeable) and internal legs (5), the breaks of structure that store an order block, mitigation (by wick or by close), the volatility filter (ATR 200 or cumulative mean range) and fair value gaps on the chart's timeframe with the automatic threshold. Drawn: internal and swing order blocks (the latest N not yet mitigated, reaching to the right edge) and fair value gaps (until filled). Each has its own switch in the Indicators dialog, remembered in the browser, on both charts.

Not ported: BOS/CHoCH labels, equal highs and lows, strong/weak highs, premium/discount zones, multi-timeframe levels, gaps from another timeframe, the confluence filter, colour settings, alerts. The structure behind the labels is worked out (the order blocks need it), so labels could be added later without changing the rules.

## Licence

LuxAlgo publish the script under CC BY-NC-SA 4.0. `smc.js` is a derivative, so it carries the credit and the same licence in its header, and the dialog credits LuxAlgo with links. The licence allows this as long as the app is not used commercially. It covers `smc.js` only.

## No look-ahead

As with the other indicators ([0014](0014-indicators-and-replay-speed.md)), it reads only the chart's candles, which in a replay are the revealed ones. A swing pivot is only known 50 candles after it (the script's `high[size] > ta.highest(size)`), and an order block appears on the candle whose close breaks structure. The last candle may be forming: it is worked out on a copy of the state, as TradingView recalculates its live bar, so a block or gap can appear and go again while the candle forms, and settles when it closes.

Two places where the port follows the script's behaviour exactly, though it looks odd:
- Removing mitigated blocks inside `for [i, x] in array` skips the block after a removed one until the next candle. `removeWhere` does the same.
- A volatile candle (range at least twice the ATR) has its high and low swapped, so it is never picked as an extreme; such a block is drawn between the two prices.

Fair value gap boxes run from candle 2 to `extend` candles past candle 3 by index. The script extends by `extend` times the last bar's duration, which over a weekend gap reaches further; by index the box always covers the same number of candles.

## Speed and tests

The state after every closed candle is kept, so a replay step forward works out one candle (0.002 ms measured in the browser). A step back, another timeframe or new settings start again from the first candle: 25 ms over 21,000 candles.

`web/tests/smc.test.mjs`: a replay played candle by candle equals a full calculation at every 50th step and after a step back; changing hidden candles changes nothing; blocks are newest first and limited to the number asked for; a hand-built fair value gap is found and then removed when filled; damaged settings fall back to the defaults. There is no reference copy to hold the port to (Pine Script cannot be run here), so the rules were checked by reading the script line by line.

## Not yet done

BOS/CHoCH labels and the other parts listed above; checking the blocks against TradingView on the same EURUSD candles (the broker feed differs, so they would not match exactly anyway).
