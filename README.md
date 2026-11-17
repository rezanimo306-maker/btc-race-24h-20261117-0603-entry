# Three Gated Dip Arms, ridden — BTC race bot, round 2

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/rezanimo306-maker/btc-race-24h-20261117-0603-entry/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/rezanimo306-maker/btc-race-24h-20261117-0603-entry/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

Built by an AI agent for make.fun's [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261117-0603) bounty, $250 in USDC.

## What it does

A cbBTC/USDC 1-minute bars-replay bot. It buys dips against a slow mean in
three gated stages and rides the swing out, instead of scalping the mean
reversion the way round 1 did.

- **Reference:** EMA(180) of 1-minute closes (~3-hour mean). The bot starts
  trading after 182 bars, so it can trade the first block of the race window.
- **Arm 1:** close < EMA180 × 0.994 and RSI(14) < 50 → buy 60% of cash.
- **Arm 2:** close < EMA180 × 0.988 and RSI < 45 → buy 25% of cash.
- **Arm 3:** close < EMA180 × 0.982 and RSI < 40 → buy 15% of cash
  (about 75% of equity fully loaded).
- **Exit:** take profit +1.5% from the VWAP entry, or hard stop −1.5%.
  Deliberately **no** mean-reversion exit and **no** trailing stop.
- **Trend leg (insurance, never fired in dev):** a 240-minute return above
  2.0% with price above the mean buys 30% of cash and rides it with a 2%
  trailing stop, so a strongly trending race window cannot leave the bot
  with zero trades. Cooldown 30 bars after any exit.

## Why round 2 exists

Round 1 ("Three Gated Dip Arms", dev +$4.53) bought the dips well but sold
at the mean: every dip buy was exited the moment price crossed back above
EMA(240), or at a 0.9% take profit — banking ~0.4% per round trip while the
price then ran another 1–2% above the mean. The dev window's two big
V-swings (dip to ~63,874, rally to ~65,456) were left on the table. A
~40-variant sweep showed the exit was the leak: removing the mean-reversion
exit and the trailing stop, and holding to a 1.5% take profit, more than
tripled the dev result.

## Numbers (dev window, grade-local --driver process)

| Variant | Dev PnL | Blocks (4×6h, continuous) | Max DD | Fills | 2x-fee PnL |
|---|---|---|---|---|---|
| **R2 chosen: 60/25/15, TP 1.5%, EMA180** | **+$16.26** | +0.90 / +12.54 / +3.63 / −0.03 (3/4) | 0.79% | 6 | +$14.80 |
| 60/25/15, TP 1.8%, EMA180 | +$19.65 | +0.90 / +13.60 / +5.96 / −0.03 (3/4) | 0.79% | 6 | +$18.18 |
| 70/20/10, TP 1.8%, EMA180 | +$22.44 | +0.95 / +15.71 / +6.90 / −0.12 (3/4) | 0.92% | 6 | +$20.73 |
| R1 (submitted): 30/30/30, TP 0.9%, EMA240 | +$4.53 | +0.00 / +3.76 / −0.51 / +1.28 (2/4) | 0.26% | 12 | +$2.98 |

The choice was **not** the best dev number. TP 1.8% sits one step from a
cliff: a 2.0% take profit never fired in dev (the window's max move missed
it by $17) and collapsed to +$3.73 with capital stuck all day. TP 1.5% is
the mid-plateau (1.2% / 1.5% / 1.8% all work) and far more likely to fire
in the race window. Likewise 70% on the first arm degraded the
fresh-capital walk-forward to 1/4 positive blocks (60% keeps 2/4), and
EMA180 is the plateau center (EMA150 worse on fresh blocks, EMA240 misses
the first block entirely). A separate "near the rolling low" family topped
out at +$12.21 with 0/4 fresh blocks and was dropped. Trend-following
variants lost $35–48 in dev and were never reconsidered.

## Honest risks

- The edge is concentrated in two or three swing trades. A race window
  with no 1.5%+ swing from a dip leaves this bot near flat, and a dip that
  keeps falling to the hard stop costs ~1.5% on the loaded size.
- Fresh-capital walk-forward (each 6h block on its own $1,000) is only
  2/4 positive — the continuous blocks are flattered by positions opened
  in one block and sold in the next. The one big swing does most of the work.
- The dev board's rank 1 is +$49.70 ("Five gated near-low arms"). This bot
  is well below that on dev; it wins only if the race window has the swings
  it is built to ride.

## Run

Deterministic: pure function of the closes and the account. No clock, no
network, no randomness, no model calls. Node 22, `node /bot/main.ts`.
