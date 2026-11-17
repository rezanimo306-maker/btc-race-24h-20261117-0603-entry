// Three Gated Dip Arms — a cbBTC/USDC 1-minute bars-replay bot.
//
// Idea: cbBTC 1-minute bars are mostly flat chop with 0.5-1.3% swings. Trend
// followers whipsaw themselves to death here (every EMA-cross variant lost
// $35-48 on the dev window). This bot instead buys dips against a slow mean
// in three gated stages, and sells the reversion. It trades rarely, risks
// little, and never chases.
//
// Entry (flat only, needs 242 closes of history):
//   arm 1: close < EMA(240) * 0.996 and RSI(14) < 45  -> buy 30% of cash
//   arm 2: close < first-entry close * 0.995 and RSI < 40 -> buy 30% of cash
//   arm 3: close < first-entry close * 0.990 and RSI < 35 -> buy 30% of cash
// Exit (sell the whole position):
//   close > EMA(240) (mean reversion), or close > VWAP entry * 1.009 (take
//   profit), or close < VWAP entry * 0.985 (hard stop). 30-bar cooldown after
//   any exit before a new arm 1.
//
// Trend leg (insurance, never fired on the dev window): if the market is in
// a genuine multi-hour surge — 240-minute return above 2.0% (the dev
// window's max was 1.57%) and price above the slow mean — buy 30% of cash
// and ride it with a 2% trailing stop, exiting on the trail or on a close
// back below the mean. Without it, a strongly trending race window would
// leave the dip arms silent and the bot with zero trades (a guardrail
// failure); with it, the leg only wakes in a regime the dip arms cannot
// trade. It costs nothing on dev because it never fires there.
//
// Deterministic: pure function of the closes and the account. No clock, no
// network, no randomness. RSI here is the simple 14-bar mean gain/loss
// version, EMA is seeded at the first close with alpha 2/(n+1).
import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SLOW = 240;
const DIP = 0.996; // arm 1: 0.4% below the slow mean
const ARM2_DIP = 0.995; // 0.5% below the first entry close
const ARM3_DIP = 0.990; // 1.0% below the first entry close
const RSI1 = 45;
const RSI2 = 40;
const RSI3 = 35;
const TAKE_PROFIT = 1.009;
const HARD_STOP = 0.985;
const COOLDOWN_BARS = 30;
const STAGE_FRACTION_NUM = 3n; // buy 30% of cash per stage
const STAGE_FRACTION_DEN = 10n;
const MAX_SLIPPAGE_BPS = 100;
const TREND_R240 = 0.02; // 240-minute return that counts as a real surge
const TREND_TRAIL = 0.02; // trailing stop for the trend leg

// --- indicators (floats; order amounts stay exact bigints) -----------------
const closes: number[] = [];
let emaSlow: number | null = null;
const EMA_ALPHA = 2 / (SLOW + 1);

function rsi14(): number {
  const n = 14;
  if (closes.length < n + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  const avgGain = gain / n;
  const avgLoss = loss / n;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// --- episode state ---------------------------------------------------------
let firstEntryClose: number | null = null;
const armsFired = new Set<number>();
let lastSellSeq = -1_000_000;
let mode: 'range' | 'trend' | null = null;
let trendPeak = 0;

function vwapEntryUsdc(state: BarsState): number | null {
  const pos = state.positions.get(SYMBOL);
  if (pos === undefined || pos.qty === 0n) return null;
  // cost is quote units (1e-6 USDC), qty is 1e-8 BTC:
  // entry USDC = cost * 100 / qty.
  return Number(pos.cost) * 100 / Number(pos.qty);
}

function buyStage(state: BarsState): OrderInput | null {
  const notional = (state.cash * STAGE_FRACTION_NUM) / STAGE_FRACTION_DEN;
  if (notional < 1_000_000n) return null; // under the $1 minimum
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

function sellAll(state: BarsState): OrderInput | null {
  const pos = state.positions.get(SYMBOL);
  if (pos === undefined || pos.qty === 0n) return null;
  return { side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      const close = Number(bar.c) / 1e5;
      closes.push(close);
      emaSlow = emaSlow === null ? close : EMA_ALPHA * close + (1 - EMA_ALPHA) * emaSlow;
    }
    if (state.warmingUp) return [];
    if (closes.length < SLOW + 2 || emaSlow === null) return [];

    const close = closes[closes.length - 1]!;
    const rsi = rsi14();
    const pos = state.positions.get(SYMBOL);
    const long = pos !== undefined && pos.qty > 0n;

    if (!long) {
      if (state.seq - lastSellSeq < COOLDOWN_BARS) return [];
      // Trend leg first: a real multi-hour surge, price above the slow mean.
      if (closes.length > SLOW && close > emaSlow * 1.005) {
        const r240 = close / closes[closes.length - 1 - SLOW]! - 1;
        if (r240 > TREND_R240) {
          const order = buyStage(state);
          if (order === null) return [];
          mode = 'trend';
          trendPeak = close;
          firstEntryClose = close;
          armsFired.clear();
          return [order];
        }
      }
      if (close < emaSlow * DIP && rsi < RSI1) {
        const order = buyStage(state);
        if (order === null) return [];
        firstEntryClose = close;
        armsFired.clear();
        armsFired.add(0);
        mode = 'range';
        return [order];
      }
      return [];
    }

    // Long in trend mode: ride it, exit on the trailing stop or a close
    // back below the slow mean.
    if (mode === 'trend') {
      trendPeak = Math.max(trendPeak, close);
      if (close < trendPeak * (1 - TREND_TRAIL) || close < emaSlow) {
        const order = sellAll(state);
        if (order === null) return [];
        lastSellSeq = state.seq;
        armsFired.clear();
        firstEntryClose = null;
        mode = null;
        return [order];
      }
      return [];
    }

    // Long: maybe add a deeper arm.
    if (firstEntryClose === null) firstEntryClose = vwapEntryUsdc(state) ?? close;
    if (!armsFired.has(1) && close < firstEntryClose * ARM2_DIP && rsi < RSI2) {
      const order = buyStage(state);
      if (order !== null) {
        armsFired.add(1);
        return [order];
      }
    }
    if (!armsFired.has(2) && close < firstEntryClose * ARM3_DIP && rsi < RSI3) {
      const order = buyStage(state);
      if (order !== null) {
        armsFired.add(2);
        return [order];
      }
    }

    // Exits: mean reversion, take profit, hard stop.
    const entry = vwapEntryUsdc(state);
    if (close > emaSlow || (entry !== null && close > entry * TAKE_PROFIT) || (entry !== null && close < entry * HARD_STOP)) {
      const order = sellAll(state);
      if (order === null) return [];
      lastSellSeq = state.seq;
      armsFired.clear();
      firstEntryClose = null;
      mode = null;
      return [order];
    }
    return [];
  },
});
