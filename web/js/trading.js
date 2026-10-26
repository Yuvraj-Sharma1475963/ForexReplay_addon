// Connects the replay clock to the trading engine.
//
// * Every M5 candle the clock reveals for the first time is fed to the broker,
//   once and in order, whatever timeframe is on screen. So fills, stops and
//   targets are always resolved at 5-minute detail.
// * Orders are accepted only while the replay is live (not while looking back
//   at history), so you cannot enter on a move you have already watched.
//   The same goes for closing, moving a stop or anything else that changes a trade.
// * The account (account.js) turns the engine's price results into lots and dollars.
// * Every action that changes the run (an order, a close, a stop move, a settings
//   change) is written to `actions` with the time of the live candle. The engine
//   gives the same result for the same candles and actions, so a saved run is
//   rebuilt by repeating them (see backtest.js) rather than by storing its insides.
// * In challenge mode (challenge.js) the prop-firm rules are checked after every
//   M5 candle, at that candle's worst prices. They depend only on candles and
//   actions, so a rebuilt run fails or passes on the same candle as the original.
// * A funded account (funded.js) is checked the same way, without a target. Its payouts
//   are actions too ("payout"); what they withdrew comes off the balance.
// * With a leverage in the rules, an order needing more margin than is free is refused.

import { Account, DEFAULT_SETTINGS, formatMoney, LOT_UNITS } from "./account.js";
import { Broker, InvalidOrder, OrderType, Side, Status } from "./broker.js";
import { Challenge, CHALLENGE_EXIT, Outcome } from "./challenge.js";
import { cleanFundedRules, FundedAccount } from "./funded.js";

export class Trading {
  /**
   * @param {object} options { m5: Candles, clock: ReplayClock, pipPoints, pointValue, settings, challenge, onChange() }
   *   pointValue: dollars per point per lot. settings: account settings (see account.js).
   *   challenge: challenge rules (see challenge.js) for the runs this starts, or null.
   */
  constructor({ m5, clock, pipPoints = 10, pointValue = 1, settings = DEFAULT_SETTINGS, challenge = null, onChange = () => {} }) {
    this.m5 = m5;
    this.clock = clock;
    this.pipPoints = pipPoints;
    this.account = new Account(settings, pointValue);
    this.minSpreadPoints = Math.round(this.account.settings.minSpreadPips * pipPoints);
    this.onChange = onChange;
    this.broker = this.newBroker();
    this.actions = []; // [{ at: UTC time of the live candle, kind, ... }] in the order they happened
    this.startSettings = { ...this.account.settings }; // the account settings the run started with
    this.withdrawn = 0; // dollars paid out of a funded account so far
    this.challengeRules = challenge; // rules for the next run; changed by the panel between replays
    this.challenge = this.newChallenge();
    clock.onReveal((from, to) => this.reveal(from, to));
  }

  newBroker() {
    return new Broker({ spreadPoints: this.minSpreadPoints, onClose: () => {}, onFill: () => {} });
  }

  /** The prop-firm rules of a new run: a challenge, a funded account (rules.kind "funded") or none. */
  newChallenge() {
    const rules = this.challengeRules;
    if (!rules || !rules.enabled) return null;
    if (rules.kind === "funded") {
      const startTime = this.m5.time[Math.max(1, this.clock.position) - 1]; // the candle the account starts on
      return new FundedAccount(cleanFundedRules(rules), this.account.settings.startingBalance, startTime);
    }
    return new Challenge(rules, this.account.settings.startingBalance);
  }

  get funded() { return this.challenge && this.challenge.kind === "funded" ? this.challenge : null; }

  /** Start a fresh run (called when a new replay starts). */
  reset() {
    this.broker = this.newBroker();
    this.account.reset();
    this.actions = [];
    this.startSettings = { ...this.account.settings };
    this.withdrawn = 0;
    this.challenge = this.newChallenge();
    this.onChange();
  }

  /** Take over the engine, account and action log of a run rebuilt by backtest.js. */
  adopt(rebuilt) {
    this.broker = rebuilt.broker;
    this.account = rebuilt.account;
    this.actions = rebuilt.actions;
    this.startSettings = rebuilt.startSettings;
    this.minSpreadPoints = rebuilt.minSpreadPoints;
    this.challengeRules = rebuilt.challengeRules;
    this.challenge = rebuilt.challenge;
    this.withdrawn = rebuilt.withdrawn;
    this.onChange();
  }

  /** Write down an action that just succeeded, at the live candle (the furthest the replay has reached). */
  record(kind, data = {}) {
    const at = this.m5.time[this.clock.furthest - 1];
    this.actions.push({ at, kind, ...data });
    if (!this.challenge) return;
    if (kind === "place") this.challenge.traded(at);
    this.checkChallenge(this.clock.furthest - 1, false); // a close can bank the target
  }

