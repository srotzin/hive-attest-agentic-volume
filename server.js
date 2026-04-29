/**
 * hive-attest-agentic-volume — server.js
 *
 * Spectral-signed, audit-grade attestations of agentic stablecoin transaction
 * volume by merchant. Pairs with USPTO #19 Spectral filing.
 *
 * Brand gold #C08D23 | The Hivery IQ
 * Settlement: Base 8453 USDC → Monroe 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e
 */

import express           from 'express';
import { applyLoyaltyDiscount, buildLoyaltyChallenge } from './lib/loyalty.js';
import { createHash, randomUUID }    from 'crypto';
import { appendFileSync } from 'fs';
import { readFile }      from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  generateKeypair,
  loadSigningKey,
  signAttestation,
  verifyAttestation,
} from './lib/spectral.js';
import {
  resolveVolume,
  periodWindow,
  getPeriodFreshness,
  SUPPORTED_PERIODS,
} from './lib/volume.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── constants ─────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 3000;
const MONROE          = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
const USDC_CONTRACT   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_CHAIN_ID   = 8453;
const PRICE_STANDARD  = '1000000';   // $1 USDC atomic
const PRICE_AUDIT     = '50000000';  // $50 USDC atomic
const SETTLEMENTS_FILE = '/tmp/attest_settlements.jsonl';
const METHODOLOGY_URL  = '/v1/attest/methodology';
const SCHEMA_VERSION   = '1.0.0';

// ── key initialisation ────────────────────────────────────────────────────────
let SIGNING_KEY   = null;
let PUBLIC_KEY_B64 = '';

async function initKeys() {
  if (process.env.SPECTRAL_PRIVKEY_B64 && process.env.SPECTRAL_PUBKEY_B64) {
    SIGNING_KEY    = await loadSigningKey(process.env.SPECTRAL_PRIVKEY_B64);
    PUBLIC_KEY_B64 = process.env.SPECTRAL_PUBKEY_B64;
    console.log('[spectral] Keys loaded from env.');
  } else {
    // Ephemeral keypair for smoke-test / dev without env vars
    console.warn('[spectral] No SPECTRAL_PRIVKEY_B64 found — generating ephemeral keypair. NOT FOR PRODUCTION.');
    const { privateKeyB64, publicKeyB64 } = await generateKeypair();
    SIGNING_KEY    = await loadSigningKey(privateKeyB64);
    PUBLIC_KEY_B64 = publicKeyB64;
    console.log(`[spectral] Ephemeral pubkey: ${publicKeyB64.slice(0, 24)}...`);
  }
}

