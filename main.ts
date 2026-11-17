// "Three Gated Dip Arms, ridden" — a cbBTC/USDC 1-minute bars-replay bot.
// Revision of round 1 (which made +$4.53 on dev).
//
// What round 1 got wrong: it bought the dips well but sold at the mean.
// Every dip buy was exited the moment price crossed back above EMA(240),
// or at a 0.9% take profit — so it banked ~0.4% per round trip while the
// price then ran another 1-2% above the mean. The dev window's two big
// V-swings (dip to ~63,874, rally to ~65,456) were left on the table.
//
// What changed in round 2 (validated by a ~40-variant sweep + walk-forward
// over the dev window's four 6-hour blocks; see README.md for the numbers):
//   - Exit: NO mean-reversion exit. Hold the dip buy until take profit
//     +1.5% from the VWAP entry, or the hard stop -1.5%. No trailing stop
//     either: a 0.6% trail exited winners on the first pullback in dev.
//   - Entry: EMA(180) instead of EMA(240) — the bot starts trading after
//     182 bars (~3h) instead of 242 (~4h), so it can trade the first block
//     of the race window too. Arms at -0.6% / -1.2% / -1.8% below the mean,
//     gated by RSI(14) < 50 / 45 / 40.
//   - Size: front-loaded 60% / 25% / 15% of cash per arm (about 75% of
//     equity fully loaded), because the first dip already carries the edge
//     once the exit lets the swing run.
//   - The trend leg is kept unchanged as insurance (it never fired in dev
//     and costs nothing there): a genuine multi-hour surge — 240-minute
//     return above 2.0% with price above the slow mean — buys 30% of cash
//     and rides it with a 2% trailing stop.
//
// Dev (grade-local, --driver process): net PnL +$16.26, 6 fills, max
// drawdown 0.79%, walk-forward blocks +0.90 / +12.54 / +3.63 / -0.03
// (3/4 positive), 2x-fee net +$14.80. Round 1 for comparison: +$4.53,
// blocks +0.00 / +3.76 / -0.51 / +1.28 (2/4).
//
// Honest limits: the edge is concentrated in two or three swing trades —
// a race window with no 1.5%+ swing from a dip leaves this bot near flat,
// and a dip that keeps falling to the hard stop costs ~1.5% on the loaded
// size. It is a swing-catcher, not a scalper.
//
// Deterministic: pure function of the closes and the account. No clock, no
// network, no randomness. RSI here is the simple 14-bar mean gain/loss
// version, EMA is seeded at the first close with alpha 2/(n+1).
import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SLOW = 180;
const DIPS = [0.006, 0.012, 0.018]; // arm depths below the slow mean
const RSI_MAX = [50, 45, 40];
const SIZES_NUM = [60n, 25n, 15n]; // fraction of cash per arm
const SIZES_DEN = 100n;
const TAKE_PROFIT = 1.015;
const HARD_STOP = 0.985;
const COOLDOWN_BARS = 30;
const MAX_SLIPPAGE_BPS = 100;
const TREND_R240 = 0.02; // 240-minute return that counts as a real surge
const TREND_TRAIL = 0.02; // trailing stop for the trend leg
const TREND_SIZE_NUM = 3n; // buy 30% of cash on the trend leg
const TREND_SIZE_DEN = 10n;

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

function buyFraction(state: BarsState, num: bigint, den: bigint): OrderInput | null {
  const notional = (state.cash * num) / den;
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
          const order = buyFraction(state, TREND_SIZE_NUM, TREND_SIZE_DEN);
          if (order === null) return [];
          mode = 'trend';
          trendPeak = close;
          firstEntryClose = close;
          armsFired.clear();
          return [order];
        }
      }
      for (let i = 0; i < DIPS.length; i++) {
        if (close < emaSlow * (1 - DIPS[i]!) && rsi < RSI_MAX[i]!) {
          const order = buyFraction(state, SIZES_NUM[i]!, SIZES_DEN);
          if (order === null) return [];
          firstEntryClose = close;
          armsFired.clear();
          armsFired.add(i);
          mode = 'range';
          return [order];
        }
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

    // Long: maybe add a deeper arm (EMA-relative, same gates as entry).
    for (let i = 0; i < DIPS.length; i++) {
      if (!armsFired.has(i) && close < emaSlow * (1 - DIPS[i]!) && rsi < RSI_MAX[i]!) {
        const order = buyFraction(state, SIZES_NUM[i]!, SIZES_DEN);
        if (order !== null) {
          armsFired.add(i);
          return [order];
        }
      }
    }

    // Exits: take profit or hard stop off the VWAP entry. Deliberately NO
    // mean-reversion exit — that was round 1's leak.
    const entry = vwapEntryUsdc(state);
    if (entry !== null && (close > entry * TAKE_PROFIT || close < entry * HARD_STOP)) {
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