  /** Repeat a recorded action (used when a saved run is rebuilt). */
  apply(action) {
    switch (action.kind) {
      case "place": return this.place(action.order);
      case "close": return this.closeTrade(action.id);
      case "cancel": return this.cancelOrder(action.id);
      case "modify": return this.modifyTrade(action.id, action.changes);
      case "partial": return this.partialClose(action.id, action.percent);
      case "closeAll": return this.closeAll();
      case "settings": return this.updateSettings(action.settings);
      case "payout": return this.requestPayout();
      default: throw new InvalidOrder(`Unknown action "${action.kind}".`);
    }
  }

  /** Change account settings (starting balance, risk %, commission, minimum spread...). */
  updateSettings(changes) {
    if (this.challenge && this.clock.active && "startingBalance" in changes &&
        Number(changes.startingBalance) !== this.account.settings.startingBalance) {
      throw new InvalidOrder("The starting balance cannot change during a challenge: its limits are measured from it.");
    }
    const settings = this.account.update(changes);
    this.minSpreadPoints = Math.round(settings.minSpreadPips * this.pipPoints);
    this.broker.spread = this.minSpreadPoints;
    if (this.clock.active) this.record("settings", { settings: { ...settings } }); // they change sizes and spreads from here on
    this.onChange();
    return settings;
  }

  /**
   * Make the balance exactly `amount` dollars. Outside a replay that is the starting balance of the
   * next run. During a run the starting balance is moved so that it plus what has been banked equals
   * `amount`; it is recorded like any settings change, so a resumed backtest comes back the same.
   * Refused during a challenge (its limits are measured from the starting balance).
   */
  setBalance(amount) {
    const value = Math.round(Number(amount) * 100) / 100;
    const [low, high] = [1, 1000000000];
    if (!Number.isFinite(value) || value < low || value > high) {
      throw new InvalidOrder("Type a balance between $1 and $1,000,000,000.");
    }
    const banked = this.balance - this.account.settings.startingBalance;
    const start = Math.round((value - banked) * 100) / 100;
    if (start < low) throw new InvalidOrder(`This run has banked ${banked.toFixed(2)} dollars, so the balance cannot go that low.`);
    return this.updateSettings({ startingBalance: start });
  }

  reveal(from, to) {
    const m = this.m5;
    for (let i = from; i < to; i++) {
      if (this.challenge) this.challenge.beginCandle(m.time[i], this.balance);
      this.broker.processCandle(i, m.open[i], m.high[i], m.low[i], m.spread[i]);
      if (this.challenge && this.challenge.running) this.checkChallenge(i, true);
    }
    this.onChange();
  }

  /**
   * Check the challenge rules at M5 candle `i`: at its worst prices after the engine
   * has processed it (`worst`), or at its close after an action. Ends the run on a breach or a pass.
   */
  checkChallenge(i, worst) {
    const m = this.m5;
    const spread = Math.max(this.minSpreadPoints, m.spread[i]);
    const open = this.broker.openTrades;
    let equityLow = this.balance;
    for (const t of open) {
      const bid = !worst ? m.close[i] : (t.side === Side.BUY ? m.low[i] : m.high[i]);
      equityLow += this.account.unrealized(t, bid, spread);
    }
    const outcome = this.challenge.check(m.time[i], { balance: this.balance, equityLow, open: open.length });
    if (outcome === Outcome.FAILED) {
      for (const t of open) this.broker.close(t, i, m.close[i], CHALLENGE_EXIT, spread);
    }
    if (outcome) for (const t of this.broker.pendingOrders) this.broker.cancel(t);
  }

  /** Index of the last revealed M5 candle: "now". */
  get nowIndex() { return this.clock.position - 1; }

  /** Current bid: the close of the last revealed candle. */
  get bid() { return this.m5.close[this.nowIndex]; }

  /** Spread that applies right now, in points. */
  get spread() { return Math.max(this.minSpreadPoints, this.m5.spread[this.nowIndex]); }

  get ask() { return this.bid + this.spread; }

  /** Why trading is not possible right now, or null when it is. */
  get blockedReason() {
    if (!this.clock.active) return "Start a replay to trade.";
    if (this.funded && !this.funded.running) {
      const t = this.funded.totals();
      return `Funded account lost: ${this.funded.reason}, after ${t.payouts} payout${t.payouts === 1 ? "" : "s"} ` +
        `(${formatMoney(t.toYou)} to you). This run is over.`;
    }
    if (this.challenge && !this.challenge.running) {
      return `Challenge ${this.challenge.outcome === Outcome.PASSED ? "passed" : "failed"}: ${this.challenge.reason}. ` +
        (this.challenge.outcome === Outcome.PASSED ? "Continue it as a funded account from Backtests (Go funded)." : "This run is over; start a new replay to try again.");
    }
    if (!this.clock.live) return "You are viewing history. Press End to return to the live candle.";
    if (this.clock.finished) return "The replay has reached the end of the data.";
    return null;
  }

