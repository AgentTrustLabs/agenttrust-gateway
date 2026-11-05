/**
 * Commerce orchestration — the one place the existing modules meet.
 *
 * Pipeline (each step gates the next):
 *
 *   discovery → card retrieval → independent trust verification → trust policy
 *   → payment requirement → payment payload → facilitator verify → mock settle
 *   → access decision → receipt
 *
 * Integration rules enforced structurally:
 *   - no cryptographic verification is reimplemented: identity comes from
 *     `verify/crossAgent`, payment from `payments/x402`
 *   - the payment access gate (`authorizePayment`) is never bypassed
 *   - a failed trust decision returns before any payment object is created
 *   - settlement is only reachable through `authorizePayment({settle:true})`
 *
 * The CIS-8004 identity is *attached* to the receipt as audit metadata. It is not
 * an input to the payment module, which remains identity-agnostic.
 */

import {
  verifyAgent,
  type TrustResult,
  type ContractExpectation,
} from '../verify/crossAgent.js';
import {
  buildPaymentRequirements,
  buildPaymentRequired,
  authorizePayment,
  ccdToMicroCcd,
  type ConsumerFacilitator,
  type PaymentReceipt,
  type AccessDecision,
} from '../payments/x402.js';
import { evaluateTrustPolicy, STRICT_POLICY, type TrustPolicy, type TrustPolicyDecision } from './trustPolicy.js';
import { AuditTrail } from '../audit/trail.js';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';

export interface CommerceClient {
  /** Registry MCP base URL, e.g. https://agent-registry-mcp.concordium.com */
  mcpBase: string;
  network: 'testnet' | 'mainnet' | 'devnet';
  /** CAIP-2 for policy + requirements. */
  caip2: string;
  /** Contract coordinates, normally read from `contract_info`. */
  cis8004: string;
  cis8?: string;
}

export interface CommerceTarget {
  tokenId: number;
  /** Optional pin: the owner the client expects. Authoritative when supplied. */
  expectOwner?: string;
}

export interface CommerceRequest {
  resourceUrl: string;
  description?: string;
  mimeType?: string;
  amountMicroCcd: string;
  /** Facilitator sponsor address copied into extra.feePayer. */
  feePayer?: string;
  maxTimeoutSeconds?: number;
}

export interface CommerceResult {
  sessionId: string;
  trust: TrustResult | null;
  policy: TrustPolicyDecision | null;
  requirements: PaymentRequirements | null;
  paymentRequired: PaymentRequired | null;
  access: AccessDecision | null;
  receipt: PaymentReceipt | null;
  stage:
    | 'discovery_failed'
    | 'trust_rejected'
    | 'requirement_created'
    | 'payment_rejected'
    | 'access_granted';
  granted: boolean;
  reason: string;
  audit: { sessionId: string; events: number; jsonl: string };
}

export interface OrchestratorDeps {
  /** Injected fetch (card + optional facilitator), so the flow is testable offline. */
  fetchImpl: Parameters<typeof verifyAgent>[0]['fetchImpl'];
  /** Injected facilitator. Defaults to none — the caller must pass one. */
  facilitator: ConsumerFacilitator;
  /** Builds the client payment payload. In production this wraps the official SDK. */
  createPaymentPayload: (requirements: PaymentRequirements) => Promise<PaymentPayload>;
  /** Registry read: returns the parsed `search_agents`/`agent_of` payload. */
  discover: (client: CommerceClient, target: CommerceTarget) => Promise<unknown>;
  /** Registry read: returns contract coordinates. */
  contractInfo: (client: CommerceClient) => Promise<{ cis8004_contract: { index: number; subindex: number }; cis8_contract?: { index: number; subindex: number } }>;
  policy?: TrustPolicy;
  audit?: AuditTrail;
  /** Unix seconds, injectable for deterministic expiry. */
  nowSeconds?: number;
}

