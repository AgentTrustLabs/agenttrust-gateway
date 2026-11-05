#!/usr/bin/env node
/**
 * agenttrust-mcp — MCP (JSON-RPC 2.0 over stdio) server exposing AgentTrust Gateway.
 *
 * Transport: newline-delimited JSON-RPC on stdin/stdout, which is what MCP hosts
 * (Claude Desktop, Cursor, Continue, any MCP client) expect for a local server.
 * `content-length` framing is also accepted on input for compatibility with
 * LSP-style clients.
 *
 * Security: MCP is an untrusted input boundary. No tool accepts a filesystem path,
 * URL, shell command, credential, settlement switch, or OperatorAuthorization.
 * See src/mcp/tools.ts for the validation and the invariant.
 *
 *   agenttrust-mcp
 *   AGENTTRUST_AUDIT_ROOT=/tmp/agenttrust-audit agenttrust-mcp
 */

import { createInterface } from 'node:readline';
import { TOOLS, callTool, type ServerConfig } from './tools.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'agenttrust-gateway', version: '1.0.0' };

/**
 * Registry endpoint is operator configuration (env), never a tool argument.
 * There is no fallback: if the env var is absent the default official registry is
 * used, and no tool can override it.
 */
const config: ServerConfig = {
  registryBase: process.env['AGENTTRUST_REGISTRY_MCP'] ?? 'https://agent-registry-mcp.concordium.com',
  auditRoot: process.env['AGENTTRUST_AUDIT_ROOT'] ?? '/tmp/agenttrust-audit',
};

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

function reply(id: string | number | null, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: string | number | null, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function send(msg: RpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/** MCP `tools/call` result envelope: text content, `isError` on failure. */
function toolContent(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function handle(req: RpcRequest): Promise<RpcResponse | null> {
  const id = req.id ?? null;

  switch (req.method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          'AgentTrust Gateway: discover and independently verify Concordium CIS-8004 agents, evaluate the trust policy, and run trust-gated commerce with a MOCK facilitator. No tool settles, signs, or moves funds, and no tool accepts operator authorization.',
      });

    case 'notifications/initialized':
    case 'initialized':
      return null;

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== 'string') {
        return reply(id, toolContent({ code: 'INVALID_INPUT', message: 'params.name must be a string' }, true));
      }
      const out = await callTool(config, params.name, params.arguments ?? {});
      if (out.ok) return reply(id, toolContent(out.result));
      return reply(id, toolContent({ error: out.error }, true));
    }

    default:
      return fail(id, -32601, `method not found: ${String(req.method).slice(0, 64)}`);
  }
}

/** Read newline-delimited JSON, tolerating optional Content-Length framing. */
function startStdio(): void {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    const text = line.trim();
    if (!text || /^content-length:/i.test(text) || /^content-type:/i.test(text)) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(text) as RpcRequest;
    } catch {
      send(fail(null, -32700, 'parse error'));
      return;
    }
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      send(fail(req.id ?? null, -32600, 'invalid request'));
      return;
    }
    void handle(req)
      .then(res => {
        if (res) send(res);
      })
      .catch(e => {
        // Never leak a stack trace across the boundary.
        send(fail(req.id ?? null, -32603, String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 200)));
      });
  });
}

startStdio();
