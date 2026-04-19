# LayFive Ruleset v4 — Strategic Reference

**Updated:** 2026-04-19

---

## Goal

**Survive the bankroll. Not win.**

Cruise roulette pays you in time at the table (comps, meals, status). A small loss or break-even session, stretched long, beats a big win session that blows up into a bigger loss. The ruleset below is optimized for that.

---

## The Math (keep this in your head)

- 12 numbers per element (5 elements, 60 numbers of 37 actionable — the rest are splits/zeros).
- Bet **15 units** on one element's straight coverage.
- Straight hit = **+21 units** (21 profit on top of the 15 returned).
- Miss = **−15 units**.
- **1 straight hit covers ~1.45 losses** (21 ÷ 15 = 1.4).
- Expected per-spin value at random = (12/37 × 21) − (25/37 × 15) = **−3.33 units per spin**.
  → The house edge only disappears if you can bet at moments where the element's *near-term* hit rate is above 12/37. That's the entire point of the app.

## Bankroll rule (updated 2026-04-19)

**Sit down with 4 bets of exposure — not 10 or 20.**

- 10–20 bets was the old approach. Losing them all took 2–3 winning sessions to recover.
- 4 bets per session means: if the pattern doesn't pay fast, you're out with minimal damage and can re-enter the next cycle.
- Most winning cycles resolve within **10 spins** — so 4 bets of ammo is usually enough to catch the streak.
- Doubling (or more) on 4 bets in a short session is easier and higher-EV than grinding 10–20 bets through a marginal pattern.
- This bankroll discipline is the backbone of *survive the bankroll, not win*. **The website copy should be revised to reflect this.**

---

## Existing Ruleset (what the app already does)

### STOP triggers (hard — blocking modal)

| ID | Trigger | Intent |
|---|---|---|
| **H1** | Your selected element missed 4 in a row (tail streak). | Prevent chasing into a cold element. |
| **H2** | 20 spins played, P&L never went positive. | No momentum has ever appeared — abandon. |
| **H4** | 4 of 5 elements each had a 4-blank streak in the last 15, and the one survivor isn't leading. | "Everything's dead" signal. Strongest warning. |

### STOP triggers (soft — caution banner)

| ID | Trigger | Intent |
|---|---|---|
| **C1** | 42 total spins reached (12 grace + 30 play). | Time-cap the session. Past this point, expected value declines. |
| **C2** | A different element takes a 2-spin lead in the last 15/20/25 window. | Signal that the pattern has rotated — switch or stop. Fires once per new leader. |
| **C3** | Net P&L ≥ 100% of starting bankroll AND you still lead by 2–5. | Lock the win — drop bet size. |

### GO signal (informational)

| ID | Trigger | Intent |
|---|---|---|
| **SUG** | Any element leads by ≥ 2 in full session. | Green-star suggestion — this is the safer bet right now. |

### Display reminders (always visible, sticky)

- **Σ session hits** per element (catches the "felt behind" elements at a glance).
- **2-spin leader (last 18)** — updates continuously.
- **Most behind past 30** — the element to avoid.

---

## Proposed New Rules (testing phase — validate with data)

These are grounded in your two live-play hunches. Treat them as hypotheses to confirm or kill during testing.

### N1 — Leader-Lock Window (**GO** rule)

**When the last-18 rolling window shows a 2-spin leader, that element is the safest bet until it is *strictly* overtaken.**

- Bet only on the active leader during this window.
- A tie (another element catches up to the same hit count) does NOT break the lock — your memory note already captures this.
- Exit the window the moment someone has strictly more hits than the current leader.

**Why:** your hunch #2 — 2-spin leaders rarely run into 4+ miss streaks. This rule converts that intuition into a bet gate.

**Data to validate:** across pooled sessions, what % of 2-spin leader stretches contain a 4+ miss streak before the leader is strictly overtaken? Target: under 15%.

---

### N2 — Felt-Behind Exclusion (**avoid** rule)

**Never bet on an element that has been "most behind past 30" for 3 or more consecutive spins.**

- Exclude it from SUG/N1 consideration even if some window shows it leading.
- Resume considering it only after it posts 2 hits inside any 15-spin window.

**Why:** your hunch #1 — once an element feels behind, it tends to stay behind. Don't catch a falling knife.

**Data to validate:** after an element is "most behind past 30" for 3+ consecutive spins, what's the miss rate for the next 10 spins compared to the 12/37 expectation?

---

### N3 — 3-Miss Cooling Floor (tightens H1, aligned with 4-bet bankroll)

**After 3 consecutive misses on the element you're betting, stop betting it. Wait for 1 straight hit anywhere in the next 5 spins before resuming.**

- Your current sit-down bankroll is 4 bets. 3 misses already consumed 75% of it. The 4th miss is session-ending.
- H1 currently waits for 4 misses — by then your bankroll is toast. N3 moves the floor up by one so you exit with 1 bet of buffer left.
- Preserves the payout math: stopping at 3 misses (−45 units) still leaves room for a later recovery session; a 4th miss (−60 units) wipes the bankroll.

**Why:** with a 4-bet sit-down, the 4th miss isn't a caution signal — it's the end of the session. N3 is the real stop line; H1 is a redundant safety net.

