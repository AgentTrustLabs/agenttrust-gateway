# TASK 01 — AgentTrust Gateway: Technical Foundation & Feasibility

Date: 2026-11-04 · Network probed: Concordium **testnet** (CAIP-2 `ccd:4221332d34e1694168c2a0c0b3fd0f27`)
All items below marked VERIFIED were executed live during this task (curl/gh/npm). No write-path tx was executed.

---

## 1. VERIFIED (executed, with evidence)

### 1.1 Agent Registry MCP service (hosted)
- `GET https://agent-registry-mcp.concordium.com/healthz` → `{"ok":true,"version":"0.1.0"}`
- `POST /mcp` `tools/list` → **40 tools**, incl. `build_register`, `build_set_agent_uri`, `build_set_agent_wallet`,
  `build_cis8_register`, `build_cis8_canonical_bytes`, `build_agent_card`, `build_agent_badge`,
  `get_badge_json`, `check_badge`, `verify_agent_card`, `token_address`, `parse_token_address`,
  `list_agents`, `search_agents`, `recent_registrations`, `agent_history`, `contract_info`, `network_status`.
- Service **holds no private keys**; every write tool returns `{hex, schema_json}` sign-ready parameters.
- REST twins live: `/v1/check-badge/{id}`, `/v1/get-badge-JSON/{badge}`, `/v1/verify-agent-card/{badge}`,
  `/v1/build-set-agent-uri/{badge}`, `/openapi.json`, `/docs`.

### 1.2 Testnet contract coordinates (via `contract_info` MCP — live)
| Item | Value |
|---|---|
| CIS-8004 Agent Registry | index **12802**, subindex 0 |
| CIS-8004 module ref | `142462ff638f53b7bbeae8911d23579ed23e5e3c7e9a0353606019628121a5c6` |
| CIS-8004 admin | `3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8` |
| CIS-8 External Key Registry | index **12801**, subindex 0 |
| CIS-8 module ref | `3236c12fade1b559935906df2e0e43a372234eac5d40599d6e6cb12cdd6b9afd` |
| Standards | CIS-0, CIS-2, CIS-8004 |
| Explorer | https://testnet.ccdscan.io |

Mainnet (docs cross-check): CIS-8004 index 10082 sub 0 module `ba03e953…`, CIS-8 index 10081 sub 0 module `08f71acb…`.

### 1.3 Node / indexer reachability
- `network_status(testnet)` → gRPC `https://grpc.testnet.concordium.com:20000`, latest block **50,376,249** (live).
- Indexer `GET https://agent-registry-indexer.concordium.com/status` →
  testnet: **1001 agents / 5046 events**, `lag_blocks: 0`, synced 2026-11-04T16:45:55Z;
  mainnet: 5121 agents; devnet: 51 agents (devnet gRPC dead — see BLOCKED).
- `GET /agents?network=testnet&limit=3` returns full records: `token_id`, `owner_account`, `agent_uri`,
  `metadata_hash_hex`, `agent_wallet`, `status`, `registered_at`, `last_event_block`.
  → **Discovery is real and queryable without any custom indexer.**

### 1.4 Agent Card generation (A2A + ERC-8004 combined) — executed
`build_agent_card(testnet, name/desc/uri/owner/skills)` returned:
- A2A v1.0-shaped card (`name, description, url, version, defaultInputModes/OutputModes, skills[], capabilities`)
- `capabilities.extensions[]` with URI `https://docs.concordium.com/a2a-extensions/concordium-badge/v1`
  and `params`: `tokenAddress`, `owner.account` (CAIP-10 `ccd:4221332d…:…`), `agentWallet`,
  `contracts.cis8004 = ccd:4221332d…:12802.0`, `contracts.cis8 = ccd:4221332d…:12801.0`,
  `verify` instruction, `verification.{service,verifyUrl,mcp,docs}`.
- `metadata_hash_hex = fc28fa73b7cc7630c51490305ed34ed8ee4894b38297abe65600a4549f93719a` (SHA-256 of raw card bytes)
- `notes`: pre-mint card leaves `tokenAddress`/`tokenId` null; after register finalizes, regenerate card
  with known token_id and re-pin hash via `build_set_agent_uri`.

### 1.5 Register payload builder — executed (no tx sent)
`build_register(testnet, sender, agent_uri, metadata_hash_hex)` →
- `contract_address {index:12802, subindex:0}`, `receive_name: "CIS-8004.register"`
- `parameter_json`: `{agent_uri: Some(..), metadata_hash: Some([32 bytes]), external_reference: None, initial_metadata: []}`
- `parameter_hex`: `012f0000 0068 747470733a2f2f…` (tag/len-prefixed, ready for a contract-update tx)
- No private key accepted or required anywhere in the flow.

