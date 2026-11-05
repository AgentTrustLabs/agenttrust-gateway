#!/usr/bin/env node
/**
 * TASK 08 — end-to-end hackathon demonstration over the REAL MCP transport.
 *
 * Spawns `dist/mcp/server.js` as a subprocess and drives it exactly like an MCP
 * host would: initialize → tools/list → tools/call. Nothing is faked at the
 * transport layer, and no handler is imported directly.
 *
 * The demo runs the happy path plus three rejection paths, then verifies the
 * audit trail through the same MCP interface.
 *
 *   node scripts/task08-demo.mjs [--out docs/evidence/task08]
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : 'docs/evidence/task08';
const AUDIT_ROOT = mkdtempSync(join(tmpdir(), 'agenttrust-demo-'));

/** Third-party agents to try. Reachable + hash-matching at design time. */
const THIRD_PARTY_CANDIDATES = [19, 18, 12, 10];

mkdirSync(OUT, { recursive: true });

const SERVER = 'dist/mcp/server.js';
const REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** A failure that must abort the demo with a nonzero exit and a clear message. */
class DemoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DemoError';
  }
}

/** A live MCP client over stdio. One request at a time; ids are tracked. */
class McpClient {
  constructor(env = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.exited = null; // { code, signal } once the child dies
    this.failure = null; // first fatal transport error, if any

    this.proc = spawn('node', [SERVER], {
      cwd: process.cwd(),
      env: { ...process.env, AGENTTRUST_AUDIT_ROOT: AUDIT_ROOT, ...env },
    });

    // Spawn errors (ENOENT, EACCES, …) are emitted as 'error', not 'close'. Without
    // this handler Node throws later and the pending requests hang forever.
    this.proc.on('error', e => {
      this.fail(new DemoError(`failed to spawn "node ${SERVER}": ${e.message}`));
    });

    // An unexpected exit must reject every in-flight request instead of leaving it
    // pending — a pending promise with no other work lets Node exit 0 silently.
    this.proc.on('close', (code, signal) => {
      this.exited = { code, signal };
      this.fail(
        new DemoError(
          `MCP server exited unexpectedly (code=${code}, signal=${signal})` +
            (this.stderr.trim() ? `: ${this.stderr.trim().split('\n')[0]}` : ''),
        ),
      );
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', d => (this.stderr += d));

    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (!line) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this.fail(new DemoError(`malformed JSON-RPC line on stdout: ${line.slice(0, 120)}`));
          continue;
        }
        if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
          this.fail(new DemoError(`non JSON-RPC message on stdout: ${line.slice(0, 120)}`));
          continue;
        }
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          waiter.resolve(msg);
        }
      }
    });
  }

  /** Record the first fatal error and reject everything still waiting. */
  fail(err) {
    if (!this.failure) this.failure = err;
    for (const [, waiter] of this.pending) waiter.reject(this.failure);
    this.pending.clear();
  }

  request(method, params) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DemoError(`timed out after ${REQUEST_TIMEOUT_MS}ms waiting for ${method} (id ${id})`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: msg => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new DemoError(`failed to write ${method} to the server: ${e.message}`));
      }
    });
  }

  async call(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    if (!res.result) {
      throw new DemoError(`tool ${name} returned no result${res.error ? `: ${res.error.message}` : ''}`);
    }
    const text = res.result.content?.[0]?.text;
    if (text === undefined) throw new DemoError(`tool ${name} returned no content`);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DemoError(`tool ${name} returned non-JSON content: ${String(text).slice(0, 120)}`);
    }
    return { isError: Boolean(res.result.isError), payload: parsed };
  }

  /** Graceful shutdown: close stdin, await exit. Bounded by SHUTDOWN_TIMEOUT_MS. */
  async close() {
    if (this.exited) {
      return { exitCode: this.exited.code, forced: false, alreadyExited: true };
    }
    this.proc.stdin.end();
    return new Promise(resolve => {
      const t = setTimeout(() => {
        this.proc.kill('SIGTERM');
        resolve({ exitCode: null, forced: true });
      }, SHUTDOWN_TIMEOUT_MS);
      this.proc.once('close', code => {
        clearTimeout(t);
        resolve({ exitCode: code, forced: false });
      });
    });
  }
}

