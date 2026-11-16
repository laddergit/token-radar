// Token Launch Radar — make.fun bounty token-radar-01
//
// Reads the sealed DefiLlama snapshot (house format: as_of, source, floor_usd,
// protocols[10 fields each], watchlist) and writes the ranked board.
//
// Grader contract (see the competition's rules):
//   node main.ts --input /input/snapshot.json   (MAKEFUN_OUTPUT_DIR=/output)
//   - reads the snapshot, writes <output>/board.json
//   - writes the dashboard's data into <output>/dashboard/data.js
//   - copies dashboard/ and screenshots/ to <output>/dashboard/ and <output>/screenshots/
//   - writes <output>/dossier.json with buildDossier from vendor/makefun-board.ts
//     (the kit's library — the gate compares dossier.json byte for byte
//     against what it writes, so no reimplementation may stand in for it)
//
// Local dev (no /input mounted):
//   node main.ts            reads data/snapshot.json, writes out/
//   node main.ts --input <snapshot.json>   reads that snapshot instead
//
// Deterministic and offline by default: both grader runs must write the same
// bytes, so every timestamp in the output comes from the snapshot (as_of),
// never from the wall clock. Node 22.18+ (type stripping) / Node 24.
// Standard library only — nothing is installed before it runs.

import {
  readFileSync, writeFileSync, mkdirSync, cpSync, existsSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-board.ts";

// Paths are resolved from this file, never from the working directory: the
// grader runs `node main.ts` from the repository root, but nothing may depend
// on that.
const ROOT = fileURLToPath(new URL(".", import.meta.url));
export const DEV_SNAPSHOT_PATH = join(ROOT, "data/snapshot.json");
export const DEV_META_PATH = join(ROOT, "data/snapshot-meta.json");
export const DASHBOARD_DIR = join(ROOT, "dashboard");
export const SCREENSHOTS_DIR = join(ROOT, "screenshots");

// The starter's board: the whole watchlist plus the 160 pre-token protocols
// with the most TVL. The gate needs 100-4,000 rows and full watchlist coverage.
export const EXTRA_ROWS = 160;
export const MIN_BOARD_ROWS = 100;

// --- House watchlist rule, applied verbatim to the extra rows -------------
// (the snapshot's own watchlist array is read, never recomputed)
export const WATCHLIST_EXCLUDE_CATEGORIES = new Set([
  "Bridge", "Canonical Bridge", "Liquid Staking", "Liquid Restaking",
  "Restaked BTC", "CEX",
]);
export const VERSION_MARKER_RE = /\s(V\d+|v\d+|\d+\.\d+)\s*$/;
export const WRAPPED_WORD_RE = /\b(wrapped|staked|staking)\b/i;
export const EXCHANGE_PREFIXES = [
  "Binance", "Coinbase", "Bybit", "Kraken", "Bitget", "OKX", "Bitfinex", "Gemini",
];

export function isTokenless(p: SnapshotProtocol): boolean {
  return p.gecko_id == null && p.symbol == null;
}

export function isExcludedByHouseRule(p: SnapshotProtocol): boolean {
  if (p.category != null && WATCHLIST_EXCLUDE_CATEGORIES.has(p.category)) return true;
  if (VERSION_MARKER_RE.test(p.name)) return true;
  if (WRAPPED_WORD_RE.test(p.name)) return true;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return true;
  return false;
}

// --- Snapshot (house format) ----------------------------------------------
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null; // per cent
  mcap_usd: number | null;
  listed_at: string | null; // UTC day, YYYY-MM-DD
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

// --- Board -----------------------------------------------------------------
export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  // extra keys (allowed by the gate)
  category: string | null;
  tvl_usd: number;
  change_7d: number | null;
  age_years: number | null;
  multiple: number;
  multiple_peers: number;
  multiple_fallback: boolean;
  confidence: "High" | "Medium" | "Low";
  primary_chain: string | null;
  chains: string[];
  farm_cost: string;
  farm_cadence: string;
  rationale: string;
}

