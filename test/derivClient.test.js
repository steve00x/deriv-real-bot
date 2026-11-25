import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DerivClient, diagnose } from '../src/derivClient.js';

const quietLog = { info() {}, warn() {}, error() {} };

/** Local server that rejects WebSocket handshakes like Cloudflare does, recording request headers. */
function rejectingServer(status, body) {
  const seen = [];
  const srv = http.createServer();
  srv.on('upgrade', (req, socket) => {
    seen.push(req.headers);
    socket.end(`HTTP/1.1 ${status} Error\r\nContent-Type: text/html\r\ncf-ray: abc123\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port })));
}

test('diagnose reports the handshake status, cf-ray and page text', async () => {
  const { srv, port } = await rejectingServer(520, '<html><head><style>x{}</style></head><body><h1>Web server is returning an unknown error</h1></body></html>');
  const out = await diagnose(`ws://127.0.0.1:${port}/websockets/v3?app_id=1`);
  srv.close();
  assert.match(out, /HTTP 520 cf-ray=abc123 - "Web server is returning an unknown error"/);
});

test('connect sends browser-like headers and explains the failure', async () => {
  const { srv, seen, port } = await rejectingServer(403, 'Forbidden: app_id blocked');
  const client = new DerivClient({ log: quietLog });
  try {
    await assert.rejects(client.connect([`ws://127.0.0.1:${port}/websockets/v3?app_id=1`]), (err) => {
      assert.match(err.message, /Could not reach any Deriv server/);
      assert.match(err.message, /HTTP 403/);
      assert.doesNotMatch(err.message, /app_id=1/, 'query strings are redacted');
      return true;
    });
  } finally {
    srv.close();
  }
  assert.equal(seen[0].origin, 'https://app.deriv.com');
  assert.match(seen[0]['user-agent'], /Mozilla/);
});