/**
 * Preflight. The demo drives the compiled server; without it every request would
 * hang and the process would exit 0 having printed nothing (the TASK 09 F3 defect).
 */
function preflight() {
  const serverPath = join(process.cwd(), SERVER);
  if (!existsSync(serverPath)) {
    throw new DemoError(
      `${SERVER} not found. Build first:\n` +
        `    npm run build      # or: npx tsc\n` +
        `then re-run: node scripts/task08-demo.mjs`,
    );
  }
}

const log = [];
function note(step, detail) {
  log.push({ step, at: new Date().toISOString(), detail });
  console.log(`• ${step}`);
}

const results = {};

async function main() {
  preflight();
  const c = new McpClient();

  // ── 1. protocol handshake ────────────────────────────────────────────
  const init = await c.request('initialize', {});
  note('initialize', {
    protocolVersion: init.result.protocolVersion,
    serverInfo: init.result.serverInfo,
    capabilities: init.result.capabilities,
  });

  const list = await c.request('tools/list', {});
  results.tools = list.result.tools.map(t => ({
    name: t.name,
    required: t.inputSchema.required ?? [],
    additionalProperties: t.inputSchema.additionalProperties,
  }));
  note('tools/list', { count: results.tools.length, names: results.tools.map(t => t.name) });

  // ── 2. discovery ─────────────────────────────────────────────────────
  const search = await c.call('registry.search', { query: 'AgentTrust', limit: 5 });
  results.search = {
    isError: search.isError,
    returned: search.payload?.registry?.returned,
    token_ids: (search.payload?.agents ?? []).map(a => a.token_id),
  };
  note('registry.search', results.search);

  const card = await c.call('registry.card', { token_id: 1004 });
  results.card = {
    isError: card.isError,
    byte_length: card.payload?.card?.byte_length,
    sha256: card.payload?.card?.sha256,
    agent_uri: card.payload?.registry?.agent_uri,
    status: card.payload?.registry?.status,
  };
  note('registry.card', results.card);

  // ── 3. independent trust verification ────────────────────────────────
  const trust = await c.call('trust.verify', { token_id: 1004 });
  results.trust = {
    isError: trust.isError,
    decision: trust.payload?.trust_decision,
    checks: trust.payload?.checks,
    reasons: trust.payload?.reasons,
  };
  note('trust.verify', { decision: results.trust.decision, checks: results.trust.checks });

  // ── 4. discover or select a SECOND agent ─────────────────────────────
  const secondSearch = await c.call('registry.search', { query: 'a', limit: 25 });
  const discovered = secondSearch.payload?.agents ?? [];
  results.secondAgent = {
    discovered_count: discovered.length,
    candidates_tried: THIRD_PARTY_CANDIDATES,
    selected: null,
    trust: null,
    fixture_used: false,
    limitation: null,
  };

  for (const tid of THIRD_PARTY_CANDIDATES) {
    if (!discovered.some(a => a.token_id === tid)) continue;
    const t = await c.call('trust.verify', { token_id: tid });
    if (t.payload && !t.payload.error) {
      results.secondAgent.selected = tid;
      results.secondAgent.trust = {
        decision: t.payload.trust_decision,
        checks: t.payload.checks,
        reasons: t.payload.reasons,
      };
      break;
    }
  }

  if (results.secondAgent.selected === null) {
    // Controlled fixture: the demo must not depend on a third party staying online.
    results.secondAgent.fixture_used = true;
    results.secondAgent.limitation =
      'No reachable third-party agent produced a usable trust result; a controlled fixture (token 99999, not registered) stands in.';
    results.secondAgent.selected = 99999;
    const t = await c.call('trust.verify', { token_id: 99999 });
    results.secondAgent.trust = {
      decision: t.payload?.trust_decision,
      checks: t.payload?.checks,
      reasons: t.payload?.reasons,
    };
  }
  note('4. second agent', {
    selected: results.secondAgent.selected,
    decision: results.secondAgent.trust?.decision,
    fixture: results.secondAgent.fixture_used,
  });

  // ── 5. trust policy ──────────────────────────────────────────────────
  const policy = await c.call('trust.policy', { trust_decision: 'TRUSTED', intent: 'paid_resource' });
  results.policy = {
    allowed: policy.payload?.allowed,
    code: policy.payload?.code,
    verdict_source: policy.payload?.verdict_source,
  };
  note('trust.policy', results.policy);

  // ── 6. the happy path: simulated commerce (access granted) ───────────
  const commerce = await c.call('commerce.simulate', { token_id: 1004, amount_micro_ccd: '250000' });
  results.commerce = {
    isError: commerce.isError,
    stage: commerce.payload?.stage,
    granted: commerce.payload?.granted,
    settled: commerce.payload?.simulation?.settled,
    disclaimer: commerce.payload?.simulation?.disclaimer,
    facilitator: commerce.payload?.simulation?.facilitator,
    calls: commerce.payload?.simulation?.calls,
    simulated_transaction: commerce.payload?.receipt?.simulated_transaction,
    simulated_transaction_note:
      'Derived locally from payTo:amount:asset. NOT a chain hash, never submitted.',
    settlement_kind: 'SIMULATED',
    audit_events: commerce.payload?.audit?.events,
    session_id: commerce.payload?.session_id,
  };
  note('commerce.simulate', {
    stage: results.commerce.stage,
    granted: results.commerce.granted,
    settled: results.commerce.settled,
  });

  // ── 6. rejection paths ───────────────────────────────────────────────
  const OTHER_OWNER = '3whdieGHx43KKRwQYbC5pAUdmWZ61B7yreNRU9i36MtdCvajR8';

  const trustReject = await c.call('commerce.simulate', { token_id: 1004, expect_owner: OTHER_OWNER });
  results.trustRejection = {
    stage: trustReject.payload?.stage,
    granted: trustReject.payload?.granted,
    facilitator_calls: trustReject.payload?.simulation?.calls ?? [],
    requirement: trustReject.payload?.requirement,
  };
  note('commerce.simulate (trust rejection)', results.trustRejection);

  const payReject = await c.call('commerce.simulate', { token_id: 1004, mode: 'reject' });
  results.paymentRejection = {
    stage: payReject.payload?.stage,
    granted: payReject.payload?.granted,
    receipt: payReject.payload?.receipt,
    settled: payReject.payload?.simulation?.settled,
  };
  note('commerce.simulate (mock payment rejection)', results.paymentRejection);

  const authForge = await c.call('commerce.simulate', {
    token_id: 1004,
    authorization: { maxAmountMicroCcd: '1000000000', issued_by: 'client' },
  });
  results.authorizationForge = {
    isError: authForge.isError,
    code: authForge.payload?.error?.code,
    message: authForge.payload?.error?.message,
  };
  note('commerce.simulate (forged authorization)', {
    code: results.authorizationForge.code,
  });

  // ── 9. verify the audit trail ────────────────────────────────────────
  const files = existsSync(AUDIT_ROOT) ? readdirSync(AUDIT_ROOT).filter(f => f.endsWith('.jsonl')) : [];
  results.audit = { files: files.length, verifications: [] };
  for (const f of files) {
    const v = await c.call('audit.verify', { name: f });
    results.audit.verifications.push({
      name: f,
      ok: v.payload?.ok,
      events: v.payload?.events,
      problems: v.payload?.problems,
      warnings: v.payload?.warnings,
      checkpoint: v.payload?.checkpoint,
      event_types: (v.payload?.summary ?? []).map(e => e.type),
    });
  }
  note('9. audit.verify', { verified: results.audit.verifications.filter(v => v.ok).length, total: results.audit.verifications.length });

  // ── boundary probes (evidence, outside the nine demo steps) ──────────
  const pathProbe = await c.call('audit.verify', { name: '../../etc/passwd' });
  const urlProbe = await c.call('trust.verify', { token_id: 1004, mcp_base: 'https://evil.test' });
  results.boundaries = {
    path_traversal: { code: pathProbe.payload?.error?.code },
    registry_override: { code: urlProbe.payload?.error?.code },
  };
  note('boundary probes', results.boundaries);

  const shutdown = await c.close();
  results.shutdown = { exit_code: shutdown.exitCode, forced: shutdown.forced };
  note('shutdown', results.shutdown);

  if (shutdown.forced) {
    throw new DemoError(`MCP server did not exit within ${SHUTDOWN_TIMEOUT_MS}ms; sent SIGTERM`);
  }
  if (shutdown.exitCode !== 0) {
    throw new DemoError(`MCP server exited with code ${shutdown.exitCode}, expected 0`);
  }

  // ── evidence ─────────────────────────────────────────────────────────
  const summary = {
    generated_at: new Date().toISOString(),
    transport: 'stdio JSON-RPC 2.0 (real subprocess; no handler imported directly)',
    audit_root: AUDIT_ROOT,
    on_chain_transactions: 0,
    real_settlement: false,
    settlement_kind: 'MOCK',
    shutdown: results.shutdown,
    stderr_during_session: c.stderr.trim() === '' ? '(empty)' : c.stderr.trim(),
    results,
    log,
  };
  const resultsPath = join(OUT, 'demo-results.json');
  const transcriptPath = join(OUT, 'demo-transcript.jsonl');
  writeFileSync(resultsPath, JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(transcriptPath, log.map(l => JSON.stringify(l)).join('\n') + '\n');

  // Evidence is only credible if it is actually on disk and parses.
  for (const artifact of [resultsPath, transcriptPath]) {
    if (!existsSync(artifact)) throw new DemoError(`evidence artifact was not written: ${artifact}`);
  }
  const reread = JSON.parse(readFileSync(resultsPath, 'utf8'));
  if (reread.results?.commerce?.settled !== false) {
    throw new DemoError('evidence does not record settled=false; refusing to report success');
  }

  console.log('\n' + '─'.repeat(64));
  console.log(`tools                ${results.tools.length}`);
  console.log(`1 discover          token ${results.search.token_ids.join(',')}`);
  console.log(`2 card              ${results.card.byte_length} bytes  sha256 ${String(results.card.sha256).slice(0, 16)}…`);
  console.log(`3 trust             ${results.trust.decision}`);
  console.log(`4 second agent      ${results.secondAgent.selected}  ${results.secondAgent.trust?.decision}${results.secondAgent.fixture_used ? '  (fixture)' : '  (live third-party)'}`);
  console.log(`6 success           ${results.commerce.stage}  settled=${results.commerce.settled} (SIMULATED)`);
  console.log(`7 trust reject      ${results.trustRejection.stage}  facilitator calls=${results.trustRejection.facilitator_calls.length}`);
  console.log(`8 payment reject    ${results.paymentRejection.stage}  settled=${results.paymentRejection.settled}`);
  console.log(`9 audit verified    ${results.audit.verifications.filter(v => v.ok).length}/${results.audit.verifications.length}`);
  console.log(`  forged auth       ${results.authorizationForge.code}`);
  console.log(`  shutdown          exit ${results.shutdown.exit_code}, stderr ${c.stderr.trim() === '' ? 'clean' : 'DIRTY'}`);
  console.log('─'.repeat(64));
  console.log('NO REAL PAYMENT · NO ON-CHAIN TRANSACTION · NO SIGNING KEY USED');

  const okAll =
    results.trust.decision === 'TRUSTED' &&
    results.commerce.stage === 'access_granted' &&
    results.commerce.settled === false &&
    results.trustRejection.stage === 'trust_rejected' &&
    results.paymentRejection.stage === 'payment_rejected' &&
    results.authorizationForge.code === 'AUTHORIZATION_NOT_ACCEPTED' &&
    results.audit.verifications.length > 0 &&
    results.audit.verifications.every(v => v.ok) &&
    results.shutdown.exit_code === 0 &&
    c.stderr.trim() === '';

  if (!okAll) {
    throw new DemoError('one or more demo steps did not meet expectations (see the table above)');
  }
  process.exit(0);
}

main().catch(e => {
  // Every failure path is visible, actionable, and nonzero. 3 = demo/transport failure,
  // 1 = a step's expectation was not met.
  const msg = e instanceof DemoError ? e.message : (e?.stack ?? String(e));
  console.error(`\nDEMO FAILED: ${msg}`);
  if (!(e instanceof DemoError)) console.error('(unexpected error — this is a bug in the demo script)');
  process.exit(3);
});