### 1.6 Badge verification — end-to-end executed on a live mainnet agent
`GET /v1/check-badge/Mf22soLh1NuZYFgBK8iSs` →
`badge_valid: true`, `hash_matches_on_chain: true`, `owner_matches: true`, `chain_matches: true`,
`contracts_match: true`, `badge_present: true`, `status_active: true`;
`on_chain.metadata_hash_hex == card_sha256 == 1253bd8f…e0d0`.
Three **warnings** (not errors): legacy top-level `concordium` block instead of A2A extension form,
`contracts.cis8` omitted, `verify` field omitted.
→ **Read-side verification (identity → owner → card integrity) is proven working.**

### 1.7 x402 on Concordium — official package exists and is current
- `@x402/concordium@2.29.0` (published by Concordium, in the official x402 monorepo set alongside `@x402/core`).
- Scheme: **Exact** with **V1 sponsored transactions**. Client builds + sender-signs, **facilitator** adds
  sponsor signature, submits, waits for ConcordiumBFT finality. Client never broadcasts.
- Assets: native CCD (6 dp, microCCD) and PLTs (EURR/USDR…), amounts atomic strings.
- Networks: mainnet `ccd:9dd9ca4d…`, testnet `ccd:4221332d…`; gRPC `grpc.testnet.concordium.com:20000`.
- Facilitator enforces **9 rules** before sponsoring (version, sender, sponsor, destination, exact amount,
  asset type, expiry ≤10 min, sender signature vs on-chain credentials, single-op payload safety).
- Exports `toConcordiumFacilitatorSigner`, `CONCORDIUM_TESTNET_CAIP2`, `getExplorerTxUrl` (→ ccdexplorer.io).
- Docs page (`/en/mainnet/how-to/integrations/x402-integration.html`) describes "Verify & Pay":
  402 → ZKP identity proof + CCD tx → `X-PAYMENT` header → facilitator `/verify` → `getTransactionStatus(txHash)`.

### 1.8 SDK / toolchain availability (npm, resolved today)
`@concordium/web-sdk@12.0.2`, `@concordium/node-sdk@9.5.3`, `@concordium/wallet-connectors@0.9.0`,
`@concordium/react-components@0.9.0-alpha.0`, `@concordium/id-app-sdk@0.1.6`, `@concordium/ccd-js-gen@1.2.1`.
No `@concordium/agent-registry` npm package — the registry is consumed via the **hosted MCP/REST service** or
a locally-run Docker image (`concordium/agent-registry-mcp:latest`, port 3000, 40 tools).

### 1.9 Explorer / evidence path
- `api-ccdscan-fungy.testnet.concordium.com/api/graphql` responds to introspection (GraphQL schema live).
- `testnet.ccdscan.io` HTTP 200; docs reference `https://testnet.ccdscan.io` and ccdexplorer.io tx URLs.

### 1.10 Enterprise/infra reachable
- `wallet-proxy.testnet.concordium.com/v0/global` → valid `bulletproofGenerators` (identity/credential infra live).
- `grpc.testnet.concordium.com:20000` responds.

---

## 2. NOT TESTED (documented, not executed)

1. **Actual register tx submission** → blocked on funded account (see §3).
2. **CIS-8 Ethereum/Solana key binding** (`build_cis8_canonical_bytes` → personal_sign → `build_cis8_register`).
   Doc + tool present; no ETH key used in this task.
3. **x402 verify+settle on testnet** — needs (a) sender account with CCD, (b) a facilitator sponsor account
   with CCD, (c) funded `payTo`.
4. **Sponsored transaction submission V1** (Concordium-native, outside x402).
5. **Concordium ID / Verify & Access ZKP proof** (age/attribute) — needs wallet + IDP selection.
6. **Local Docker MCP + local indexer** run and offline operation.
7. **`build_set_agent_wallet` proof-of-control** (EIP-712 for ETH wallets / native ownership).
8. **Discovery scaling** beyond published page sizes (`limit`, cursor semantics unverified).

---

## 3. BLOCKED

**B1 — No funded testnet account. This gates every write path.**
- `faucet.testnet.concordium.com` does **not resolve** (NXDOMAIN confirmed via DNS-over-HTTPS against
  Cloudflare NS). `faucet.concordium.com`, `testnet-faucet.concordium.com` also NXDOMAIN.
- Official path now: Concordium **Wallet for Web**, switch to Testnet, account → Activity → **Request CCD**.
  Public faucet repo (`Concordium/concordium-dapp-examples/testnet-faucet`) requires **X post + captcha**,
  once per N hours. There is **no programmatic/API faucet**.
