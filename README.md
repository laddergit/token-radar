# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/laddergit/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/laddergit/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Launch Radar — ranks every tokenless DeFi protocol by the implied value of its future token, from a sealed DefiLlama snapshot, with a farm plan for each.

## Run it

```sh
node main.ts
```

`main.ts` reads the sealed snapshot (`data/snapshot.json` locally, `/input/snapshot.json` when the grader mounts it), writes the ranked board to `out/board.json` (or `$MAKEFUN_OUTPUT_DIR/board.json`), writes the dashboard's data into `dashboard/data.js`, copies `dashboard/` and `screenshots/` to the output, and writes `dossier.json`. No network, no dependencies, deterministic: two runs write the same bytes.

## How the ranking works

- **Tokenless, verified.** A protocol records no token when the snapshot carries neither a CoinGecko id nor a token symbol for it. The board covers the snapshot's whole watchlist (protocols at or above the $50M floor) plus the 160 pre-token protocols with the most TVL.
- **Implied value.** TVL × the category median market-cap/TVL of tokenized peers in the snapshot, × a 7-day growth factor (at most ±25%), × an age factor (up to +20% for 4+ years with no token). Thin categories fall back to the median of the per-category medians. Multiples are winsorized to [0.05, 10] (10+ peers) or [0.05, 5].
- **Farm plans.** Every row carries six concrete steps — what to do, what it costs in gas, and how long to keep at it — drawn from the protocol's own category, chain and record.

## Layout

- `main.ts` — the program (Node 22+, standard library only)
- `data/snapshot.json` — the sealed snapshot in house format (as_of 2026-11-14, sha256 42a71213…; the grader mounts its own copy at `/input/snapshot.json`)
- `dashboard/` — the static page (renders with no network): board, detail view per protocol, filters
- `screenshots/` — the board, a detail view and a filtered view
- `out/` — the last local run's output (`board.json`, `dashboard/`, `dossier.json`)

---

<sub>Entered on [make.fun](https://make.fun/?ref=09j51em1&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