// ── 402 challenge builder (Rail 3 loyalty-aware) ──────────────────────────────
async function build402Challenge(req, res, tier) {
  const isAudit    = tier === 'audit';
  const baseAmount = isAudit ? Number(PRICE_AUDIT) : Number(PRICE_STANDARD);
  const desc       = isAudit
    ? 'Audit-grade Spectral-signed attestation of agentic stablecoin volume — extended methodology disclosure.'
    : 'Spectral-signed attestation of agentic stablecoin volume.';

  // Rail 3: apply loyalty discount
  const loyalty = await applyLoyaltyDiscount(req, res, baseAmount);

  return {
    challenge: buildLoyaltyChallenge({
      adjustedPrice:      loyalty.adjustedPrice,
      discountAppliedBps: loyalty.discountAppliedBps,
      resource:           `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      description:        desc,
      chainId:            BASE_CHAIN_ID,
    }),
    loyalty,
    basePriceAtomic: baseAmount,
  };
}

function is402Paid(req) {
  // Accept if X-PAYMENT header present (x402 client sends this after payment)
  // In production, verify the payment receipt cryptographically.
  // For now: presence of X-PAYMENT header signals paid.
  return !!req.headers['x-payment'];
}

function logSettlement(req, tier) {
  try {
    const entry = {
      ts:          Math.floor(Date.now() / 1000),
      merchant:    req.params.merchant ?? 'unknown',
      period:      req.params.period   ?? 'unknown',
      tier,
      amount_usd:  tier === 'audit' ? 50 : 1,
      chain:       'base_usdc',
      payer:       req.headers['x-payment-from'] ?? null,
    };
    appendFileSync(SETTLEMENTS_FILE, JSON.stringify(entry) + '\n');
  } catch { /* ephemeral FS may not be writable — non-fatal */ }
}

// ── attestation ID ────────────────────────────────────────────────────────────
function attestationId(canonical, generated_at) {
  return createHash('sha256')
    .update(canonical + generated_at, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

// ── in-memory attestation cache (per instance lifetime) ───────────────────────
const ATTEST_STORE = new Map();

// ── app ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── GET / ──────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service:       'hive-attest-agentic-volume',
    version:       SCHEMA_VERSION,
    description:   'Spectral-signed, audit-grade attestations of agentic stablecoin transaction volume by merchant.',
    pairs_with:    'USPTO #19 Spectral Filing',
    brand_gold:    '#C08D23',
    settlement: {
      chain:    'base',
      chain_id:  BASE_CHAIN_ID,
      asset:    'USDC',
      contract:  USDC_CONTRACT,
      payTo:     MONROE,
    },
    endpoints: {
      health:       '/health',
      agent_card:   '/.well-known/agent.json',
      mcp:          '/mcp',
      attest:       '/v1/attest/agentic-volume/:merchant/:period',
      verify:       '/v1/attest/verify/:attestation_id',
      periods:      '/v1/attest/periods',
      methodology:  '/v1/attest/methodology',
    },
    pricing: {
      standard: '$1.00 USDC per attestation',
      audit:    '$50.00 USDC per attestation (?tier=audit)',
    },
  });
});

// ── GET /health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:         'ok',
    service:        'hive-attest-agentic-volume',
    schema_version: SCHEMA_VERSION,
    ts:             new Date().toISOString(),
    keys_loaded:    !!SIGNING_KEY,
    pubkey_prefix:  PUBLIC_KEY_B64.slice(0, 16) + '...',
  });
});

// ── GET /.well-known/agent.json ───────────────────────────────────────────────
app.get('/.well-known/agent.json', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    schema_version:  '1',
    name:            'Hive Attest Agentic Volume',
    description:     'Spectral-signed, audit-grade attestations of agentic stablecoin transaction volume by merchant. Pairs with USPTO #19.',
    version:         SCHEMA_VERSION,
    brand_color:     '#C08D23',
    url:             baseUrl,
    capabilities:    ['attest_volume', 'verify_attestation', 'list_periods', 'methodology'],
    mcp_endpoint:    `${baseUrl}/mcp`,
    spectral: {
      public_key_b64:   PUBLIC_KEY_B64,
      signature_algo:   'ed25519',
      schema_version:   SCHEMA_VERSION,
      pairs_with:       'USPTO #19 Spectral Filing',
    },
    settlement: {
      chain:    'base',
      chain_id:  BASE_CHAIN_ID,
      asset:    'USDC',
      contract:  USDC_CONTRACT,
      payTo:     MONROE,
      pricing: {
        standard_atomic: PRICE_STANDARD,
        audit_atomic:    PRICE_AUDIT,
      },
    },
    contact: {
      name:  'Steve Rotzin',
      email: 'steve@thehiveryiq.com',
      org:   'The Hivery IQ',
    },
  });
});

// ── POST /mcp — JSON-RPC 2.0 MCP server (Streamable-HTTP) ────────────────────
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;
  if (jsonrpc !== '2.0') {
    return res.status(400).json({ error: 'invalid jsonrpc version' });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0', id,
      result: {
        tools: [
          {
            name:        'attest_volume',
            description: 'Fetch a Spectral-signed, audit-grade attestation of agentic stablecoin volume for a merchant over a period. Requires x402 payment ($1 USDC standard, $50 USDC audit).',
            inputSchema: {
              type: 'object',
              properties: {
                merchant: { type: 'string', description: 'Merchant DID or hostname' },
                period:   { type: 'string', enum: SUPPORTED_PERIODS, description: 'Reporting period' },
                tier:     { type: 'string', enum: ['standard', 'audit'], default: 'standard' },
                x_payment: { type: 'string', description: 'x402 payment token (required)' },
              },
              required: ['merchant', 'period', 'x_payment'],
            },
          },
          {
            name:        'verify_attestation',
            description: 'Re-verify the ed25519 signature of a stored attestation. Public read, no payment required.',
            inputSchema: {
              type: 'object',
              properties: {
                attestation_id: { type: 'string', description: 'Attestation ID (32-char hex)' },
              },
              required: ['attestation_id'],
            },
          },
          {
            name:        'list_periods',
            description: 'List supported reporting periods with current data freshness timestamps. Public read.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;

    if (toolName === 'list_periods') {
      const periods = await getPeriodFreshness();
      return res.json({ jsonrpc: '2.0', id, result: { periods } });
    }

    if (toolName === 'verify_attestation') {
      const { attestation_id } = params?.arguments ?? {};
      const envelope = ATTEST_STORE.get(attestation_id);
      if (!envelope) {
        return res.json({
          jsonrpc: '2.0', id,
          result: { error: 'attestation_not_found', attestation_id },
        });
      }
      const verification = await verifyAttestation(envelope);
      return res.json({ jsonrpc: '2.0', id, result: { ...envelope, ...verification } });
    }

    if (toolName === 'attest_volume') {
      const { merchant, period, tier, x_payment } = params?.arguments ?? {};
      if (!x_payment) {
        // Rail 3: loyalty-aware challenge in MCP error response
        const { challenge, loyalty } = await build402Challenge(req, res, tier);
        return res.json({
          jsonrpc: '2.0', id,
          error: {
            code: 402,
            message: loyalty.discountAppliedBps > 0
              ? `Payment required. Rail 3 discount: ${loyalty.discountAppliedBps / 100}% off applied.`
              : 'Payment required. Present X-Hive-Prior-Receipts for loyalty discount (5%/receipt, max 25%).',
            data: challenge
          },
        });
      }
      // Process attestation
      const result = await buildAttestation(merchant, period, tier ?? 'standard');
      return res.json({ jsonrpc: '2.0', id, result });
    }

    return res.json({
      jsonrpc: '2.0', id,
      error: { code: -32601, message: 'Method not found' },
    });
  }

  return res.json({
    jsonrpc: '2.0', id,
    error: { code: -32601, message: `Unknown method: ${method}` },
  });
});

// ── GET /mcp — capability discovery ───────────────────────────────────────────
app.get('/mcp', (req, res) => {
  res.json({
    name:           'hive-attest-agentic-volume',
    version:        SCHEMA_VERSION,
    protocol:       'MCP 2024-11-05',
    transport:      'Streamable-HTTP',
    endpoint:       '/mcp',
    tools_count:    3,
  });
});

// ── core attestation builder ──────────────────────────────────────────────────
async function buildAttestation(merchant, period, tier) {
  const generated_at = new Date().toISOString();
  const { period_start_ts, period_end_ts } = periodWindow(period);

  const volumeData = await resolveVolume(merchant, period);

  const fields = {
    merchant,
    period,
    period_start_ts,
    period_end_ts,
    agentic_volume_usd: volumeData.agentic_volume_usd,
    settlement_count:   volumeData.settlement_count,
    chain_breakdown:    volumeData.chain_breakdown,
    generated_at,
  };

  const sigResult = await signAttestation(fields, SIGNING_KEY, PUBLIC_KEY_B64);

  // Derive attestation_id deterministically
  const { buildCanonicalPayload } = await import('./lib/spectral.js');
  const canonical = buildCanonicalPayload(fields);
  const attest_id = attestationId(canonical, generated_at);

  const envelope = {
    attestation_id:       attest_id,
    schema_version:       SCHEMA_VERSION,
    merchant,
    period,
    period_start_ts,
    period_end_ts,
    agentic_volume_usd:   volumeData.agentic_volume_usd,
    settlement_count:     volumeData.settlement_count,
    chain_breakdown:      volumeData.chain_breakdown,
    coverage:             volumeData.coverage,
    source:               volumeData.source,
    methodology_url:      METHODOLOGY_URL,
    pairs_with:           'USPTO #19 Spectral Filing',
    generated_at,
    signature:            sigResult.signature_hex,
    signature_algo:       'ed25519',
    public_key:           PUBLIC_KEY_B64,
    signed_payload_sha256: sigResult.signed_payload_sha256,
    audit_hint:           tier === 'audit'
      ? 'Audit-grade tier: full methodology at /v1/attest/methodology. Signature verifiable at /v1/attest/verify/' + attest_id + '.'
      : 'Verify signature at /v1/attest/verify/' + attest_id + '.',
    settlement: {
      chain:    'base',
      chain_id:  BASE_CHAIN_ID,
      asset:    'USDC',
      contract:  USDC_CONTRACT,
      payTo:     MONROE,
      tier,
      price_atomic: tier === 'audit' ? PRICE_AUDIT : PRICE_STANDARD,
    },
  };

  // Store for verify endpoint
  ATTEST_STORE.set(attest_id, envelope);

  return envelope;
}


// ── BOGO redemption middleware (X-Hive-BOGO-Token) ─────────────────────────
// Phase 1: calls hive-gamification /v1/bogo/redeem; bypasses 402 on consumed:true.
// Phase 2 (planned): zero-trust redemption with token-bound HMAC.
async function bogoRedeemMiddleware(req, res, next) {
  const token = req.headers['x-hive-bogo-token'];
  if (!token) return next();
  try {
    const r = await fetch('https://hive-gamification.onrender.com/v1/bogo/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, mechanic_id: 'volume-attestation' }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const j = await r.json();
      if (j.consumed === true) {
        req._bogo_redeemed = true;
        import('fs').then(({ appendFileSync }) => {
          try { appendFileSync('/tmp/attest_agentic_volume_bogo_redemptions.jsonl', JSON.stringify({ token: token.slice(0, 12), mechanic_id: 'volume-attestation', ts: Date.now() }) + '\n'); } catch (_) {}
        });
        return next();
      }
    }
  } catch (_) {}
  return next();
}

// ── GET /v1/attest/sample — Rail 2 Catnip free-read ─────────────────────────
const _catnipStore = new Map();
app.get('/v1/attest/sample', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'anon';
  const now = Date.now();
  let rec = _catnipStore.get(ip);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + 3600000 };
  rec.count++;
  _catnipStore.set(ip, rec);
  res.set('Hive-Referral-Trace', randomUUID());
  res.set('Hive-Brand-Gold', '#C08D23');
  res.set('X-RateLimit-Limit', '60');
  res.set('X-RateLimit-Remaining', String(Math.max(0, 60 - rec.count)));
  res.set('X-RateLimit-Reset', new Date(rec.resetAt).toISOString());
  if (rec.count > 60) return res.status(429).json({ error: 'Rate limit: 60 req/IP/hour', retry_after: new Date(rec.resetAt).toISOString() });
  const merchantId = 'did:hive:sample-merchant-a1b2c3d4';
  const volume = 347821;
  const txCount = 7364;
  res.json({
    attestation_id: `attest-${Math.random().toString(36).slice(2,10)}`,
    schema_version: '1.0.0',
    merchant_id: merchantId,
    period: '2026-04',
    agentic_volume_usdc: volume,
    transaction_count: txCount,
    avg_transaction_usdc: (volume / txCount).toFixed(2),
    settlement_chain: 'base:8453',
    confidence_score: 0.97,
    signed_at: new Date().toISOString(),
    methodology_url: 'https://hive-attest-agentic-volume.onrender.com/v1/attest/methodology',
    note: 'Sample attestation — anonymized non-production data. Real audit attestations require payment.',
    next_paid_endpoint: {
      path: 'GET /v1/attest/agentic-volume/:merchant/:period',
      price: '$1.00 USDC (standard) | $50.00 USDC (audit-grade)',
      url: 'https://hive-attest-agentic-volume.onrender.com/v1/attest/agentic-volume/:merchant/:period',
    },
  });
});

// ── GET /v1/attest/agentic-volume/:merchant/:period ───────────────────────────
app.get('/v1/attest/agentic-volume/:merchant/:period', bogoRedeemMiddleware, async (req, res) => {
  const { merchant, period } = req.params;
  const tier = req.query.tier === 'audit' ? 'audit' : 'standard';

  if (!SUPPORTED_PERIODS.includes(period)) {
    return res.status(400).json({
      error:    'invalid_period',
      message:  `Period must be one of: ${SUPPORTED_PERIODS.join(', ')}`,
      received: period,
    });
  }

  // ── 402 gate (BOGO bypass honored) ──────────────────────────────────────────
  if (!req._bogo_redeemed && !is402Paid(req)) {
    // Rail 3: loyalty-aware challenge builder
    const { challenge, loyalty } = await build402Challenge(req, res, tier);
    const priceLabel = tier === 'audit' ? '$50.00' : '$1.00';
    const discountNote = loyalty.discountAppliedBps > 0
      ? ` Rail 3 receipt-gravity discount: ${loyalty.discountAppliedBps / 100}% off applied.`
      : ' Present X-Hive-Prior-Receipts for loyalty discount (5% per receipt, max 25%).';
    res.status(402)
       .set('X-Payment-Required', 'true')
       .set('X-Price-USDC', tier === 'audit' ? '50' : '1')
       .json({
         error:          'payment_required',
         x402_challenge: challenge,
         message:        `Payment of ${priceLabel} USDC required on Base mainnet. Include X-PAYMENT header with payment receipt.${discountNote}`,
         bogo: {
           first_use_free: true,
           claim_endpoint: 'https://hive-gamification.onrender.com/v1/bogo/claim',
           redeem_header: 'X-Hive-BOGO-Token',
           mechanic_id: 'volume-attestation',
         },
       });
    return;
  }

  logSettlement(req, tier);

  try {
    const envelope = await buildAttestation(merchant, period, tier);
    res.json(envelope);
  } catch (err) {
    console.error('[attest] Error:', err.message);
    res.status(500).json({ error: 'attestation_failed', message: err.message });
  }
});

// ── GET /v1/attest/verify/:attestation_id ─────────────────────────────────────
app.get('/v1/attest/verify/:attestation_id', async (req, res) => {
  const { attestation_id } = req.params;
  const envelope = ATTEST_STORE.get(attestation_id);

  if (!envelope) {
    return res.status(404).json({
      error:          'attestation_not_found',
      attestation_id,
      note:           'Attestations are cached in-memory per service instance. If this instance restarted, the attestation is not available for server-side re-verification. Clients may re-verify locally using the public key in /.well-known/agent.json.',
    });
  }

  try {
    const verification = await verifyAttestation(envelope);
    res.json({
      attestation_id,
      ...verification,
      envelope,
      public_key_source: '/.well-known/agent.json',
      methodology_url:   METHODOLOGY_URL,
    });
  } catch (err) {
    res.status(500).json({ error: 'verification_failed', message: err.message });
  }
});

// ── GET /v1/attest/periods ────────────────────────────────────────────────────
app.get('/v1/attest/periods', async (req, res) => {
  try {
    const periods = await getPeriodFreshness();
    res.json({
      schema_version: SCHEMA_VERSION,
      periods,
      methodology_url: METHODOLOGY_URL,
    });
  } catch (err) {
    res.status(500).json({ error: 'periods_fetch_failed', message: err.message });
  }
});

// ── GET /v1/attest/methodology ────────────────────────────────────────────────
app.get('/v1/attest/methodology', async (req, res) => {
  try {
    const md = await readFile(join(__dirname, 'data', 'methodology.md'), 'utf8');
    const accept = req.headers['accept'] ?? '';
    if (accept.includes('text/html')) {
      // Minimal HTML render
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Hive Attest — Methodology</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 860px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
    h1,h2,h3 { color: #C08D23; }
    code, pre { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
    pre { padding: 12px; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; }
    td,th { border: 1px solid #ddd; padding: 8px 12px; }
    th { background: #C08D23; color: #fff; }
    a { color: #C08D23; }
  </style>
</head>
<body>
<pre style="background:none;padding:0;font-family:system-ui">${md.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
</body>
</html>`;
      res.set('Content-Type', 'text/html').send(html);
    } else {
      res.set('Content-Type', 'text/markdown').send(md);
    }
  } catch (err) {
    res.status(500).json({ error: 'methodology_unavailable', message: err.message });
  }
});

// ── GET /.well-known/mcp.json ─────────────────────────────────────────────────
app.get('/.well-known/mcp.json', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    name:      'hive-attest-agentic-volume',
    version:   SCHEMA_VERSION,
    protocol:  'MCP 2024-11-05',
    endpoint:  `${baseUrl}/mcp`,
    tools:     ['attest_volume', 'verify_attestation', 'list_periods'],
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

// ── boot ──────────────────────────────────────────────────────────────────────
(async () => {
  await initKeys();
  app.listen(PORT, () => {
    console.log(`[hive-attest-agentic-volume] Listening on port ${PORT}`);
    console.log(`  Brand gold: #C08D23`);
    console.log(`  Monroe:     ${MONROE}`);
    console.log(`  Pairs with: USPTO #19`);
  });
})();