- Consequence: registration, CIS-8 binding, x402 settle, and tx-evidence steps cannot be executed by the agent
  until a funded account exists. Funding is a **human action** (X account + captcha + wallet).

**B2 — devnet unusable through the hosted MCP** (`network_status(devnet)` → gRPC `Unavailable`).
Local devnet stack is possible but adds a node + indexer + devnet contract deployment — out of scope, and it
would not produce hackathon-relevant evidence (target is Testnet).

**B3 — MCP tool/param drift**: `search_agents` rejects `query`, expects `q` (`config error: missing string 'q'`).
Docs and tool schema disagree. Minor: pin param names from `tools/list` at runtime, not from docs.

**B4 — Docs site 403s non-browser UAs on sub-pages** (identity, CIS-8, CAIP, x402, sponsored). Workaround used:
browser UA. `https://docs.concordium.com/en/mainnet/docs/plt/setup-guide/request-ccd.html` returns the SPA shell
(200, 328 bytes) — content not server-rendered; read via docs index/`llms.txt` instead.

---

## 4. ARCHITECTURE (proposed, modular, framework-agnostic)

```
agenttrust (TypeScript, ESM, CLI-first, no dashboard)
├── core/            types, errors, network config (testnet|mainnet), CAIP helpers
├── identity/        key custody (ed25519 keystore file 0600), account addr, optional ETH signer
│                    → interface: IdentityProvider.getAccount(), sign(bytes), getPublicKey()
├── registry/        CIS-8004 adapter. Transport = MCP client (hosted or local).
│                    register / setAgentURI / setMetadata / setAgentWallet / transfer / revoke
│                    → returns {contract, index, receiveName, parameterHex} signed by tx builder
├── card/            Agent Card build (build_agent_card), byte-exact publishing, sha256 pin
│                    → interface: CardHost.publish(bytes) -> url   (file://, http://, ipfs later)
├── discovery/       list/search/recent via Indexer REST; resolve by token address or owner
├── verify/          verify(tokenOrBadge) → {onChain, cardHashMatch, ownerMatch, status, badgeWarnings}
│                    local re-computation of sha256 (never trust the verifier alone)
├── payments/        x402 client + facilitator wrapper (@x402/concordium exact scheme)
│                    → interface: Payer.pay(requirements) -> receipt; Facilitator.settle(payload)
├── audit/           append-only JSONL evidence log: {ts, actor, kind, txHash, network, digest}
│                    + CCDScan/GraphQL lookup for confirmation depth
├── mcp/             MCP server exposing the above as tools (A2A interop surface)
└── cli/             agenttrust init | card build | publish | register | verify | discover | pay | prove
```

Design rules applied:
- **No framework coupling**: nothing imports an agent framework; the MCP server is the interop boundary.
- **No custom chain infrastructure**: no own registry contract, no own indexer — reuse 12802/12801 + hosted
  MCP + hosted indexer. Only add code where the official stack stops (card hosting, evidence log, CLI UX).
- **Key isolation**: private keys never leave `identity/`, never logged, never in argv (env or keystore file).
- **Env separation**: single `NetworkConfig` object; testnet/mainnet cannot be mixed per-command
  (guard: assert every resolved contract/chain matches the active network).
- **Verification is local-first**: recompute card sha256 + re-read on-chain `metadata_hash`; the hosted
  badge checker is a cross-check, not the source of truth.

Mapped to the 7 required boundaries: identity/ownership → `identity` + `verify`; registry → `registry`;
discovery → `discovery`; MCP/A2A → `mcp` + `card`; payments → `payments`; audit/evidence → `audit`;
testnet → `core/network`.

---

## 5. Dependency & SDK assessment

| Need | Use | Version | Verdict |
|---|---|---|---|
| Registry read/write payloads | hosted MCP (`agent-registry-mcp`) / local Docker | v0.1.0 | **Adopt.** Zero SDK to maintain; 40 tools; stateless. |
| Discovery | hosted Indexer REST | v0.1.0 | **Adopt.** 1001 testnet agents, lag 0. |
| Chain tx build/sign/submit | `@concordium/web-sdk` | 12.0.2 | **Adopt.** Required by x402 client signer. |
| Node access | `@concordium/node-sdk` | 9.5.3 | Optional; web-sdk covers most. |
| Payments | `@x402/concordium` (+ `@x402/core`, `@x402/fetch`) | 2.29.0 | **Adopt.** Official, sponsored-tx model. |
| x402 HTTP client plumbing | `@x402/fetch` / `@x402/express` | 2.29.0 | Adopt one, per chosen server shape. |
| Wallet/ID proof (Verify & Access) | `@concordium/wallet-connectors`, `@concordium/id-app-sdk` | 0.9.0 / 0.1.6 | Defer — only if ZKP scope is kept. |
| A2A/MCP | `@modelcontextprotocol/sdk` | current | Adopt for our MCP server facet. |