export interface Board {
  meta: {
    title: string;
    generated_at: string;
    snapshot: { as_of: string; source: string; floor_usd: number; protocols: number; watchlist: number; sha256: string };
    method: { token_test: string; implied_value: string; winsor: string; board: string };
    totals: { rows: number; watchlist_covered: number; tvl_usd: number; implied_usd: number };
  };
  rows: BoardRow[];
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function ageYears(listedAt: string | null, asOf: string): number | null {
  if (!listedAt) return null;
  const start = Date.parse(listedAt + "T00:00:00Z");
  const end = Date.parse(asOf + "T00:00:00Z");
  if (isNaN(start) || isNaN(end) || end < start) return null;
  return Math.round(((end - start) / 86400000 / 365.25) * 10) / 10;
}

// The value model, from the snapshot's own figures only:
//   implied = TVL x category median mcap/TVL of tokenized peers
//             x growth factor (7-day TVL change) x age factor (years recording no token)
// Growth moves the value at most +-25%; age adds up to +20% for 4+ years.
export function growthFactor(change7d: number | null): number {
  if (change7d == null || isNaN(change7d)) return 1;
  return 1 + 0.25 * clamp(change7d / 50, -1, 1);
}

export function ageFactor(age: number | null): number {
  if (age == null) return 1;
  return 1 + 0.05 * Math.min(Math.max(age, 0), 4);
}

const HIGH_FEE = new Set(["Ethereum", "Bitcoin"]);
const MED_FEE = new Set(["Tron", "Binance"]);

export function feeTier(chain: string | null): string {
  if (!chain) return "Low (under $1 per action)";
  if (HIGH_FEE.has(chain)) return "High on mainnet ($5-25 per action)";
  if (MED_FEE.has(chain)) return "Medium ($0.50-3 per action)";
  return "Low (under $1 per action)";
}

export const FARM_CADENCE = "2-3 sessions a week for 6-12 weeks";

// --- Farm plans --------------------------------------------------------------
// One template per category: 6 concrete steps each. Placeholders:
//   {name}  the protocol's name, {chain} its first listed chain,
//   {slug}  its DefiLlama slug, {cost} the gas tier on its chain.
// The same strings go into board.json (farm_steps) and into the dashboard's
// data.js, so the page and the board can never disagree. Every step must read
// 20-600 characters once trimmed (the gate checks this); buildFarmSteps throws
// otherwise, so a bad template fails loudly instead of shipping.
export const FARM_TEMPLATES: Record<string, string[]> = {
  Dexs: [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Swap a small amount on {name} on {chain} once a week; real volume, not wash trading, is what snapshots measure.",
    "Provide liquidity to a core pool, ideally a volatile pair rather than just stables, and hold the LP position for several weeks.",
    "Try the newest feature when it ships: limit orders, concentrated liquidity or a new pool type are often weighted in points.",
    "Expect {cost} in gas per action on {chain}; keep each swap small so fees never eat the position.",
    "Come back 2-3 times a week for 6-12 weeks; snapshots reward sustained users. Never share a seed phrase, and beware fake front-ends.",
  ],
  Lending: [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Supply a blue-chip asset on {chain} and leave it supplied; suppliers are the protocol's core users.",
    "Borrow a modest sum against the collateral and repay part of it later; borrowers are usually scored separately from suppliers.",
    "Keep a wide safety margin above the liquidation threshold; a liquidation wipes the position and the farm with it.",
    "Expect {cost} in gas per action on {chain}; supplying and borrowing are the two actions that cost gas, so do them deliberately.",
    "Come back 2-3 times a week for 6-12 weeks; supplied value times time is the usual formula. Never max out leverage to farm faster.",
  ],
  Yield: [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Deposit into a vault on {chain} and hold the vault receipt token; holding time is usually the scored metric.",
    "Claim and re-deposit rewards when gas makes it worthwhile; compounding signals a real user.",
    "Spread across two or three vaults instead of one giant deposit, in case snapshots cap rewards per wallet.",
    "Expect {cost} in gas per action on {chain}; on a high-fee chain, deposit once and hold rather than churning.",
    "Come back 2-3 times a week for 6-12 weeks and check for a points or XP tab; vault strategies carry smart-contract risk, so size sensibly.",
  ],
  "Yield Aggregator": [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Deposit on {chain} and hold the receipt token for weeks, not days; time in the vault is what counts.",
    "Let the aggregator auto-compound for you; it is the product's core action and usually the scored one.",
    "Expect {cost} in gas per action on {chain}; deposit once, then let compounding do the work.",
    "Check the app and its docs for a points or XP program; deposited value times time is the usual formula.",
    "Come back 2-3 times a week for 6-12 weeks. Never share a seed phrase, and revoke approvals you no longer use.",
  ],
  RWA: [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Complete onboarding if the app asks for it; RWA apps often need KYC or an allowlist, done once through the official site only.",
    "Buy or mint the tokenized asset on {chain} and hold it; holding time is what RWA snapshots reward.",
    "Put the asset to work where you can, as collateral or in a pool, instead of letting it sit idle; utility beats idle holding.",
    "Expect {cost} in gas per action on {chain}; RWA positions are usually held for months, so a few actions suffice.",
    "Come back 2-3 times a week for 6-12 weeks and watch for a points program. RWA carries issuer risk on top of smart-contract risk.",
  ],
  Derivatives: [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Open small perps or derivatives positions on {chain} a few times a week; volume and consistency matter more than size.",
    "Provide liquidity to the venue's pool if it has one; LPs are often scored on top of traders.",
    "Keep leverage at 2-3x at most; liquidations end the farm and the funds.",
    "Expect {cost} in gas per action on {chain}; funding rates eat profits over time, so do not hold losers open.",
    "Come back 2-3 times a week for 6-12 weeks and check for a points program; trading volume and fees paid are the usual formula.",
  ],
  "Prediction Market": [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Take positions on live markets on {chain} every week; volume and the number of markets both count.",
    "Provide liquidity to open markets where the venue supports it; LPs are usually scored separately from traders.",
    "Vote or report on outcomes where the protocol asks; good participation history is a quality signal.",
    "Expect {cost} in gas per action on {chain}; keep stakes small and spread them across markets.",
    "Come back 2-3 times a week for 6-12 weeks and check for a points program. Treat every market as a bet you can lose.",
  ],
  "Onchain Capital Allocator": [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Deposit into a vault on {chain} and hold the vault share token for weeks; holding time is the scored metric.",
    "Read the curator's strategy before you deposit, then stay in the vault while it performs.",
    "Expect {cost} in gas per action on {chain}; deposit once and hold rather than moving between vaults.",
    "Check the app and its docs for a points or XP program; deposited value times time is the usual formula.",
    "Come back 2-3 times a week for 6-12 weeks. Curator risk stacks on smart-contract risk, so size sensibly.",
  ],
  CDP: [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Lock collateral and mint the protocol's stable asset on {chain}; minters are the protocol's core users.",
    "Keep a wide safety margin above the minimum collateral ratio; liquidation ends the farm.",
    "Put the minted asset to work, in an LP or lent out, instead of letting it sit idle.",
    "Expect {cost} in gas per action on {chain}; mint once, manage the ratio, and avoid churning.",
    "Come back 2-3 times a week for 6-12 weeks and check for a points program. Never share a seed phrase.",
  ],
  "Basis Trading": [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Hold the protocol's yield-bearing asset on {chain}; holding time is the scored metric.",
    "Stake it for a receipt token if the app offers it; stakers are usually scored above plain holders.",
    "Expect {cost} in gas per action on {chain}; basis positions are held for weeks, so a few actions suffice.",
    "Check the app and its docs for a points or XP program; held value times time is the usual formula.",
    "Come back 2-3 times a week for 6-12 weeks. Basis trades carry funding-rate and counterparty risk.",
  ],
  Farm: [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Stake LP tokens or assets into the farm on {chain} and keep the position open.",
    "Harvest rewards on a schedule and restake them; compounding signals a real user.",
    "Expect {cost} in gas per action on {chain}; harvest only when the reward covers the fee.",
    "Check the app and its docs for a points or XP program; staked value times time is the usual formula.",
    "Come back 2-3 times a week for 6-12 weeks. Farm emissions dilute fast, so never chase a farm with size.",
  ],
  Privacy: [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Use the privacy pool on {chain} as intended, depositing and withdrawing over time; real usage, not a single test transaction.",
    "Keep amounts ordinary and spread over weeks; giant one-off deposits look like laundering, not farming.",
    "Expect {cost} in gas per action on {chain}; a few well-spaced actions beat many tiny ones.",
    "Check the app and its docs for a points or XP program; used value times time is the usual formula.",
    "Come back 2-3 times a week for 6-12 weeks. Privacy tools are legal to use; never use them to hide illicit funds.",
  ],
  Launchpad: [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Join launches on {chain}; allocations usually go to repeat participants, not first-timers.",
    "Hold launch allocations past the first days instead of flipping instantly; holding is usually scored above instant sells.",
    "Expect {cost} in gas per action on {chain}; only join launches you have read about first.",
    "Check the app and its docs for a points or XP program; participation count is the usual formula.",
    "Come back 2-3 times a week for 6-12 weeks. Most launched tokens fall sharply after launch, so size sensibly.",
  ],
  __generic: [
    "Open {name}'s official app from its DefiLlama page (defillama.com/protocol/{slug}) and connect a fresh wallet you use only for farming.",
    "Use the product on {chain}: open a real position, deposit, swap or stake inside the app, and keep it open rather than dusting it once and leaving.",
    "Come back 2-3 times a week for 6-12 weeks and repeat a small genuine action each time; snapshots reward sustained users, not one-off wallets.",
    "Check the app and its docs for a points, XP or leaderboard program; the actions that earn points are the actions that matter.",
    "Expect {cost} in gas per action on {chain}; keep each action small so fees never eat the position.",
    "Stay safe: never share a seed phrase, never sign a blind approval, and revoke token approvals you no longer use.",
  ],
};

export function fillTemplate(
  tpl: string,
  row: { name: string; slug: string; primary_chain: string | null; farm_cost: string },
): string {
  return tpl
    .replaceAll("{name}", row.name)
    .replaceAll("{chain}", row.primary_chain ?? "its main chain")
    .replaceAll("{slug}", row.slug)
    .replaceAll("{cost}", row.farm_cost);
}

export function buildFarmSteps(row: {
  name: string; slug: string; category: string | null;
  primary_chain: string | null; farm_cost: string;
}): string[] {
  const tpl = (row.category && FARM_TEMPLATES[row.category]) || FARM_TEMPLATES.__generic;
  const steps = tpl.map((t) => fillTemplate(t, row).trim());
  for (const s of steps) {
    if (s.length < 20 || s.length > 600) {
      throw new Error(`farm step out of 20-600 chars (${s.length}): ${s.slice(0, 80)}…`);
    }
  }
  return steps;
}

// --- Board build ---------------------------------------------------------------
export function buildBoard(snapshot: Snapshot, sha256: string): Board {
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const peers = snapshot.protocols.filter((p) => p.mcap_usd != null && p.tvl_usd > 0);
  const peerMultByCat = new Map<string, number[]>();
  for (const p of peers) {
    const key = p.category ?? "";
    const arr = peerMultByCat.get(key);
    if (arr) arr.push(p.mcap_usd! / p.tvl_usd);
    else peerMultByCat.set(key, [p.mcap_usd! / p.tvl_usd]);
  }
  const globalMedian = median(peers.map((p) => p.mcap_usd! / p.tvl_usd));
  // Fallback for thin categories: the median of the per-category medians,
  // so no single giant category sets the fallback for everyone.
  const fallbackMedian = median(
    [...peerMultByCat.values()].map((ms) => median(ms)),
  );

  const multipleFor = (category: string | null): { multiple: number; peers: number; fallback: boolean } => {
    const ms = peerMultByCat.get(category ?? "") ?? [];
    if (ms.length >= 5) {
      const cap = ms.length >= 10 ? 10 : 5;
      return { multiple: Math.max(0.05, Math.min(median(ms), cap)), peers: ms.length, fallback: false };
    }
    return { multiple: Math.max(0.05, Math.min(fallbackMedian, 5)), peers: ms.length, fallback: true };
  };

  const makeRow = (p: SnapshotProtocol): BoardRow => {
    const { multiple, peers: nPeers, fallback } = multipleFor(p.category);
    const age = ageYears(p.listed_at, snapshot.as_of);
    const implied = Math.max(
      1,
      Math.round(p.tvl_usd * multiple * growthFactor(p.change_7d) * ageFactor(age)),
    );
    const confidence: BoardRow["confidence"] =
      nPeers >= 10 && p.tvl_usd >= 50_000_000
        ? "High"
        : nPeers >= 5 && p.tvl_usd >= 10_000_000
          ? "Medium"
          : "Low";
    const primaryChain = p.chains[0] ?? null;
    const base: Omit<BoardRow, "rank" | "farm_steps" | "rationale"> = {
      slug: p.slug,
      name: p.name,
      implied_value_usd: implied,
      category: p.category,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_years: age,
      multiple: Math.round(multiple * 1000) / 1000,
      multiple_peers: nPeers,
      multiple_fallback: fallback,
      confidence,
      primary_chain: primaryChain,
      chains: p.chains,
      farm_cost: feeTier(primaryChain),
      farm_cadence: FARM_CADENCE,
    };
    const rationale =
      `${p.name} records no token and holds ${fmtUsd(p.tvl_usd)} of TVL` +
      (p.change_7d == null ? "" : ` (${p.change_7d > 0 ? "+" : ""}${p.change_7d.toFixed(1)}% over 7 days)`) +
      (age == null ? "" : ` after ${age} years live`) +
      `. ${p.category ?? "Uncategorized"} tokens trade at a median ${multiple.toFixed(2)}x market-cap/TVL` +
      ` across ${nPeers} tokenized peer${nPeers === 1 ? "" : "s"}${fallback ? " (thin peer set — global median used)" : ""},` +
      ` so the launch is implied at ${fmtUsd(implied)}.`;
    const row = { ...base, rank: 0, farm_steps: [] as string[], rationale } as BoardRow;
    row.farm_steps = buildFarmSteps(row);
    return row;
  };

  const watchlistSlugs = snapshot.watchlist.filter((s) => bySlug.has(s));
  const watchlistRows = watchlistSlugs.map((s) => makeRow(bySlug.get(s)!));
  const watchSet = new Set(watchlistSlugs);
  const extras = snapshot.protocols
    .filter((p) => !watchSet.has(p.slug) && isTokenless(p) && !isExcludedByHouseRule(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, EXTRA_ROWS)
    .map((p) => makeRow(p));
  const rows = [...watchlistRows, ...extras];
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || b.tvl_usd - a.tvl_usd || a.name.localeCompare(b.name));
  rows.forEach((r, i) => (r.rank = i + 1));

  return {
    meta: {
      title: "Token Launch Radar — every tokenless DeFi protocol, ranked by implied launch value",
      generated_at: snapshot.as_of,
      snapshot: {
        as_of: snapshot.as_of,
        source: snapshot.source,
        floor_usd: snapshot.floor_usd,
        protocols: snapshot.protocols.length,
        watchlist: snapshot.watchlist.length,
        sha256,
      },
      method: {
        token_test:
          "A protocol records no token when both gecko_id and symbol are null in the snapshot.",
        implied_value:
          "Implied value = TVL x the category median market-cap/TVL of tokenized peers in the snapshot, x a 7-day growth factor (at most +-25%), x an age factor (up to +20% for 4+ years recording no token). Thin categories fall back to the median of the per-category medians.",
        winsor:
          "Multiples are winsorized to [0.05, 10] where a category has 10+ tokenized peers, else [0.05, 5].",
        board: `Every watchlist slug, plus the ${EXTRA_ROWS} pre-token protocols with the most TVL that the house rule does not exclude.`,
      },
      totals: {
        rows: rows.length,
        watchlist_covered: watchlistRows.length,
        tvl_usd: rows.reduce((s, r) => s + r.tvl_usd, 0),
        implied_usd: rows.reduce((s, r) => s + r.implied_value_usd, 0),
      },
    },
    rows,
  };
}

// --- Compact dashboard data ----------------------------------------------------
// The dossier shows every dashboard source file whole only while the total
// fits in 65,536 bytes, so data.js is compact: rows as arrays, farm steps as
// per-category templates with {name}/{chain}/{slug}/{cost} placeholders that
// app.js fills in. The strings are the same ones board.json carries.
export type CompactRow = [
  string, string, string | null, number, number, number, number, boolean,
  "High" | "Medium" | "Low", string | null, number | null, number | null, string,
];

export function toCompact(board: Board): { meta: Board["meta"]; rows: CompactRow[]; templates: Record<string, string[]> } {
  // The dashboard must name no http(s) address anywhere in its files (gate),
  // so the snapshot source is stored scheme-less here; board.json keeps it whole.
  // The sealed source is "DefiLlama https://…", not scheme-leading, so the
  // strip must remove the scheme wherever it sits, not just at the start.
  const meta = JSON.parse(JSON.stringify(board.meta)) as Board["meta"];
  meta.snapshot.source = meta.snapshot.source.replace(/https?:\/\//g, "");
  return {
    meta,
    rows: board.rows.map((r): CompactRow => [
      r.slug, r.name, r.category, r.tvl_usd, r.implied_value_usd, r.multiple,
      r.multiple_peers, r.multiple_fallback, r.confidence, r.primary_chain,
      r.change_7d, r.age_years, r.farm_cost,
    ]),
    templates: FARM_TEMPLATES,
  };
}

// --- CLI -----------------------------------------------------------------------
export function resolvePaths(args: string[]): { input: string; outDir: string } {
  const inputFlag = args.indexOf("--input");
  const outFlag = args.indexOf("--output");
  const envOut = process.env.MAKEFUN_OUTPUT_DIR;
  const input =
    inputFlag >= 0 ? args[inputFlag + 1] : existsSync("/input/snapshot.json") ? "/input/snapshot.json" : DEV_SNAPSHOT_PATH;
  const outDir =
    outFlag >= 0 ? args[outFlag + 1] : envOut ?? (existsSync("/input/snapshot.json") ? "/output" : "out");
  return { input, outDir };
}

export function main(): void {
  const args = process.argv.slice(2);
  const { input, outDir } = resolvePaths(args);
  const raw = readFileSync(input);
  const snapshot = JSON.parse(raw.toString("utf8")) as Snapshot;
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const board = buildBoard(snapshot, sha256);
  if (board.rows.length < MIN_BOARD_ROWS) {
    throw new Error(`board has ${board.rows.length} rows, below the ${MIN_BOARD_ROWS}-row gate minimum`);
  }

  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "dashboard"), { recursive: true });
  mkdirSync(join(outDir, "screenshots"), { recursive: true });

