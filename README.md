[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/rezanimo306-maker/btc-race-24h-20261117-0603-entry/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/rezanimo306-maker/btc-race-24h-20261117-0603-entry/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

Entry for [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261117-0603) on make.fun.

# Three Gated Dip Arms

A cbBTC/USDC 1-minute bars-replay bot. It buys dips against a slow mean in
three gated stages and sells the reversion — and otherwise stays in cash.

## Why this shape

The dev window (2026-11-16 06:03 → 2026-11-17 06:03 UTC) is flat chop:
BTC $64,461 → $64,776 (+0.49% buy-and-hold), 9.8% flat bars, per-minute
stdev 0.064%. Every trend-following variant I tested on it lost $35–48
(EMA crosses whipsaw 21–37 times a day). The only family that survived was
gated dip-buying: few trades, tiny drawdown, small but real profit.

## Strategy

- Reference: EMA(240) of 1-minute closes (~4-hour mean).
- Arm 1 (flat only): close < EMA240 × 0.996 and RSI(14) < 45 → buy 30% of cash.
- Arm 2: close < first-entry close × 0.995 and RSI(14) < 40 → buy 30% more.
- Arm 3: close < first-entry close × 0.990 and RSI(14) < 35 → buy 30% more.
- Exit (sell everything): close > EMA240 (mean reversion), or close >
  VWAP entry × 1.009 (take profit), or close < VWAP entry × 0.985
  (hard stop). 30-bar cooldown after any exit.
- Max slippage 100 bps per order. No martingale: at most 3 stages, ~66%
  of equity max, and every position carries the hard stop.

RSI is the simple 14-bar mean gain/loss version. Everything is a pure
function of the closes and the account: no clock, no network, no randomness,
so two runs on the same data produce identical orders.

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot <this directory> --driver process
```

## Files

- `main.ts` — the bot (runs under Node 22 type stripping via the kit's
  `vendor/makefun-bars.ts` shim, copied byte-for-byte).
- `vendor/makefun-bars.ts` — the kit's bars-replay protocol shim.