  ensureCanTrade() {
    const reason = this.blockedReason;
    if (reason) throw new InvalidOrder(reason);
  }

  /** Entry price an order would be planned at right now: the quote for a market order, its own price otherwise. */
  plannedEntry({ side, type, price }) {
    return type === "market" ? (side === Side.BUY ? this.ask : this.bid) : price;
  }

  /**
   * Size an order before placing it: { units, riskMoney, commission, riskPercent } or { error }.
   * Sized from the balance (closed results only), as position-size calculators do.
   */
  preview({ side, type, price, stopLoss }) {
    const entry = this.plannedEntry({ side, type, price });
    return this.account.size(Math.abs(entry - stopLoss), this.balance);
  }

  /**
   * Place an order. Prices are in points.
   * order = { side, type: "market" | "pending", price?, stopLoss, takeProfit }
   */
  place({ side, type, price, stopLoss, takeProfit }) {
    this.ensureCanTrade();
    for (const [name, value] of [["Stop loss", stopLoss], ["Take profit", takeProfit], ...(type === "pending" ? [["Entry price", price]] : [])]) {
      if (!Number.isInteger(value) || value <= 0) throw new InvalidOrder(`${name} is not a valid price.`);
    }
    Broker.validate(side, this.plannedEntry({ side, type, price }), stopLoss, takeProfit); // wrong-side prices first
    const sized = this.preview({ side, type, price, stopLoss });
    if (sized.error) throw new InvalidOrder(sized.error);
    this.checkMargin(sized.units, this.plannedEntry({ side, type, price }));
    const trade = type === "market"
      ? this.broker.marketOrder(side, stopLoss, takeProfit, this.nowIndex, this.bid, this.spread)
      : this.broker.pendingOrder(side, price, stopLoss, takeProfit, this.nowIndex, this.bid, this.spread);
    this.account.attach(trade, sized);
    this.record("place", { order: { side, type, ...(type === "pending" ? { price } : {}), stopLoss, takeProfit } });
    this.onChange();
    return trade;
  }

  /** Dollars of margin `units` (0.01 lots) need at a price in points, at the leverage of the run's rules (0 when there is none). */
  margin(units, points) {
    const leverage = this.challenge ? this.challenge.rules.leverage : 0;
    return leverage > 0 ? (units / LOT_UNITS) * points * this.account.pointValue / leverage : 0;
  }

  /** Margin held by open trades and waiting orders. */
  get usedMargin() {
    return this.broker.trades.filter((t) => t.isActive)
      .reduce((sum, t) => sum + this.margin(this.account.units(t), t.entryPrice ?? t.plannedEntry), 0);
  }

  /** Refuse an order whose margin is more than the free margin (equity minus margin in use), at the rules' leverage. */
  checkMargin(units, entry) {
    const leverage = this.challenge ? this.challenge.rules.leverage : 0;
    if (!(leverage > 0)) return;
    const need = this.margin(units, entry);
    const free = this.equity - this.usedMargin;
    if (need > free + 1e-9) {
      throw new InvalidOrder(`Not enough margin at 1:${leverage}: this order needs ${formatMoney(need)}, free margin is ${formatMoney(free)}. ` +
        "Use a smaller size, a wider stop or a lower risk %.");
    }
  }

  /**
   * Take a payout from a funded account (funded.js): only when its rules allow it, at the live candle.
   * Returns { time, amount, toYou, toFirm }.
   */
  requestPayout() {
    this.ensureCanTrade();
    const f = this.funded;
    if (!f) throw new InvalidOrder("Payouts are for funded accounts.");
    const at = this.m5.time[this.clock.furthest - 1];
    const why = f.payoutBlocked(at, { balance: this.balance, open: this.activeCount }); // open trades and waiting orders
    if (why) throw new InvalidOrder(why);
    const payout = f.payout(at, this.balance);
    this.withdrawn = Math.round((this.withdrawn + payout.amount) * 100) / 100;
    this.record("payout");
    this.onChange();
    return payout;
  }

  find(id) {
    const trade = this.broker.trades.find((t) => t.id === id);
    if (!trade) throw new InvalidOrder(`There is no trade #${id}.`);
    return trade;
  }

  closeTrade(id) {
    this.ensureCanTrade();
    this.broker.close(this.find(id), this.nowIndex, this.bid, undefined, this.spread);
    this.record("close", { id });
    this.onChange();
  }

  cancelOrder(id) {
    this.ensureCanTrade();
    this.broker.cancel(this.find(id));
    this.record("cancel", { id });
    this.onChange();
  }

