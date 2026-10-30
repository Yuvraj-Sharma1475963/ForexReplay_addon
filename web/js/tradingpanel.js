// The trading panel on the right: account, order ticket, active trades, closed trades.
// All logic lives in trading.js / broker.js / account.js; this file only reads
// the form, calls them, and draws the result.

import { formatLots, formatMoney, formatSignedMoney, saveSettings } from "./account.js";
import { ExitReason, OrderType } from "./broker.js";
import { CHALLENGE_EXIT, cleanRules, Outcome, PRESETS, saveRules } from "./challenge.js";
import { InvalidOrder, Side, Status } from "./trading.js";
import { formatDateTime } from "./time.js";

const REASON_LABEL = {
  [ExitReason.STOP_LOSS]: "stop loss",
  [ExitReason.TAKE_PROFIT]: "take profit",
  [ExitReason.MANUAL]: "closed by you",
  [CHALLENGE_EXIT]: "closed: challenge failed",
};
const PICK_LABEL = { price: "entry price", stopLoss: "stop loss", takeProfit: "take profit" };

export class TradingPanel {
  /**
   * @param {HTMLElement} root   the panel element
   * @param {object} options { trading, m5, digits, onPickChange(label | null), notes: TradeNotes, onPickTrade(id),
   *   planCheck({ entry, stopLoss, takeProfit }) -> warnings from the ADR plan,
   *   undo: { limit, run() -> message } to take back the most recent trade (main.js) }
   */
  constructor(root, { trading, m5, digits, onPickChange, notes = null, onPickTrade = () => {}, planCheck = null, undo = null }) {
    this.root = root;
    this.trading = trading;
    this.m5 = m5;
    this.digits = digits;
    this.scale = 10 ** digits;
    this.onPickChange = onPickChange;
    this.notes = notes;
    this.onPickTrade = onPickTrade;
    this.planCheck = planCheck;
    this.pickedTrade = null; // the trade whose journal is open
    this.side = Side.BUY;
    this.type = "market";
    this.pickTarget = null; // which field the next chart click fills in
    this.touched = false; // has the user edited the prices since the last reset?
    this.message = { text: "", tone: "" };

    this.el = (id) => root.querySelector(`#${id}`);
    this.undo = undo;
    this.undoArmed = false;
    this.inputs = { price: this.el("order-price"), stopLoss: this.el("order-sl"), takeProfit: this.el("order-tp") };

    root.addEventListener("click", (event) => this.handleClick(event));
    root.addEventListener("input", (event) => {
      if (Object.values(this.inputs).includes(event.target)) {
        this.touched = true;
        this.renderTicket();
      }
    });
    // Settings: each input writes one account setting, which is saved in the browser.
    const setting = (id, key) => this.el(id).addEventListener("change", (event) => {
      try {
        saveSettings(trading.updateSettings({ [key]: event.target.value }));
      } catch (err) {
        if (!(err instanceof InvalidOrder)) throw err;
        this.say(err.message, "bad");
      }
      this.renderSettings(); // show what was actually stored (a rejected value snaps back)
    });
    setting("set-balance", "startingBalance");
    // Click the balance to type a new one (see Trading.setBalance for what it means during a run).
    const balanceCell = root.querySelector(".balance-cell");
    const balanceInput = this.el("balance-input");
    const balanceText = this.el("account-balance");
    const closeBalance = () => { balanceInput.hidden = true; balanceText.hidden = false; };
    balanceCell.addEventListener("click", () => {
      if (!balanceInput.hidden) return;
      balanceInput.value = this.trading.balance.toFixed(2);
      balanceInput.hidden = false;
      balanceText.hidden = true;
      balanceInput.focus();
      balanceInput.select();
    });
    balanceInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); closeBalance(); return; }
      if (event.key !== "Enter") return;
      event.preventDefault();
      try {
        const settings = this.trading.setBalance(balanceInput.value);
        saveSettings(settings);
        this.say(`Balance set to ${formatMoney(this.trading.balance)}.`, "ok");
      } catch (err) {
        if (!(err instanceof InvalidOrder)) throw err;
        this.say(err.message, "bad");
      }
      closeBalance();
      this.renderSettings();
      this.render();
    });
    balanceInput.addEventListener("blur", closeBalance);
    setting("set-commission", "commissionPerLot");
    setting("order-spread", "minSpreadPips");
    this.el("order-size").addEventListener("change", (event) => {
      const key = trading.account.settings.sizeMode === "risk" ? "riskPercent" : "fixedLots";
      saveSettings(trading.updateSettings({ [key]: event.target.value }));
      this.renderSettings();
    });
    // Challenge rules: chosen between replays, fixed for the length of one.
    this.el("challenge-presets").innerHTML = Object.entries(PRESETS)
      .map(([id, p]) => `<button class="plain small" data-preset="${id}" title="${p.title || `${p.targetPercent}% target, ${p.dailyPercent}% daily, ${p.maxPercent}% max loss`}">${p.label}</button>`).join("");
    const challengeInputs = { targetPercent: "challenge-target", dailyPercent: "challenge-daily", maxPercent: "challenge-max", fee: "challenge-fee", leverage: "challenge-leverage" };
    const setRules = (changes) => {
      const rules = cleanRules({ ...trading.challengeRules, ...changes });
      trading.challengeRules = rules;
      saveRules(rules);
      this.renderChallenge();
    };
    this.el("challenge-on").addEventListener("change", (event) => setRules({ enabled: event.target.checked }));
    for (const [key, id] of Object.entries(challengeInputs)) {
      this.el(id).addEventListener("change", (event) => setRules({ [key]: event.target.value }));
    }
    this.el("challenge-presets").addEventListener("click", (event) => {
      const button = event.target.closest("[data-preset]");
      if (!button) return;
      const { targetPercent, dailyPercent, maxPercent, fee = 0, leverage = 0, startingBalance } = PRESETS[button.dataset.preset];
      setRules({ enabled: true, targetPercent, dailyPercent, maxPercent, fee, leverage });
      if (startingBalance && !trading.clock.active) { // the account size is part of the preset
        saveSettings(trading.updateSettings({ startingBalance }));
        this.renderSettings();
        this.render();
      }
    });
    this.el("payout-request").addEventListener("click", () => {
      try {
        const p = trading.requestPayout();
        this.say(`Payout of ${formatMoney(p.amount)}: ${formatMoney(p.toYou)} to you, ${formatMoney(p.toFirm)} to the firm. The balance is back at the start.`, "ok");
      } catch (err) {
        if (!(err instanceof InvalidOrder)) throw err;
        this.say(err.message, "bad");
      }
    });
    this.renderSettings();
    this.render();
  }

  // ----- helpers ----------------------------------------------------------
  toPoints(text) {
    const value = Number(text);
    return text.trim() === "" || !Number.isFinite(value) ? NaN : Math.round(value * this.scale);
  }

  price(points) { return (points / this.scale).toFixed(this.digits); }
  pips(points) { return (points / this.trading.pipPoints).toFixed(1); }
  r(value) { return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`; }
  tone(value) { return value >= 0 ? "up" : "down"; }

  /** Put the stored settings into their inputs. */
  renderSettings() {
    const s = this.trading.account.settings;
    this.el("set-balance").value = s.startingBalance;
    this.el("set-commission").value = s.commissionPerLot;
    this.el("order-spread").value = s.minSpreadPips;
    const size = this.el("order-size");
    const risk = s.sizeMode === "risk";
    size.value = risk ? s.riskPercent : s.fixedLots.toFixed(2);
    size.step = risk ? "0.25" : "0.01";
    size.min = "0.01";
    size.title = risk ? "% of your balance lost if the stop is hit" : "Lots (1 lot = 100,000 units)";
    this.root.querySelectorAll("[data-size]").forEach((b) => b.classList.toggle("active", b.dataset.size === s.sizeMode));
  }

  /** Sensible starting prices: stop 10 pips away, target 20 pips away. */
  fillDefaults() {
    if (this.trading.blockedReason) return;
    const dir = this.side === Side.BUY ? 1 : -1;
    const entry = this.side === Side.BUY ? this.trading.ask : this.trading.bid;
    const pip = this.trading.pipPoints;
    this.inputs.price.value = this.price(entry);
    this.inputs.stopLoss.value = this.price(entry - dir * 10 * pip);
    this.inputs.takeProfit.value = this.price(entry + dir * 20 * pip);
    this.touched = false;
  }

  setPick(target) {
    this.pickTarget = target;
    this.onPickChange(target ? PICK_LABEL[target] : null);
    this.root.querySelectorAll("[data-pick]").forEach((b) => b.classList.toggle("active", b.dataset.pick === target));
  }

  /** Called by the chart when the user clicks it while a pick is waiting. */
  receivePrice(points) {
    if (!this.pickTarget) return false;
    this.inputs[this.pickTarget].value = this.price(points);
    if (this.pickTarget === "price") this.type = "pending";
    this.touched = true;
    this.setPick(null);
    this.render();
    return true;
  }

  /** Fill the ticket from a long/short position drawing. Prices in points. Nothing is placed until you press the button. */
  loadOrder({ side, price, stopLoss, takeProfit }) {
    this.side = side;
    this.type = "pending";
    this.inputs.price.value = this.price(price);
    this.inputs.stopLoss.value = this.price(stopLoss);
    this.inputs.takeProfit.value = this.price(takeProfit);
    this.touched = true;
    this.setPick(null);
    this.say("Copied from the drawing. Check it, then place the order.");
    this.render();
  }

  say(text, tone = "") {
    this.message = { text, tone };
    const box = this.el("order-message");
    box.textContent = text;
    box.className = `order-message ${tone}`;
  }

  // ----- actions ----------------------------------------------------------
  handleClick(event) {
    const target = event.target.closest("button");
    if (!target) {
      const row = event.target.closest("[data-journal]"); // a click on a trade (not on its buttons) opens its journal
      if (row) this.onPickTrade(Number(row.dataset.journal));
      return;
    }
    if (target.dataset.side) {
      this.side = target.dataset.side;
      this.fillDefaults();
      this.say("");
      this.render();
    } else if (target.dataset.type) {
      this.type = target.dataset.type;
      this.render();
    } else if (target.dataset.size) {
      saveSettings(this.trading.updateSettings({ sizeMode: target.dataset.size }));
      this.renderSettings();
      this.render();
    } else if (target.id === "undo-trade") {
      this.undoClick(target);
    } else if (target.id === "close-all") {
      this.attempt(() => this.trading.closeAll());
    } else if (target.dataset.breakeven) {
      this.attempt(() => this.trading.breakeven(Number(target.dataset.breakeven)), "Stop moved to the entry price.");
    } else if (target.dataset.partial) {
      const [id, percent] = target.dataset.partial.split(":").map(Number);
      this.attempt(() => {
        const part = this.trading.partialClose(id, percent);
        return `Closed ${formatLots(part.units)} lots of #${id} at the current price.`;
      });
    } else if (target.dataset.pick) {
      this.setPick(this.pickTarget === target.dataset.pick ? null : target.dataset.pick);
    } else if (target.id === "order-place") {
      this.place();
    } else if (target.dataset.close) {
      this.attempt(() => this.trading.closeTrade(Number(target.dataset.close)));
    } else if (target.dataset.cancel) {
      this.attempt(() => this.trading.cancelOrder(Number(target.dataset.cancel)));
    }
  }

  /** Run an action from a button; show `done` (or what the action returns) on success, the reason on refusal. */
  attempt(action, done = "") {
    try {
      const result = action();
      this.say(typeof result === "string" ? result : done, "ok");
    } catch (err) {
      if (!(err instanceof InvalidOrder)) throw err;
      this.say(err.message, "bad");
    }
  }

  place() {
    try {
      const trade = this.trading.place({
        side: this.side,
        type: this.type,
        price: this.type === "pending" ? this.toPoints(this.inputs.price.value) : undefined,
        stopLoss: this.toPoints(this.inputs.stopLoss.value),
        takeProfit: this.toPoints(this.inputs.takeProfit.value),
      });
      const what = trade.orderType === OrderType.MARKET
        ? "market order placed; it fills at the next candle's open"
        : `${trade.orderType.toLowerCase()} order placed at ${this.price(trade.orderPrice)}`;
      this.touched = false; // the next order starts again from prices around the market
      this.say(`#${trade.id} ${trade.side} ${this.lots(trade)} lots: ${what}.`, "ok");
    } catch (err) {
      if (!(err instanceof InvalidOrder)) throw err;
      this.say(err.message, "bad");
    }
  }

  lots(trade) { return formatLots(this.trading.account.units(trade)); }

  // ----- drawing ----------------------------------------------------------
  render() {
    this.renderAccount();
    this.renderChallenge();
    this.renderTicket();
    this.renderTrades();
  }

  renderAccount() {
    const t = this.trading;
    const start = t.account.settings.startingBalance;
    const equity = t.equity;
    const run = equity - start;
    this.el("account-balance").textContent = formatMoney(t.balance);
    this.el("account-equity").textContent = formatMoney(equity);
    const cell = this.el("account-run");
    cell.textContent = `${formatSignedMoney(run)} (${run >= 0.005 ? "+" : ""}${(run / start * 100).toFixed(2)}%)`;
    cell.className = Math.abs(run) < 0.005 ? "" : this.tone(run);
    cell.title = cell.textContent;
  }

  /** The challenge box: its rules before a replay; its progress during one (or a funded account's). */
  renderChallenge() {
    const t = this.trading;
    const inReplay = t.clock.active;
    if (inReplay && t.funded) { this.renderFunded(); return; }
    this.el("payout-row").hidden = true;
    this.el("meter-target-label").textContent = "Profit target";
    this.el("challenge-on").closest("label").lastChild.textContent = " Challenge mode";
    const c = inReplay ? t.challenge : null;
    const rules = c ? c.rules : cleanRules(t.challengeRules);
    const on = this.el("challenge-on");
    on.checked = c ? true : (!inReplay && rules.enabled);
    on.disabled = inReplay;
    for (const [key, id] of [["targetPercent", "challenge-target"], ["dailyPercent", "challenge-daily"], ["maxPercent", "challenge-max"], ["fee", "challenge-fee"], ["leverage", "challenge-leverage"]]) {
      const input = this.el(id);
      if (document.activeElement !== input) input.value = rules[key];
      input.disabled = inReplay;
    }
    this.el("challenge-presets").hidden = inReplay;
    this.el("challenge-setup").hidden = inReplay && !c;
    this.el("challenge-note").textContent = inReplay
      ? "Rules are fixed for this run."
      : (rules.enabled ? "Applies from the next replay. Days start at 17:00 New York (the broker's midnight)." : "Off: the next replay has no limits.");

    const state = this.el("challenge-state");
    state.textContent = !inReplay ? "" : !c ? "off for this run" : c.outcome;
    state.className = `challenge-state ${c ? c.outcome.toLowerCase() : ""}`;
    this.el("challenge-meters").hidden = !c;
    if (!c) return;

    const equity = t.equity;
    const meter = (id, fraction, text, tone = "") => {
      const bar = this.el(id);
      bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      bar.className = tone;
      this.el(`${id}-text`).textContent = text;
    };
    const danger = (fraction) => (fraction >= 0.8 ? "danger" : "");
    const profit = t.balance - c.start;
    meter("meter-target", profit / (c.target - c.start), `${formatSignedMoney(profit)} of ${formatMoney(c.target - c.start)}`, "good");
    const today = Math.max(0, c.dayStartBalance - equity);
    meter("meter-daily", today / c.dailyLimit, `${formatMoney(today)} of ${formatMoney(c.dailyLimit)}`, danger(today / c.dailyLimit));
    const down = Math.max(0, c.start - equity);
    const room = c.start - c.floor;
    meter("meter-max", down / room, `${formatMoney(down)} of ${formatMoney(room)}`, danger(down / room));
    const s = c.summary();
    const days = `${s.tradingDays} trading day${s.tradingDays === 1 ? "" : "s"}`;
    this.el("challenge-detail").textContent = c.outcome === Outcome.RUNNING
      ? `Worst today ${formatMoney(s.worstToday)} · lowest equity ${formatMoney(s.lowestEquity)} · ${days}`
      : `${c.outcome === Outcome.PASSED ? "Passed" : "Failed"} on ${formatDateTime(c.endTime)} IST: ${c.reason}. ` +
        `Worst day ${formatMoney(s.worstDay)} · lowest equity ${formatMoney(s.lowestEquity)} · ${days}.`;
  }

  /** The same box during a funded run: losses against the limits, the payout cycle, and Request payout. */
  renderFunded() {
    const t = this.trading;
    const f = t.funded;
    const s = f.summary();
    this.el("challenge-on").closest("label").lastChild.textContent = " Funded account";
    const on = this.el("challenge-on");
    on.checked = true;
    on.disabled = true;
    this.el("challenge-setup").hidden = true;
    this.el("challenge-meters").hidden = false;
    const state = this.el("challenge-state");
    state.textContent = f.running ? "FUNDED" : "LOST";
    state.className = `challenge-state ${f.running ? "funded" : "lost"}`;
    const meter = (id, fraction, text, tone = "") => {
      const bar = this.el(id);
      bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      bar.className = tone;
      this.el(`${id}-text`).textContent = text;
    };
    const danger = (fraction) => (fraction >= 0.8 ? "danger" : "");
    const now = t.m5.time[t.clock.furthest - 1];
    const waited = Math.min(f.rules.cycleDays, f.daysInCycle(now));
    this.el("meter-target-label").textContent = "Next payout";
    meter("meter-target", waited / f.rules.cycleDays,
      `day ${waited} of ${f.rules.cycleDays} · ${s.cycleTradingDays}/${f.rules.minTradingDays} trading days`, "good");
    const equity = t.equity;
    const today = Math.max(0, f.dayStartBalance - equity);
    meter("meter-daily", today / f.dailyLimit, `${formatMoney(today)} of ${formatMoney(f.dailyLimit)}`, danger(today / f.dailyLimit));
    const down = Math.max(0, f.start - equity);
    const room = f.start - f.floor;
    meter("meter-max", down / room, `${formatMoney(down)} of ${formatMoney(room)}`, danger(down / room));
    const paid = s.payouts ? `${s.payouts} payout${s.payouts === 1 ? "" : "s"}: ${formatMoney(s.toYou)} to you` : "No payout yet";
    this.el("challenge-detail").textContent = f.running
      ? `${paid} · ${f.rules.splitPercent}% split · profit now ${formatSignedMoney(t.balance - f.start)}`
      : `Lost on ${formatDateTime(f.endTime)} IST: ${f.reason}. ${paid}.`;
    const why = f.running && t.clock.active
      ? (t.blockedReason || f.payoutBlocked(now, { balance: t.balance, open: t.activeCount })) : "The account is lost.";
    this.el("payout-row").hidden = false;
    const button = this.el("payout-request");
    button.disabled = !!why;
    button.title = why || `Withdraw ${formatMoney(Math.max(0, t.balance - f.start))}: ${f.rules.splitPercent}% to you`;
    this.el("payout-why").textContent = why || `Ready: ${formatMoney(t.balance - f.start)} above the start.`;
  }

  renderTicket() {
    const t = this.trading;
    const blocked = t.blockedReason;
    this.root.classList.toggle("blocked", !!blocked);
    this.el("order-status").textContent = blocked ||
      `Live · bid ${this.price(t.bid)} · ask ${this.price(t.ask)} · spread ${this.pips(t.spread)} pips`;

    if (!blocked && !this.touched) this.fillDefaults();

    this.root.querySelectorAll("[data-side]").forEach((b) => b.classList.toggle("active", b.dataset.side === this.side));
    this.root.querySelectorAll("[data-type]").forEach((b) => b.classList.toggle("active", b.dataset.type === this.type));
    this.el("order-price-row").hidden = this.type !== "pending";

    const entry = this.type === "pending" ? this.toPoints(this.inputs.price.value)
      : (blocked ? NaN : (this.side === Side.BUY ? t.ask : t.bid));
    const sl = this.toPoints(this.inputs.stopLoss.value);
    const tp = this.toPoints(this.inputs.takeProfit.value);
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    this.el("order-sl-note").textContent = Number.isFinite(risk) ? `${this.pips(risk)} pips risk` : "";
    this.el("order-tp-note").textContent = Number.isFinite(reward) && risk > 0
      ? `${this.pips(reward)} pips · ${(reward / risk).toFixed(2)}R` : "";

    const sizeNote = this.el("order-size-note");
    const sized = blocked || !Number.isFinite(risk)
      ? null : t.account.size(risk, t.balance);
    sizeNote.className = sized && sized.error ? "bad" : "";
    sizeNote.textContent = !sized ? "" : sized.error || `${formatLots(sized.units)} lots · risk ${formatMoney(sized.riskMoney)}` +
      (sized.riskPercent === null ? ` (${(sized.riskMoney / t.balance * 100).toFixed(2)}%)` : "") +
      (sized.commission > 0 ? ` + ${formatMoney(sized.commission)} commission` : "");

    // The ADR plan advises (a stop under minStop, reward/risk under the floor); it never blocks the order.
    const planNote = this.el("order-plan-note");
    const warnings = this.planCheck && !blocked && Number.isFinite(risk) && Number.isFinite(reward)
      ? this.planCheck({ entry, stopLoss: sl, takeProfit: tp }) : [];
    planNote.textContent = warnings.map((w) => `⚠ ${w}`).join(" ");
    planNote.hidden = warnings.length === 0;

    const button = this.el("order-place");
    button.disabled = !!blocked;
    button.textContent = `${this.side === Side.BUY ? "Buy" : "Sell"} ${this.type === "market" ? "at market" : "at price"}`;
    button.className = `order-place ${this.side === Side.BUY ? "buy" : "sell"}`;
  }

  tradeTime(index) {
    return formatDateTime(this.m5.time[index]).split(" ").slice(1).join(" "); // drop the weekday to save space
  }

  /** Small marks after a trade: it has a note or tags, and how many screenshots. */
  marks(trade) {
    if (!this.notes || !this.notes.has(trade.id)) return "";
    const e = this.notes.get(trade.id);
    const written = e.note.trim() || e.tags.length ? "&#9998;" : "";
    const shots = e.screenshots.length ? ` &#128247;${e.screenshots.length}` : "";
    return `<span class="marks" title="${e.tags.join(", ")}">${written}${shots}</span>`;
  }

  rowAttributes(trade) {
    return ` data-journal="${trade.id}"${trade.id === this.pickedTrade ? ' class="picked"' : ""}`;
  }

  setNumber(selector, text, value) {
    const node = this.root.querySelector(selector);
    if (!node) return;
    node.textContent = text;
    node.className = this.tone(value);
  }

  /** "stop loss", or what really happened if the stop had been moved. */
  reason(trade) {
    if (trade.exitReason === ExitReason.STOP_LOSS && trade.stopLoss !== trade.initialStop) {
      return trade.stopLoss === trade.entryPrice ? "breakeven stop" : "moved stop";
    }
    return REASON_LABEL[trade.exitReason];
  }

  /** Undo needs a second click: what it removes is named first. */
  async undoClick(button) {
    const t = this.trading;
    const last = t.broker.trades[t.broker.trades.length - 1];
    if (!this.undo || !last) return;
    if (!this.undoArmed) {
      this.undoArmed = true;
      button.textContent = `Undo #${last.id}?`;
      button.classList.add("armed");
      this.say(`Click "Undo #${last.id}?" again to take back #${last.id} ${last.side} as if it was never placed. ` +
        `This backtest can do it ${this.undo.limit - t.undos.length} time${this.undo.limit - t.undos.length === 1 ? "" : "s"}; it will show that it did.`);
      return;
    }
    this.undoArmed = false;
    try {
      this.say(await this.undo.run(), "ok");
    } catch (err) {
      this.say(err.message, "bad");
    }
    this.render();
  }

  renderUndo() {
    const t = this.trading;
    const button = this.el("undo-trade");
    const left = this.undo ? this.undo.limit - t.undos.length : 0;
    const can = this.undo && t.clock.active && t.clock.live && t.broker.trades.length > 0;
    button.hidden = !can && !(t.clock.active && t.undos.length);
    button.disabled = !can || left <= 0;
    if (!this.undoArmed) {
      button.textContent = left > 0 ? `Undo last trade (${left} left)` : "Undo used";
      button.classList.remove("armed");
    }
    button.title = left > 0 ? "Take back the most recent trade, as if it was never placed (once per backtest)"
      : `This backtest took back #${t.undos.map((u) => u.id).join(", #")}.`;
  }

  renderTrades() {
    this.renderUndo();
    const t = this.trading;
    const blocked = !!t.blockedReason;
    const off = blocked ? " disabled" : "";
    const active = t.broker.trades.filter((trade) => trade.isActive);
    this.el("active-title").textContent = `Open and pending (${active.length})`;
    this.el("close-all").hidden = active.length === 0;
    this.el("close-all").disabled = blocked;
    // While the replay plays, only the floating numbers change. Rebuilding the list on every candle
    // would replace the buttons under the mouse and swallow clicks, so the list is rebuilt only when
    // something structural changes, and the numbers are updated in place otherwise.
    const key = JSON.stringify([blocked, this.pickedTrade, active.map((trade) => [trade.id, trade.status, trade.orderType, trade.orderPrice,
      trade.stopLoss, trade.takeProfit, trade.partials.length, t.account.units(trade), this.marks(trade)])]);
    if (key === this.activeKey) {
      for (const trade of active) {
        if (trade.status !== Status.OPEN) continue;
        this.setNumber(`[data-r="${trade.id}"]`, this.r(t.floatingR(trade)), t.floatingR(trade));
        this.setNumber(`[data-money="${trade.id}"]`, formatSignedMoney(t.money(trade)), t.money(trade));
      }
    } else {
      this.activeKey = key;
      this.el("active-list").innerHTML = active.length === 0
      ? '<li class="empty">No open trades or orders.</li>'
      : active.map((trade) => {
        const tone = trade.side === Side.BUY ? "up" : "down";
        const levels = `SL ${this.price(trade.stopLoss)} · TP ${this.price(trade.takeProfit)}`;
        if (trade.status === Status.PENDING) {
          const at = trade.orderType === OrderType.MARKET ? "fills next candle" : `at ${this.price(trade.orderPrice)}`;
          return `<li${this.rowAttributes(trade)}><div class="row"><span><span class="${tone}">#${trade.id} ${trade.side} ${trade.orderType}</span>` +
            ` <span class="tag">${this.lots(trade)}</span>${this.marks(trade)}</span>` +
            `<button class="plain small" data-cancel="${trade.id}"${off}>Cancel</button></div>` +
            `<div class="sub">${at} · ${levels} · risk ${formatMoney(t.account.riskMoney(trade))}</div></li>`;
        }
        const floating = t.floatingR(trade);
        const money = t.money(trade);
        const openLots = formatLots(t.account.openUnits(trade));
        const size = trade.partials.length ? `${openLots} of ${this.lots(trade)}` : this.lots(trade);
        const atBreakeven = trade.stopLoss === trade.entryPrice;
        return `<li${this.rowAttributes(trade)}><div class="row"><span><span class="${tone}">#${trade.id} ${trade.side}</span> <span class="tag">${size}</span>${this.marks(trade)}</span>` +
          `<span class="${this.tone(floating)}" data-r="${trade.id}">${this.r(floating)}</span>` +
          `<span class="${this.tone(money)}" data-money="${trade.id}">${formatSignedMoney(money)}</span></div>` +
          `<div class="sub">in at ${this.price(trade.entryPrice)} · ${levels}</div>` +
          `<div class="actions">` +
          `<button class="plain small" data-breakeven="${trade.id}" title="Move the stop loss to the entry price"${blocked || atBreakeven ? " disabled" : ""}>BE</button>` +
          `<button class="plain small" data-partial="${trade.id}:25" title="Close a quarter of what is open"${off}>25%</button>` +
          `<button class="plain small" data-partial="${trade.id}:50" title="Close half of what is open"${off}>50%</button>` +
          `<button class="plain small" data-close="${trade.id}" title="Close all of it at the current price"${off}>Close</button>` +
          `</div></li>`;
      }).join("");
    }

    const closed = t.broker.closedTrades.slice().reverse();
    const s = t.summary();
    this.el("closed-title").textContent = `Closed (${s.closed})` +
      (s.closed ? ` · ${this.r(s.totalR)} · ${formatSignedMoney(s.totalMoney)} · ${s.wins}W ${s.losses}L` : "");
    // A closed trade never changes, so the list is rebuilt only when one is added, or its journal marks
    // or the picked trade change (rebuilding it on every candle took about 7 ms with 40 trades).
    const closedKey = JSON.stringify([this.pickedTrade, closed.map((trade) => [trade.id, this.marks(trade)])]);
    if (closedKey === this.closedKey) return;
    this.closedKey = closedKey;
    this.el("closed-list").innerHTML = closed.length === 0
      ? '<li class="empty">Closed trades appear here.</li>'
      : closed.map((trade) => {
        const money = t.money(trade);
        const parts = trade.partials.length ? ` · ${trade.partials.length} partial${trade.partials.length > 1 ? "s" : ""}` : "";
        return `<li${this.rowAttributes(trade)}><div class="row"><span>#${trade.id} ${trade.side} <span class="tag">${this.lots(trade)}</span>${this.marks(trade)}</span>` +
          `<span class="${this.tone(trade.resultR)}">${this.r(trade.resultR)}</span>` +
          `<span class="${this.tone(money)}">${formatSignedMoney(money)}</span></div>` +
          `<div class="sub">${this.reason(trade)}${parts} · ${this.tradeTime(trade.entryTime)} → ${this.tradeTime(trade.exitTime).split(", ")[1]}` +
          ` · best ${this.r(trade.mfeR)}</div></li>`;
      }).join("");
  }
}