  // board.json
  writeFileSync(join(outDir, "board.json"), JSON.stringify(board, null, 2) + "\n");

  // dashboard data (compact) — written into the source dashboard/ for dev,
  // then the whole dashboard/ is copied to the output.
  const compact = toCompact(board);
  const dataJs =
    `// Generated by main.ts from the sealed snapshot — do not edit by hand.\n` +
    `// Regenerate with: node main.ts\n` +
    `window.TOKEN_RADAR_BOARD = ${JSON.stringify(compact)};\n`;
  writeFileSync(join(DASHBOARD_DIR, "data.js"), dataJs);
  cpSync(DASHBOARD_DIR, join(outDir, "dashboard"), { recursive: true });
  if (existsSync(SCREENSHOTS_DIR)) {
    cpSync(SCREENSHOTS_DIR, join(outDir, "screenshots"), { recursive: true });
  }

  // dossier.json — the kit's real buildDossier (vendor/makefun-board.ts).
  // The gate compares byte for byte, so this must be the library's own
  // output. Screenshots must exist first: buildDossier refuses an empty
  // screenshots/ directory.
  const shotNames = existsSync(SCREENSHOTS_DIR)
    ? readdirSync(SCREENSHOTS_DIR).filter((n) => !n.startsWith("."))
    : [];
  if (shotNames.length < 3) {
    throw new Error(
      `screenshots/ holds ${shotNames.length} image${shotNames.length === 1 ? "" : "s"}: hand in 3, the board, a detail view and a filtered view`,
    );
  }
  const dossierBytes = buildDossier(outDir, {
    text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 524288 },
    dashboard: { max_files: 400, max_bytes: 4194304 },
  });
  writeFileSync(join(outDir, "dossier.json"), dossierBytes);

  console.log(`Board built: ${board.rows.length} rows (${board.meta.totals.watchlist_covered} watchlist covered)`);
  console.log(`  TVL tracked:   ${fmtUsd(board.meta.totals.tvl_usd)}`);
  console.log(`  Implied value: ${fmtUsd(board.meta.totals.implied_usd)}`);
  console.log(`  Top 5: ${board.rows.slice(0, 5).map((r) => `${r.name} (${fmtUsd(r.implied_value_usd)})`).join(", ")}`);
  console.log(`  Wrote ${join(outDir, "board.json")}, ${join(outDir, "dashboard/")}, ${join(outDir, "dossier.json")} (${dossierBytes.length} bytes)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