  /**
   * Move the stop loss, take profit or (pending orders) entry price. Prices in points.
   * A pending order that was sized from risk % is re-sized, so it still risks that %.
   */
  modifyTrade(id, changes) {
    this.ensureCanTrade();
    const trade = this.find(id);
    const names = { stopLoss: "Stop loss", takeProfit: "Take profit", price: "Entry price" };
    for (const [key, value] of Object.entries(changes)) {
      if (!Number.isInteger(value) || value <= 0) throw new InvalidOrder(`${names[key] || key} is not a valid price.`);
    }
    const size = this.account.sizeOf(trade);
    let sized = null;
    if (trade.status === Status.PENDING && size.riskPercent !== null) {
      const entry = trade.orderType === OrderType.MARKET ? trade.plannedEntry : (changes.price ?? trade.orderPrice);
      const stop = changes.stopLoss ?? trade.stopLoss;
      Broker.validate(trade.side, entry, stop, changes.takeProfit ?? trade.takeProfit);
      sized = this.account.size(Math.abs(entry - stop), this.balance);
      if (sized.error) throw new InvalidOrder(sized.error);
    }
    this.broker.modify(trade, this.bid, { price: null, ...changes }, this.spread);
    if (sized) size.units = sized.units;
    this.record("modify", { id, changes: { ...changes } });
    this.onChange();
    return trade;
  }

  /** Move the stop of an open trade to its entry price, so the worst case is a scratch (minus commission). */
  breakeven(id) {
    const trade = this.find(id);
    if (trade.status !== Status.OPEN) throw new InvalidOrder("Only an open trade can be moved to breakeven.");
    if (trade.stopLoss === trade.entryPrice) throw new InvalidOrder(`#${id} is already at breakeven.`);
    try {
      return this.modifyTrade(id, { stopLoss: trade.entryPrice });
    } catch (err) {
      if (err instanceof InvalidOrder && !this.blockedReason) {
        throw new InvalidOrder(`#${id} is not in profit, so its stop cannot go to the entry price yet.`);
      }
      throw err;
    }
  }

  /** Close `percent` of what is still open, in whole 0.01 lots. */
  partialClose(id, percent) {
    this.ensureCanTrade();
    const trade = this.find(id);
    if (trade.status !== Status.OPEN) throw new InvalidOrder("Only an open trade can be partly closed.");
    const part = this.account.partial(trade, percent);
    if (part.error) throw new InvalidOrder(part.error);
    this.broker.partialClose(trade, part.fraction, this.nowIndex, this.bid, this.spread);
    this.record("partial", { id, percent });
    this.onChange();
    return part;
  }

  /** Close every open trade at market and cancel every pending order. */
  flatten() {
    for (const t of this.broker.openTrades) this.broker.close(t, this.nowIndex, this.bid, undefined, this.spread);
    for (const t of this.broker.pendingOrders) this.broker.cancel(t);
    this.onChange();
  }

  /** The "Close all" button: the same as flatten, but only while the replay is live. */
  closeAll() {
    this.ensureCanTrade();
    this.flatten();
    this.record("closeAll"); // after the closes, so a challenge can see the target banked
  }

  // ----- money -------------------------------------------------------------
  /** Starting balance plus everything banked so far, minus what a funded account paid out. */
  get balance() { return this.account.balance(this.broker.trades) - this.withdrawn; }

  /** Balance plus the floating result of open trades. */
  get equity() {
    return this.clock.active ? this.account.equity(this.broker.trades, this.bid, this.spread) - this.withdrawn : this.balance;
  }

  /** What a trade is worth in dollars right now (or was when it closed), after commission. */
  money(trade) {
    return trade.status === Status.OPEN ? this.account.net(trade, this.bid, this.spread) : this.account.realized(trade);
  }

  get activeCount() {
    return this.broker.trades.filter((t) => t.isActive).length;
  }

  /** Floating result of an open trade in R, at the current price. */
  floatingR(trade) {
    if (trade.status !== Status.OPEN) return null;
    return trade.floatingPoints(this.bid, this.spread) / trade.plannedRisk;
  }

  pips(points) {
    return points / this.pipPoints;
  }

  summary() {
    const closed = this.broker.closedTrades;
    const results = closed.map((t) => t.resultR);
    return {
      open: this.broker.openTrades.length,
      pending: this.broker.pendingOrders.length,
      closed: closed.length,
      wins: results.filter((r) => r > 0.05).length,
      losses: results.filter((r) => r < -0.05).length,
      totalR: results.reduce((a, b) => a + b, 0),
      totalMoney: closed.reduce((a, t) => a + this.account.realized(t), 0),
    };
  }
}

export { InvalidOrder, OrderType, Side, Status };
