# LayFive Anti-Tilt Rules v2

Last updated: 2026-04-14

These rules are enforced by `layfive-rules.js` while a live P&L session is active
(`lf_pnl_session_v1` with `active:true`). Triggers are re-evaluated after every
spin that is added to the Scorecard.

## Windows

- **Session window** — every spin tracked in `pnl.history` since the live P&L
  session was started (via the P&L Setup modal).
- **Last-12 window** — the most recent 12 entries of `pnl.history`, sliding.

## Terminology

- **Leader** — the element with the highest count of `s` (straight) or `sp`
  (split) hits in a given window. Ties → co-leaders (no single leader).
- **Lead** — leader's count minus the runner-up's count.
- **Blank** — a spin whose number scored no hit (`-`) on a given element.

## Suggestion rules (start / switch)

- Only suggest an element whose session-window **lead ≥ 2** over all others.
- Mark with `X` (don't bet) if that element had **4 blanks within the last 12 spins**.
- If no element meets both bars, show caution: "no clear leader yet".

## Caution rules (non-blocking banner)

| ID  | Trigger                                                                 | Message intent                                                                                                                         |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 35 spins played in the session                                          | End the session regardless of W/L.                                                                                                     |
| C2  | In the last 12 spins, some element is 2+ ahead of every other element AND it is NOT the currently selected one | If net P&L is positive → suggest switching to the new leader. If net P&L is zero or negative → suggest stopping. Never stay on the selected element. If bankroll can't cover 4 more spins, reduce bet so 4 more are possible — never refill. |
| C3  | Net P&L ≥ 100% of starting bankroll AND session-window lead is 2–5      | Suggest lowering bet to lock 100% gain. If winnings fall back to 20% of bankroll, stop.                                                |

## Hard-stop rules (blocking modal — End / Override)

| ID  | Trigger                                                                                           |
| --- | ------------------------------------------------------------------------------------------------- |
| H1  | Selected element misses 4 spins in a row (tail streak).                                           |
| H2  | Over the most recent 20 spins, net P&L never went positive at any point (back-and-forth).        |
| H3  | Last-12 window has 2+ co-leaders, OR the selected element lost the lead to a single other element. |
| H4  | 4 of the 5 elements each had a 4-blank streak in the last 12 spins, AND the remaining element is not the current last-12 leader. |
| H5  | 2+ non-selected elements are each 2+ spins ahead of the selected element in the last 12 spins. No single clear new leader to switch to — stop. |

## Modal behavior

- Hard-stop modal has two choices: **End session** or **Override & keep betting**.
- Override is logged inside `pnl.overrides[ruleId]` so the same warning does
  not re-fire every spin. Session record carries overrides if saved.
- Caution banners have a single **Dismiss** button (also writes to `overrides`).
- On End, `pnl.active` → false and `pnl.overrides.__endedByRule` is written.

## Extending

Add new rules inside `evaluate()` in `layfive-rules.js`, returning
`{id, severity: 'hard'|'caution', title, msg}`. Rule evaluation picks the
highest-priority non-overridden trigger each cycle (hard beats caution).