/** Run the full commerce pipeline for one client → one provider interaction. */
export async function runCommerce(
  client: CommerceClient,
  target: CommerceTarget,
  request: CommerceRequest,
  deps: OrchestratorDeps,
): Promise<CommerceResult> {
  const audit = deps.audit ?? new AuditTrail();
  const policy = deps.policy ?? STRICT_POLICY;
  const sessionId = audit.sessionId;

  const identityRef = (extra: { tokenAddress?: string; owner?: string; uri?: string; hash?: string }) => ({
    token_id: target.tokenId,
    ...(extra.tokenAddress ? { token_address: extra.tokenAddress } : {}),
    ...(extra.owner ? { owner_account: extra.owner } : {}),
    ...(extra.uri ? { agent_uri: extra.uri } : {}),
    ...(extra.hash ? { metadata_sha256: extra.hash } : {}),
  });

  const finish = (
    partial: Omit<CommerceResult, 'sessionId' | 'audit'>,
  ): CommerceResult => ({
    ...partial,
    sessionId,
    audit: { sessionId, events: audit.all().length, jsonl: audit.toJsonl() },
  });

  // ── 1. contract coordinates (needed for the identity expectation) ──────
  let expect: ContractExpectation = {
    network: client.caip2,
    cis8004: client.cis8004,
    ...(client.cis8 ? { cis8: client.cis8 } : {}),
    tokenId: target.tokenId,
    ...(target.expectOwner ? { ownerAccount: target.expectOwner } : {}),
  };
  try {
    const info = await deps.contractInfo(client);
    if (info?.cis8004_contract) {
      expect = {
        ...expect,
        cis8004: `${info.cis8004_contract.index}.${info.cis8004_contract.subindex}`,
        ...(info.cis8_contract
          ? { cis8: `${info.cis8_contract.index}.${info.cis8_contract.subindex}` }
          : {}),
      };
    }
  } catch {
    // Coordinates from config remain usable; the verifier will fail closed if they are wrong.
  }

  // ── 2. discovery ───────────────────────────────────────────────────────
  let discoveryPayload: unknown;
  try {
    discoveryPayload = await deps.discover(client, target);
  } catch (e) {
    audit.record('agent.discovered', {
      outcome: 'FAIL',
      reason: `registry read failed: ${(e as Error).message}`,
      agent: identityRef({}),
      evidence_ref: 'registry:search_agents',
    });
    audit.record('commerce.access.denied', {
      outcome: 'FAIL',
      reason: 'discovery failed; commerce not started',
      agent: identityRef({}),
    });
    return finish({
      trust: null,
      policy: null,
      requirements: null,
      paymentRequired: null,
      access: null,
      receipt: null,
      stage: 'discovery_failed',
      granted: false,
      reason: 'discovery failed',
    });
  }

  // ── 3. independent trust verification ──────────────────────────────────
  const trust = await verifyAgent({
    expect,
    discoveryPayload,
    fetchImpl: deps.fetchImpl,
  });

  const record = trust.evidence?.discovery as { record?: Record<string, unknown> } | undefined;
  const rec = record?.record ?? {};
  const refs = identityRef({
    tokenAddress: typeof rec.token_address === 'string' ? rec.token_address : undefined,
    owner: typeof rec.owner_account === 'string' ? rec.owner_account : undefined,
    uri: typeof rec.agent_uri === 'string' ? rec.agent_uri : undefined,
    hash: typeof rec.metadata_hash_hex === 'string' ? rec.metadata_hash_hex : undefined,
  });

  audit.record('agent.discovered', {
    outcome: trust.agent_discovered === 'PASS' ? 'PASS' : 'INCONCLUSIVE',
    reason: trust.agent_discovered === 'PASS'
      ? 'token found in registry'
      : String((trust.evidence?.discovery as { reason?: string })?.reason ?? 'not found'),
    agent: refs,
    evidence_ref: 'evidence.discovery',
  });

  audit.record('agent.card.retrieved', {
    outcome: trust.card_retrieved === 'PASS' ? 'PASS' : 'FAIL',
    reason: trust.card_retrieved === 'PASS'
      ? `card fetched (${String((trust.evidence?.card as { byte_length?: number })?.byte_length ?? '?')} bytes)`
      : String((trust.evidence?.card as { error?: string })?.error ?? 'card unavailable'),
    agent: refs,
    evidence_ref: 'evidence.card',
  });

  if (trust.trust_decision !== 'TRUSTED') {
    audit.record('agent.trust.rejected', {
      outcome: trust.trust_decision === 'REJECTED' ? 'FAIL' : 'INCONCLUSIVE',
      reason: `trust_decision=${trust.trust_decision}`,
      agent: refs,
      evidence_ref: 'trust',
    });
    const decision = evaluateTrustPolicy(trust, policy);
    audit.record('commerce.access.denied', {
      outcome: 'FAIL',
      reason: `trust gate: ${decision.code} — ${decision.reason}`,
      agent: refs,
    });
    return finish({
      trust,
      policy: decision,
      requirements: null,
      paymentRequired: null,
      access: null,
      receipt: null,
      stage: 'trust_rejected',
      granted: false,
      reason: `trust gate: ${decision.reason}`,
    });
  }

  audit.record('agent.trust.verified', {
    outcome: 'PASS',
    reason: 'all independent checks PASS; hash matches on-chain anchor',
    agent: refs,
    evidence_ref: 'trust.evidence.hash.local_sha256',
  });

  // ── 4. trust policy (with the intended commerce terms) ─────────────────
  const amountMicroCcd = /^\d+$/.test(request.amountMicroCcd)
    ? request.amountMicroCcd
    : ccdToMicroCcd(request.amountMicroCcd);

  const decision = evaluateTrustPolicy(trust, policy, {
    amountMicroCcd,
    asset: 'CCD',
    network: client.caip2,
  });

  if (!decision.allowed) {
    audit.record('commerce.access.denied', {
      outcome: 'FAIL',
      reason: `policy: ${decision.code} — ${decision.reason}`,
      agent: refs,
    });
    return finish({
      trust,
      policy: decision,
      requirements: null,
      paymentRequired: null,
      access: null,
      receipt: null,
      stage: 'trust_rejected',
      granted: false,
      reason: `policy: ${decision.reason}`,
    });
  }

  // ── 5. payment requirement ─────────────────────────────────────────────
  const requirements = buildPaymentRequirements({
    payTo: String(rec.owner_account ?? target.expectOwner ?? ''),
    amountMicroCcd,
    resourceUrl: request.resourceUrl,
    ...(request.description ? { description: request.description } : {}),
    ...(request.mimeType ? { mimeType: request.mimeType } : {}),
    ...(request.feePayer ? { feePayer: request.feePayer } : {}),
    ...(request.maxTimeoutSeconds ? { maxTimeoutSeconds: request.maxTimeoutSeconds } : {}),
    network: client.caip2,
  });
  const requirementId = `req_${requirements.network}:${requirements.amount}`;

  audit.record('payment.requirement.created', {
    outcome: 'PASS',
    reason: `exact ${requirements.amount} ${requirements.asset} on ${requirements.network}`,
    agent: refs,
    payment: {
      requirement_id: requirementId,
      amount: requirements.amount,
      asset: requirements.asset,
      network: requirements.network,
      pay_to: requirements.payTo,
    },
    evidence_ref: 'requirements',
  });

  const paymentRequired = buildPaymentRequired(requirements, {
    resourceUrl: request.resourceUrl,
    ...(request.description ? { description: request.description } : {}),
    ...(request.mimeType ? { mimeType: request.mimeType } : {}),
  });

  // ── 6. client payment payload ──────────────────────────────────────────
  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = await deps.createPaymentPayload(requirements);
  } catch (e) {
    audit.record('payment.payload.received', {
      outcome: 'FAIL',
      reason: `client could not build a payload: ${(e as Error).message}`,
      agent: refs,
      payment: { requirement_id: requirementId, amount: requirements.amount, asset: requirements.asset, network: requirements.network },
    });
    audit.record('commerce.access.denied', {
      outcome: 'FAIL',
      reason: 'no payment payload; access denied',
      agent: refs,
    });
    return finish({
      trust,
      policy: decision,
      requirements,
      paymentRequired,
      access: null,
      receipt: null,
      stage: 'requirement_created',
      granted: false,
      reason: 'payment payload not produced',
    });
  }

  const signed = (paymentPayload.payload as { signedTransaction?: { header?: { sender?: string } } })
    ?.signedTransaction?.header?.sender;
  audit.record('payment.payload.received', {
    outcome: 'PASS',
    reason: 'client payload received (partially signed; sponsor slot empty)',
    agent: refs,
    payment: {
      requirement_id: requirementId,
      amount: requirements.amount,
      asset: requirements.asset,
      network: requirements.network,
      ...(signed ? { payer: signed } : {}),
    },
    evidence_ref: 'payment.payload.header',
  });

  // ── 7. verify + settle through the existing access gate ────────────────
  const access = await authorizePayment({
    facilitator: deps.facilitator,
    paymentPayload,
    requirements,
    settle: true,
    audit: { agentId: target.tokenId, tokenAddress: refs.token_address },
    ...(deps.nowSeconds !== undefined ? { nowSeconds: deps.nowSeconds } : {}),
  });

  if (access.verify && access.verify.isValid) {
    audit.record('payment.verified', {
      outcome: 'PASS',
      reason: 'facilitator verified the payment payload',
      agent: refs,
      payment: { requirement_id: requirementId, amount: requirements.amount, asset: requirements.asset, network: requirements.network },
      evidence_ref: 'access.verify',
    });
  }

  if (access.settle) {
    audit.record('payment.settlement.simulated', {
      outcome: access.settle.success ? 'PASS' : 'FAIL',
      reason: access.settle.success
        ? `mock settlement produced transaction ${access.settle.transaction}`
        : `settlement failed: ${access.settle.errorReason ?? 'unknown'}`,
      agent: refs,
      payment: {
        requirement_id: requirementId,
        amount: requirements.amount,
        asset: requirements.asset,
        network: requirements.network,
        ...(access.settle.transaction ? { transaction: access.settle.transaction } : {}),
        ...(access.settle.payer ? { payer: access.settle.payer } : {}),
      },
      evidence_ref: 'access.settle',
    });
  }

  if (!access.granted || !access.receipt) {
    audit.record('payment.rejected', {
      outcome: 'FAIL',
      reason: access.reason,
      agent: refs,
      payment: { requirement_id: requirementId, amount: requirements.amount, asset: requirements.asset, network: requirements.network },
    });
    audit.record('commerce.access.denied', {
      outcome: 'FAIL',
      reason: `payment gate: ${access.reason}`,
      agent: refs,
    });
    return finish({
      trust,
      policy: decision,
      requirements,
      paymentRequired,
      access,
      receipt: null,
      stage: 'payment_rejected',
      granted: false,
      reason: `payment gate: ${access.reason}`,
    });
  }

  audit.record('commerce.access.granted', {
    outcome: 'PASS',
    reason: `paid access granted after settlement ${access.receipt.transaction}`,
    agent: refs,
    payment: {
      requirement_id: requirementId,
      amount: access.receipt.amount,
      asset: access.receipt.asset,
      network: access.receipt.network,
      transaction: access.receipt.transaction,
      ...(access.receipt.payer ? { payer: access.receipt.payer } : {}),
    },
    evidence_ref: 'receipt.transaction',
  });

  return finish({
    trust,
    policy: decision,
    requirements,
    paymentRequired,
    access,
    receipt: access.receipt,
    stage: 'access_granted',
    granted: true,
    reason: 'trust verified and payment settled',
  });
}
