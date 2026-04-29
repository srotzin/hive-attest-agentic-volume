# hive-attest-agentic-volume

**Spectral-signed, audit-grade attestations of agentic stablecoin transaction volume by merchant.**  
Pairs with **USPTO Patent Application #19** (Spectral Signature Framework).

> Settlement rail: Base mainnet USDC × x402 micro-payment protocol  
> Brand: <span style="color:#C08D23">**#C08D23**</span> — The Hivery IQ

---

## What This Is

An autonomous MCP service that produces cryptographically signed, audit-grade records of stablecoin transaction volume attributable to AI agents operating on behalf of identified merchants. Every attestation is signed with an **ed25519** keypair whose public key lives in `/.well-known/agent.json` — allowing any third party to verify the signature without trusting this server's runtime.

Payment is gated per-request via the **x402** protocol. Base USDC, mainnet only.

---

## Tools

| Tool | Auth | Description |
|---|---|---|
| `attest_volume` | $1 USDC / $50 USDC audit | Spectral-signed attestation of agentic volume for a merchant × period |
| `verify_attestation` | Free | Re-verify ed25519 signature of any in-memory attestation |
| `list_periods` | Free | List supported periods with data freshness timestamps |

---

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Free | Service manifest |
| GET | `/health` | Free | Health check + key status |
| GET | `/.well-known/agent.json` | Free | Agent card — Monroe address + ed25519 pubkey |
| GET | `/.well-known/mcp.json` | Free | MCP capability discovery |
| POST | `/mcp` | Per-tool | JSON-RPC 2.0 MCP server |
| GET | `/v1/attest/agentic-volume/:merchant/:period` | $1/$50 USDC | Signed volume attestation |
| GET | `/v1/attest/verify/:attestation_id` | Free | Signature re-verification |
| GET | `/v1/attest/periods` | Free | Supported periods + freshness |
| GET | `/v1/attest/methodology` | Free | Full methodology document |

**Period values:** `1h` · `24h` · `7d` · `30d`  
**Merchant format:** W3C DID (e.g. `did:web:example.com`) or hostname

---

## Example Attestation Envelope

```json
{
  "attestation_id":       "a3f1c8b92d4e5f67890a1b2c3d4e5f67",
  "schema_version":       "1.0.0",
  "merchant":             "hivemorph",
  "period":               "24h",
  "period_start_ts":      1735689600,
  "period_end_ts":        1735776000,
  "agentic_volume_usd":   1284.50,
  "settlement_count":     47,
  "chain_breakdown": {
    "base_usdc":          1102.00,
    "base_usdt":          0,
    "solana_usdc":        182.50,
    "solana_usdt":        0,
    "ethereum_usdt":      0
  },
  "coverage":             "hivemorph_rails",
  "source":               "hivemorph_rails",
  "methodology_url":      "/v1/attest/methodology",
  "pairs_with":           "USPTO #19 Spectral Filing",
  "generated_at":         "2025-01-01T12:00:00.000Z",
  "signature":            "a1b2c3d4...64hexchars",
  "signature_algo":       "ed25519",
  "public_key":           "MCowBQYDK2VwAyEA...",
  "signed_payload_sha256": "e3b0c44298fc1c149afb...",
  "audit_hint":           "Verify signature at /v1/attest/verify/a3f1c8b92d4e5f67890a1b2c3d4e5f67."
}
```

> **INVARIANT:** `agentic_volume_usd` is `null` when the merchant is not indexed — never a fabricated number.

---

## Verification

Any party may independently verify an attestation:

```bash
# 1. Fetch an attestation (with x402 payment token)
curl -H "X-PAYMENT: <payment-token>" \
  "https://hive-attest-agentic-volume.onrender.com/v1/attest/agentic-volume/hivemorph/24h"

# 2. Server-side re-verify
curl "https://hive-attest-agentic-volume.onrender.com/v1/attest/verify/<attestation_id>"

# 3. Self-verify locally using the public key in agent.json:
# a) Fetch public key from /.well-known/agent.json → spectral.public_key_b64
# b) Reconstruct canonical JSON (field order matters — see methodology)
# c) SHA-256 the canonical UTF-8 string
# d) Verify signature_hex against the pubkey with ed25519
```

---

## Connect via MCP

```bash
# List tools
curl -X POST https://hive-attest-agentic-volume.onrender.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Attest (requires x402 payment)
curl -X POST https://hive-attest-agentic-volume.onrender.com/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{
      "name":"attest_volume",
      "arguments":{
        "merchant":"hivemorph",
        "period":"24h",
        "tier":"standard",
        "x_payment":"<payment-token>"
      }
    }
  }'
```

**Smithery:** https://smithery.ai/server/srotzin/hive-attest-agentic-volume

---

## Payment (x402)

| Tier | `?tier=` | Price | Settlement |
|---|---|---|---|
| Standard | *(none)* | $1.00 USDC | Base mainnet |
| Audit | `audit` | $50.00 USDC | Base mainnet |

**Monroe (payTo):** `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`  
**USDC contract (Base):** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`  
**Chain ID:** 8453

---

## Data Sources (Priority Order)

1. **Hivemorph Rails** — `https://hivemorph.onrender.com/v1/x402/rails` (real-time settlement ledger)
2. **Hive-Meter** — `https://hive-meter.onrender.com/v1/usage/summary` (metered billing aggregate)
3. **Hive x402 Index** — `https://hive-x402-index.onrender.com/v1/leaderboard` (ranked volume index)
4. **Local settlement log** — `/tmp/attest_settlements.jsonl` (on-instance payment receipts)

No fabrication. No estimation. Unknown merchants return `agentic_volume_usd: null`.

See full methodology at `/v1/attest/methodology`.

---

## USPTO #19

This service implements the **Spectral Signature Framework** described in USPTO Patent Application #19 filed by The Hivery IQ. The ed25519 signing scheme, canonical payload construction, and deterministic attestation ID derivation are core claims of that application.

---

## License

MIT — © 2025 Steve Rotzin / The Hivery IQ
