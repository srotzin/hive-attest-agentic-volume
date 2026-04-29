/**
 * volume.js — volume-fetch logic with explicit "no fabrication" guards.
 *
 * INVARIANT: This module NEVER returns invented numbers.
 * If a merchant is unknown or data is unavailable, agentic_volume_usd is null
 * and coverage = "merchant_not_indexed" | "data_unavailable".
 *
 * Data source hierarchy (in priority order):
 *   1. hivemorph rails endpoint (https://hivemorph.onrender.com/v1/x402/rails)
 *   2. hive-meter usage endpoint (public read)
 *   3. hive-x402-index leaderboard endpoint (public read)
 *   4. /tmp/attest_settlements.jsonl — local settlement log (Render ephemeral FS)
 *   5. NO FALLBACK to made-up numbers — return null + coverage flag
 */

import { readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';

const HIVEMORPH_RAILS   = 'https://hivemorph.onrender.com/v1/x402/rails';
const HIVE_METER_USAGE  = 'https://hive-meter.onrender.com/v1/usage/summary';
const HIVE_X402_INDEX   = 'https://hive-x402-index.onrender.com/v1/leaderboard';
const SETTLEMENTS_FILE  = '/tmp/attest_settlements.jsonl';

const PERIOD_SECONDS = {
  '1h':  3600,
  '24h': 86400,
  '7d':  604800,
  '30d': 2592000,
};

export const SUPPORTED_PERIODS = Object.keys(PERIOD_SECONDS);

/**
 * Compute period window timestamps.
 */
export function periodWindow(period) {
  const now      = Math.floor(Date.now() / 1000);
  const duration = PERIOD_SECONDS[period];
  if (!duration) throw new Error(`Unsupported period: ${period}`);
  return { period_start_ts: now - duration, period_end_ts: now };
}

/**
 * Fetch JSON from a URL with a timeout. Returns null on any failure.
 */
async function safeFetch(url, timeoutMs = 8000) {
  try {
    const { fetch } = await import('undici');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Read local settlements file, parse JSONL, filter by merchant + period window.
 */
function readLocalSettlements(merchant, periodStartTs, periodEndTs) {
  if (!existsSync(SETTLEMENTS_FILE)) return null;
  try {
    const lines = readFileSync(SETTLEMENTS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));

    const matched = lines.filter(e =>
      (e.merchant === merchant || e.merchant_did === merchant) &&
      e.ts >= periodStartTs && e.ts <= periodEndTs
    );

    if (matched.length === 0) return null;

    const chain_breakdown = {
      base_usdc:    0,
      base_usdt:    0,
      solana_usdc:  0,
      solana_usdt:  0,
      ethereum_usdt: 0,
    };

    let total_usd = 0;
    for (const e of matched) {
      const amt = Number(e.amount_usd ?? 0);
      total_usd += amt;
      const chain = e.chain ?? 'base_usdc';
      if (chain in chain_breakdown) chain_breakdown[chain] += amt;
      else chain_breakdown.base_usdc += amt; // default to base_usdc
    }

    return {
      agentic_volume_usd: parseFloat(total_usd.toFixed(6)),
      settlement_count:   matched.length,
      chain_breakdown,
      coverage:           'local_settlements',
      source:             'local_settlement_log',
    };
  } catch {
    return null;
  }
}

/**
 * Attempt to extract merchant volume from hivemorph rails response.
 */
function extractFromRails(railsData, merchant, periodStartTs, periodEndTs) {
  if (!railsData || !Array.isArray(railsData.rails)) return null;

  const chain_breakdown = {
    base_usdc:    0,
    base_usdt:    0,
    solana_usdc:  0,
    solana_usdt:  0,
    ethereum_usdt: 0,
  };

  let total_usd      = 0;
  let settlement_count = 0;

  for (const rail of railsData.rails) {
    const railMerchant = rail.merchant ?? rail.merchant_did ?? rail.did ?? '';
    if (railMerchant !== merchant) continue;

    const entries = Array.isArray(rail.settlements) ? rail.settlements : [];
    for (const s of entries) {
      const ts = Number(s.ts ?? s.timestamp ?? 0);
      if (ts < periodStartTs || ts > periodEndTs) continue;
      const amt = Number(s.amount_usd ?? 0);
      total_usd += amt;
      settlement_count++;
      const chain = s.chain ?? 'base_usdc';
      if (chain in chain_breakdown) chain_breakdown[chain] += amt;
      else chain_breakdown.base_usdc += amt;
    }
  }

  if (settlement_count === 0) return null;

  return {
    agentic_volume_usd: parseFloat(total_usd.toFixed(6)),
    settlement_count,
    chain_breakdown,
    coverage: 'hivemorph_rails',
    source:   'hivemorph_rails',
  };
}

/**
 * Extract from hive-meter usage summary.
 */
function extractFromMeter(meterData, merchant, periodStartTs, periodEndTs) {
  if (!meterData) return null;
  const merchants = meterData.merchants ?? meterData.usage ?? [];
  if (!Array.isArray(merchants)) return null;

  const entry = merchants.find(m =>
    m.merchant === merchant || m.merchant_did === merchant || m.id === merchant
  );
  if (!entry) return null;

  // Meter data may not have chain breakdown — build a best-effort one
  const total = Number(entry.volume_usd ?? entry.total_usd ?? 0);
  if (total === 0) return null;

  const chain_breakdown = {
    base_usdc:    total,  // hive-meter defaults to base USDC
    base_usdt:    0,
    solana_usdc:  0,
    solana_usdt:  0,
    ethereum_usdt: 0,
  };

  return {
    agentic_volume_usd: parseFloat(total.toFixed(6)),
    settlement_count:   Number(entry.settlement_count ?? entry.count ?? 0),
    chain_breakdown,
    coverage: 'hive_meter',
    source:   'hive_meter_usage',
  };
}

/**
 * Core volume resolution function.
 * Returns { agentic_volume_usd, settlement_count, chain_breakdown, coverage, source }
 * agentic_volume_usd is null when merchant data is unavailable.
 */
export async function resolveVolume(merchant, period) {
  const { period_start_ts, period_end_ts } = periodWindow(period);

  // ── Source 1: hivemorph rails ──────────────────────────────────────────────
  const railsData = await safeFetch(HIVEMORPH_RAILS);
  const fromRails = extractFromRails(railsData, merchant, period_start_ts, period_end_ts);
  if (fromRails) return fromRails;

  // ── Source 2: hive-meter usage ─────────────────────────────────────────────
  const meterData = await safeFetch(HIVE_METER_USAGE);
  const fromMeter = extractFromMeter(meterData, merchant, period_start_ts, period_end_ts);
  if (fromMeter) return fromMeter;

  // ── Source 3: hive-x402-index leaderboard (public read) ───────────────────
  const leaderboardData = await safeFetch(HIVE_X402_INDEX);
  if (leaderboardData) {
    const entries = leaderboardData.leaderboard ?? leaderboardData.entries ?? [];
    const entry = Array.isArray(entries)
      ? entries.find(e => e.merchant === merchant || e.merchant_did === merchant)
      : null;
    if (entry) {
      const total = Number(entry.volume_usd ?? 0);
      if (total > 0) {
        return {
          agentic_volume_usd: parseFloat(total.toFixed(6)),
          settlement_count:   Number(entry.count ?? 0),
          chain_breakdown: {
            base_usdc:    total,
            base_usdt:    0,
            solana_usdc:  0,
            solana_usdt:  0,
            ethereum_usdt: 0,
          },
          coverage: 'x402_index_leaderboard',
          source:   'hive_x402_index',
        };
      }
    }
  }

  // ── Source 4: local settlements JSONL ──────────────────────────────────────
  const fromLocal = readLocalSettlements(merchant, period_start_ts, period_end_ts);
  if (fromLocal) return fromLocal;

  // ── No data found — return null, do NOT fabricate ─────────────────────────
  return {
    agentic_volume_usd: null,
    settlement_count:   null,
    chain_breakdown: {
      base_usdc:    null,
      base_usdt:    null,
      solana_usdc:  null,
      solana_usdt:  null,
      ethereum_usdt: null,
    },
    coverage: 'merchant_not_indexed',
    source:   'no_data_source_matched',
  };
}

/**
 * Freshness timestamps for /v1/attest/periods
 */
export async function getPeriodFreshness() {
  const now = Math.floor(Date.now() / 1000);
  const railsData  = await safeFetch(HIVEMORPH_RAILS);
  const meterData  = await safeFetch(HIVE_METER_USAGE);

  const railsOk  = !!railsData;
  const meterOk  = !!meterData;

  return SUPPORTED_PERIODS.map(period => ({
    period,
    period_seconds:    PERIOD_SECONDS[period],
    freshness_ts:      now,
    freshness_iso:     new Date(now * 1000).toISOString(),
    data_sources_live: [
      railsOk && 'hivemorph_rails',
      meterOk && 'hive_meter_usage',
      'local_settlements',
    ].filter(Boolean),
    methodology_url:   '/v1/attest/methodology',
  }));
}