Cost/dependency posture: **no paid APIs** required. All endpoints used (MCP, indexer, gRPC, CCDScan GraphQL,
wallet-proxy) are public. On-chain cost is the €0.02-pegged tx fee, paid in testnet CCD.

---

## 6. Critical integration risks

1. **Faucet is the single point of failure** (R1, highest). One claim per account, and only *before* the account
   has incoming transactions. Get N accounts funded up-front (owner + 2 agent accounts + 1 facilitator sponsor).
2. **Facilitator key custody**: x402 testnet settle needs a funded **sponsor** account whose ed25519 key signs
   server-side. That is a hot key by design. Keep it dedicated, low-balance, separate from the owner identity.
3. **x402 ≠ EVM mental model**: no `TransferWithAuthorization`; facilitator must be the sponsor named in the tx
   header, and it re-verifies before signing. Any deviation → `sponsor_mismatch` / `amount_mismatch`.
4. **Expiry clock skew**: payload expiry ≤10 min from now. Container/NTP drift breaks settlement silently.
5. **Card byte-stability**: hash is over exact bytes. Any CDN re-serialization/minification breaks
   `verify_agent_card`. Must publish immutable bytes and re-pin on change.
6. **Two identity domains**: native Concordium account owns the NFT; Ethereum address is only reachable via CIS-8.
   Own UX must always show *which* domain a check was made in.
7. **Revoked/transferred agents**: `transfer` clears `agentWallet`; `revoke` keeps the record queryable.
   Verification must treat both as denials, and re-resolve `agentWallet` after any transfer event.
8. **Hosted service trust**: the MCP/verify endpoint is a convenience, not an authority. Always re-derive locally.
9. **Docs drift**: sub-page 403s, SPA-only pages, `q` vs `query` param. Pin to `openapi.json` + `tools/list`.

---

## 7. Minimal end-to-end implementation sequence (bounded, ~5 steps)

1. **Fund accounts** (human): 4 testnet accounts via Wallet for Web → Request CCD. Record addresses only.
2. **`init` + `card build/publish`**: generate card JSON via MCP, host byte-exact, compute sha256, store in
   `audit/` JSONL. *(verifiable without any chain write)*
3. **`register`**: `build_register` → sign with web-sdk → submit → wait finality → capture `token_id` + tx hash;
   confirm on `testnet.ccdscan.io`.
4. **`verify`**: `verify_agent_card` + local sha256 re-derivation; expect `hash_matches_on_chain: true`;
   then regenerate card with token_id and `build_set_agent_uri` to re-pin.
5. **`pay`**: x402 server route + `@x402/concordium` facilitator on testnet, 1 CCD → settle → hash in `audit/`
   and on CCDScan. Then repeat 3–5 for a **second independently operated agent** to prove the gateway is
   multi-agent, not single-tenant.

Deliberately excluded from TASK 01: dashboard, A2A server runtime, ZKP age-gating, mainnet, custom contracts.

---

## 8. Official references (primary)

- Agent Registry overview + addresses: https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/index.html
- CIS-8004: https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/cis-8004.html
- CIS-8: https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/cis-8.html
- Agent Card: https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/agent-card.html
- Verified by Concordium badge: https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/concordium-badge.html
- MCP service (40 tools + REST): https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/mcp-service.html
- Indexer: https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/indexer.html
- How-to register: https://docs.concordium.com/en/mainnet/how-to/integrations/agent-registry.html
- x402 integration: https://docs.concordium.com/en/mainnet/how-to/integrations/x402-integration.html
- x402 package: https://www.npmjs.com/package/@x402/concordium
- Sponsored tx tutorial: https://docs.concordium.com/en/mainnet/tutorials/sponsoredTransactions/index.html
- Partner archetype (XDC AI, CIS-8 + badge + sponsored tx): https://docs.concordium.com/en/mainnet/learn/partner-integrations/xdc-ai-verified-agent-wallets.html
- Faucet source (official): https://github.com/Concordium/concordium-dapp-examples/tree/main/testnet-faucet
- Live services: https://agent-registry-mcp.concordium.com/openapi.json · https://agent-registry-indexer.concordium.com/
- Hackathon: https://www.encodeclub.com/programmes/concordium-trusted-agents-hackathon