**Data to validate:** P(4th miss | 3 consecutive misses) across the pool. And: does the 1-hit-in-5-spin recovery rule beat "never come back in this session"?

---

### N4 — Half-Stake Lock-In (was: Hit-Count Exit)

**Once you're up by 3 straight hits (≈ +63 units), cut your bet size in half to lock 50% of the winnings. Keep betting, don't stop.**

- Cutting stake preserves upside if the element is in a long hitting streak (10+ hits, or 15+ of 20 spins — rare but real).
- Locking half means: even if the rest of the cycle reverses fully, the session still exits positive.
- The goal is to **catch the long hitting streaks**, because those streaks fund the inevitable losing sessions. Stopping early on 3 hits leaves money on the table during a streak.
- If you hit N3 (3 misses after the lock-in), stop. The streak is over.
- If the session returns to ≈ break-even (below your locked 50%), stop — the streak has fully reversed.

**Why:** your observation — long hitting streaks do happen. A static "stop at +3" rule caps your gains exactly when the table is about to pay. Half-stake lock-in keeps you in the streak with reduced exposure.

**Data to validate:**
- Distribution of max-consecutive-hits per element per session (how often do 10+ streaks occur?).
- If we simulate "cut bet in half after 3 hits, stop on 3 misses or drop below +50%," what's the session EV vs. "stop at 3 hits"?
- How often do streaks extend past 3 hits vs. reverse within 3 more spins?

---

### N5 — Restart Trigger on Leader Change Only

**Don't Restart the view on a fixed spin count — Restart only when the 2-spin leader changes.**

- C2 already detects a leader change — Restart would reset the rolling window so the NEW leader is tracked from scratch.
- Avoids restarting in the middle of a safe N1 window.

**Why:** restarts should be tied to regime changes (the pattern rotated), not arbitrary counts.

**Data to validate:** does restarting on leader-change yield a better P&L distribution than fixed-count restart?

---

### N6 — Max 2 Leader Switches Per Session

**If C2 fires twice (you've seen 2 leader rotations), end the session.**

- Two rotations = pattern is too noisy to bet profitably.
- Combined with N1, this caps exposure cleanly.

**Why:** you can only ride one leader safely. Two rotations means you're chasing; more means the table isn't offering a clean pattern tonight.

**Data to validate:** session P&L distribution by number of leader switches. Prediction: median P&L drops sharply after 2 switches.

---

### N7 — Break-Even Exit at 20 Spins

**If you're sitting at ±20 units at spin 20, stop.**

- H2 already fires if you never went positive by spin 20. N7 adds: even if you briefly dipped positive, if you're now at break-even, the table isn't paying. Leave.

**Why:** the "I'll wait one more spin" loop. A flat P&L at 20 spins is the signature of a hostile pattern.

**Data to validate:** at spin 20 with |P&L| ≤ 20 units, what's the session P&L distribution through spin 42?

---

## What to watch while testing tonight

Keep these observations in your head — they'll seed the analysis:

1. **Every time the 2-spin leader emerges**, note at what spin it appeared and how many spins until it was strictly overtaken. (N1 window length.)
2. **Every time an element becomes "most behind past 30,"** note how long before it recovered (if ever in that session). (N2 validation.)
3. **When you felt a miss streak coming,** what was the signal (gut)? Write it down afterward — we'll look for a data-detectable version.
4. **Session outcomes** — don't just remember P&L. Note: total spins played, number of C2 fires, whether H1/H2/H4 fired, and whether you overrode a rule.

---

## Analysis questions the saved pool will answer

Once autosave fills the pool over the next few sessions, I can run:

1. **N1 safety:** % of 2-spin leader stretches that contain a 4+ miss streak before strict overtake.
2. **N2 persistence:** average spins of "felt behind" before recovery, and recovery rate vs. 12/37 baseline.
3. **N3 floor:** P(4th miss | 3 consecutive misses).
4. **N4 exit:** EV after 3 straight hits.
5. **N5–N6 restart/switch behavior:** P&L distribution by restart strategy and leader-switch count.
6. **N7 stall:** P&L outcome if |P&L| ≤ 20 at spin 20.
7. **Overall stop-play threshold:** spin count where expected P&L flips negative across the pool.

Autosave (just shipped in Commit F) now pushes every Restart and New Session to Firestore. After a few more testing sessions, the pool will have enough data to land real numbers.

---

## How to read this document while playing

- **Always visible (top of screen):** session hits, 2-spin leader, most-behind — these are your *current* state.
- **When in doubt:** default to N1 (bet the 2-spin leader) or don't bet at all.
- **When a banner/modal fires:** take it seriously. Override only with a reason you could write down.
- **End the session when:** any hard stop (H1/H2/H4), N3 (3 consecutive misses on your element), N6 (2 leader switches), or N7 fires.
- **At +3 hits on a streak:** cut bet size in half (N4) — don't stop. Ride the streak with reduced exposure.
- **After N4 lock-in:** stop if you hit 3 more misses or if P&L drops below the +50% lock point.

---

*This document is living. Update it after each testing session with what worked, what didn't, and new hunches to test.*
