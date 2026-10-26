# 0019: After a passed challenge, a funded account: payouts on request, and the journey's net

- **Date:** 26 Oct 2026
- **Status:** accepted
- **Decided by:** Yuvraj Sharma (the question: "after passing, can I actually earn in the funded stage?"; the rules of his firm), with Claude on the design

## The journey

One step, as Yuvraj's firm runs it: **Phase 1 → funded**. Each stage is its own backtest; the funded one is linked to the challenge it continues (`stage: "funded"`, `parentId`, `parentJournal` in the save).

- **Phase 1** is challenge mode (decision 0009) with Yuvraj's account: the **"Phase 1 · 5K"** preset sets $5,000, a 10% target ($500), 3% daily loss ($150), a $300 maximum loss (6%, fixed floor), a $59 fee and leverage 1:30. The fee is only used in the results.
- **Funded**: a passed challenge shows **Go funded ▸** in Backtests (once). The funded account starts **on the candle the challenge passed on**, with the same account settings, journal, strategy and version: the true continuation, on candles not yet seen. Its rules default to Yuvraj's firm and can be changed per account: daily loss 3%, maximum loss 6% (fixed), **90% profit split**, payouts every **14 days** with trades on at least **5 days**, leverage 1:30.

## Payouts are requested, not automatic

`funded.js` checks the same losses as a challenge, without a target, and allows a payout only when the cycle has passed (14 days since the start or the last payout), there were enough trading days, the balance is above the start and nothing is open or waiting (a market order waits for the next candle, so a just-placed order also blocks it). **Request payout** in the trading panel is disabled with the reason until then.

A payout withdraws everything above the starting balance: the split is the trader's, the rest the firm's, and the balance is back at the start; the loss floor stays where it was. It is an action ("payout") like an order, saved with its time and repeated when the run is rebuilt, so a resumed account pays out on the same candles; the rebuild also checks that the payouts come out the same. Taking profit must not count as a loss for the daily limit, so the payout also comes off the balance the day started with.

## Leverage

With a leverage in the rules (challenge or funded), an order needing more margin than is free (equity minus the margin of open trades and waiting orders) is refused. At 1:30 one lot of EURUSD at 1.16 needs about $3,870, so a $5,000 account holds about 1.2 lots. Margin is `lots × price × $ per point ÷ leverage`, in the account's dollars. Without a leverage (0) nothing changes from before.

## Results

- **Backtests:** a funded run shows "FUNDED (or LOST) · N payouts · $X to you"; its challenge shows "PASSED → funded".
- **Analytics** (one funded run picked): the balance graph steps down at each payout, Traded P&L and Paid to you beside it, a payouts table, and paid to you − the challenge's fee = net.
- **Strategies:** a **Prop-firm journey** per strategy: challenges, passed, funded, got paid, and **net per challenge bought** (every payout to you, less every fee, divided by the challenges). That is the answer to whether a strategy earns once funded; a few journeys make a noisy average.

## Not done

Two-step challenges (a Phase 2 between) are not chained, although challenge mode can still run one; consistency rules, scaling plans, trailing drawdown and partial payouts are not modelled.
