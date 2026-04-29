# Hive Agentic Volume Attestation — Methodology

**Issued by:** The Hivery IQ  
**Pairs with:** USPTO Patent Application #19 (Spectral Signature Framework)  
**Schema version:** 1.0.0  
**Last revised:** 2025-01-01  

---

## 1. Executive Summary

The Hive Agentic Volume Attestation service produces cryptographically signed, audit-grade records of stablecoin transaction volume attributable to autonomous AI agents operating on behalf of identified merchants. Each attestation is signed with an ed25519 keypair whose public key is published in the service's agent card (`/.well-known/agent.json`). The signature covers a canonical deterministic JSON payload, ensuring that any third party can independently re-verify the attestation without trusting the issuer's runtime.

This methodology defines, with precision, how volume figures are sourced, aggregated, and reported. The governing principle is strict non-fabrication: if authoritative data is unavailable for a merchant, the attestation returns `agentic_volume_usd: null` with `coverage: "merchant_not_indexed"`. Interpolated or estimated values are never substituted for missing data.

---

## 2. Scope

- **Settlement chains covered:** Base (USDC, USDT), Solana (USDC, USDT), Ethereum (USDT)
- **Settlement standard:** x402 micro-payment protocol, USDC atomic units (6 decimal places)
- **Merchant identifier formats accepted:** W3C DID strings (e.g., `did:web:example.com`) or hostnames
- **Reporting periods:** `1h`, `24h`, `7d`, `30d` (rolling windows anchored to request time)
- **Minimum reportable settlement:** 1 atomic USDC unit (0.000001 USD)

---

## 3. Data Sources (Priority Order)

### 3.1 Hivemorph Rails Telemetry
**Endpoint:** `https://hivemorph.onrender.com/v1/x402/rails`  
**Type:** Real-time settlement ledger  
**Latency:** < 10 seconds  

The primary source. Hivemorph maintains a per-merchant settlement ledger indexed by DID and period. Each record includes: merchant identifier, timestamp (Unix seconds), amount in USD terms at settlement, chain identifier, and transaction hash. This module queries the ledger, filters to the requested merchant and rolling window, and sums atomic values.

### 3.2 Hive-Meter Usage Summary
**Endpoint:** `https://hive-meter.onrender.com/v1/usage/summary`  
**Type:** Metered billing aggregate  
**Latency:** < 15 seconds  

Hive-Meter is a billing metering service that tracks per-merchant consumption across all Hive surfaces. When Hivemorph rails return no records for a merchant, this endpoint is queried for aggregate volume. Chain breakdown defaults to Base USDC when chain-level detail is unavailable from this source.

### 3.3 Hive x402 Index Leaderboard
**Endpoint:** `https://hive-x402-index.onrender.com/v1/leaderboard`  
**Type:** Ranked volume index  
**Latency:** < 20 seconds  

The x402 index maintains a leaderboard of merchants by aggregate settlement volume. It serves as a tertiary cross-check when both Hivemorph and Hive-Meter return no records. Chain-level granularity is not preserved in this source.

### 3.4 Local Settlement Log
**Path:** `/tmp/attest_settlements.jsonl`  
**Type:** On-instance settlement log (ephemeral, Render filesystem)  
**Format:** One JSON object per line: `{ merchant, ts, amount_usd, chain }`  

When the service itself processes 402-payment challenges, it appends settlement events to this file. These entries represent actual payment receipts observed by this service instance and serve as a supplementary data source for merchants whose activity passed through this service's payment gateway.

---

## 4. Volume Calculation

For a given `(merchant, period)` pair:

1. Determine the rolling window: `period_end_ts = floor(now)`, `period_start_ts = period_end_ts - period_seconds`
2. Query each data source in priority order (§3.1 → §3.4)
3. On the first source that returns one or more matching settlement records:
   - Sum `amount_usd` values → `agentic_volume_usd`
   - Count records → `settlement_count`
   - Group by chain identifier → `chain_breakdown`
4. If no source returns records → set `agentic_volume_usd = null`, `coverage = "merchant_not_indexed"`

**No estimation, interpolation, or extrapolation is performed at any step.**

---

## 5. Canonical Payload and Signing

The canonical payload is a deterministic JSON object with fixed field order:

```json
{
  "merchant":           "<string>",
  "period":             "<1h|24h|7d|30d>",
  "period_start_ts":    <integer>,
  "period_end_ts":      <integer>,
  "agentic_volume_usd": <number|null>,
  "settlement_count":   <integer|null>,
  "chain_breakdown":    { "base_usdc": <number|null>, ... },
  "generated_at":       "<ISO-8601>"
}
```

This string is:
1. Encoded as UTF-8
2. Hashed with SHA-256 → `signed_payload_sha256`
3. Signed with ed25519 using the service's private key → `signature_hex`

The public key is exposed in `/.well-known/agent.json` under `spectral.public_key_b64` and repeated in every attestation envelope as `public_key`. This allows verification without any trust anchor beyond the public key itself.

---

## 6. Verification

Any party may verify an attestation by:

1. Reconstructing the canonical payload from the attestation fields (same field order)
2. Computing SHA-256 of the UTF-8 encoding
3. Verifying `signature_hex` against `public_key` using the ed25519 algorithm

The `/v1/attest/verify/:attestation_id` endpoint performs this verification server-side and returns `signature_valid: true/false`, `recomputed_sha256`, and `sha256_match`.

---

## 7. Attestation IDs

`attestation_id` is a deterministic identifier: `SHA-256(canonical_payload + generated_at)[0:32]` encoded as lowercase hex. Attestations are not persisted server-side between instance restarts (Render ephemeral filesystem). Callers requiring durable attestation records must store the full envelope.

---

## 8. Pricing and Access

| Tier | Query param | Price | Description |
|------|-------------|-------|-------------|
| Standard | (none) | $1.00 USDC | Spectral-signed volume attestation |
| Audit | `?tier=audit` | $50.00 USDC | Extended methodology disclosure, audit-grade |

Payment is required before data is returned. The 402 challenge is issued per the x402 protocol spec with Base mainnet USDC settlement to Monroe (`0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`).

---

## 9. Limitations and Disclosures

- **Ephemeral state:** This service runs on Render's starter plan with ephemeral local storage. The local settlement log (`/tmp/attest_settlements.jsonl`) does not persist across deploys. Upstream Hivemorph rails are the authoritative persistent ledger.
- **Rolling windows:** All periods are rolling from request time. A `24h` attestation issued at 14:00 covers 14:00 yesterday to 14:00 today, not a calendar day.
- **Multi-source coverage:** When multiple upstream sources return data, the highest-priority source wins. No blending or averaging across sources is performed.
- **Merchant aliasing:** DID strings and hostnames are matched exactly. `did:web:example.com` and `example.com` are treated as distinct merchants unless the upstream ledger aliases them.

---

## 10. Relationship to USPTO #19

The Spectral signing framework documented here is the subject of USPTO Patent Application #19 filed by The Hivery IQ. The ed25519 signature scheme, canonical payload construction, and deterministic attestation ID derivation are core claims of that filing. Use of this API constitutes acknowledgment of the pending intellectual property status of the Spectral signing methodology.

---

*The Hivery IQ — hivemorph.onrender.com — Brand gold #C08D23*
