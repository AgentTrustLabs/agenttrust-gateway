/**
 * Minimal static + tx-capture server for the AgentTrust signing page.
 * Serves signing-site/ and accepts POST /tx to record the wallet-returned hash.
 * No credentials, no keys — the wallet extension does all signing.
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const ROOT = new URL('../signing-site/', import.meta.url).pathname;
const PORT = 4517;
const TX_FILE = join(ROOT, 'captured-tx.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }

  if (req.method === 'POST' && req.url === '/tx') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (!/^[0-9a-f]{64}$/i.test(parsed.txHash ?? '')) {
          throw new Error('bad txHash');
        }
        writeFileSync(TX_FILE, JSON.stringify({ ...parsed, receivedAt: new Date().toISOString() }, null, 2));
        console.log('captured tx:', parsed.txHash);
        res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { ...cors, 'content-type': 'application/json' }).end(
          JSON.stringify({ ok: false, error: String(e.message) }),
        );
      }
    });
    return;
  }

  const urlPath = req.url.split('?')[0];
  const rel = normalize(urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
  const file = join(ROOT, rel);

  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404, cors).end('not found');
    return;
  }

  res.writeHead(200, { ...cors, 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log(`signing server on 127.0.0.1:${PORT}`));
