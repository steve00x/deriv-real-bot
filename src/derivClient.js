// Minimal client for the Deriv WebSocket API (https://api.deriv.com).
// Uses the WebSocket built into Node.js 22+.
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';

export class DerivAPIError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const HINTS = {
  ENOTFOUND: 'DNS lookup failed: the name could not be resolved (no internet, or DNS blocks Deriv)',
  EAI_AGAIN: 'DNS lookup failed temporarily (check your internet connection)',
  ECONNREFUSED: 'connection refused (a firewall or proxy is blocking it)',
  ECONNRESET: 'connection reset (often an ISP, firewall or antivirus blocking Deriv)',
  ETIMEDOUT: 'connection timed out (network or firewall blocking it)',
  UND_ERR_CONNECT_TIMEOUT: 'connection timed out (network or firewall blocking it)',
  CERT_HAS_EXPIRED: 'TLS certificate problem (check your PC clock, or antivirus HTTPS scanning)',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS certificate not trusted (antivirus HTTPS scanning or a corporate proxy)',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate not trusted (antivirus HTTPS scanning or a corporate proxy)',
};

// Cloudflare in front of Deriv can reject clients that don't look like a browser.
export const HANDSHAKE_HEADERS = {
  Origin: 'https://app.deriv.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) deriv-rise-fall-bot/1.0',
};

/**
 * Repeat the WebSocket handshake with node:https to see the server's actual answer
 * (Node's WebSocket only reports "1006" when the handshake is rejected).
 */
export function diagnose(url, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const target = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const req = (target.startsWith('https:') ? https : http).request(target, {
      headers: {
        ...HANDSHAKE_HEADERS,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      },
      timeout: timeoutMs,
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(' (a fresh handshake succeeded, so the failure may be intermittent; try again)');
    });
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (body.length < 4000) body += chunk;
      });
      res.on('end', () => {
        const text = body
          .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);
        const ray = res.headers['cf-ray'] ? ` cf-ray=${res.headers['cf-ray']}` : '';
        resolve(` [handshake rejected: HTTP ${res.statusCode}${ray}${text ? ` - "${text}"` : ''}]`);
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) => resolve(` [${err.code}: ${HINTS[err.code] || err.message}]`));
    req.end();
  });
}

/** Hide query strings (they can hold an OTP or app id) when logging a URL. */
export const redact = (url) => url.split('?')[0];

export class DerivClient {
  constructor({ log = console } = {}) {
    this.url = null;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map(); // req_id -> { resolve, reject, timer }
    this.streams = new Map(); // req_id -> onMessage
    this.ws = null;
    this.pingTimer = null;
    this.onClose = null;
  }

  /**
   * Connect to the first URL that works (a URL may contain a one-time password,
   * so it is never logged). Throws with a diagnosis if none work.
   */
  async connect(urls) {
    const failures = [];
    for (const url of [urls].flat()) {
      const shown = redact(url);
      try {
        await this.#open(url);
        this.url = url;
        this.log.info(`Connected to ${shown}`);
        return;
      } catch (err) {
        // Don't replay a one-time-password URL: the OTP is single use.
        const why = `${err.message}${url.includes('otp=') ? '' : await diagnose(url)}`;
        this.log.warn(`Could not connect to ${shown}: ${why}`);
        failures.push(`${shown}: ${why}`);
      }
    }
    throw new Error(
      `Could not reach any Deriv server.\n  ${failures.join('\n  ')}\n` +
        'Check your internet connection, firewall/antivirus, or whether Deriv is blocked on your network (try a VPN).',
    );
  }

  #open(url, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: HANDSHAKE_HEADERS });
      let opened = false;
      let errorText = '';
      const timer = setTimeout(() => {
        reject(new Error(`timed out after ${timeoutMs / 1000}s`));
        ws.close();
      }, timeoutMs);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        this.ws = ws;
        // Deriv drops idle connections after ~2 minutes.
        this.pingTimer = setInterval(() => this.request({ ping: 1 }).catch(() => {}), 30_000);
        resolve();
      };
      ws.onerror = (e) => {
        errorText = e.error?.cause?.message || e.error?.message || e.message || '';
        // A rejected handshake fires 'error' but may never fire 'close'.
        if (!opened) {
          clearTimeout(timer);
          reject(new Error(errorText || 'connection failed'));
        }
      };
      ws.onmessage = (e) => this.#handle(JSON.parse(e.data));
      ws.onclose = (e) => {
        if (!opened) {
          clearTimeout(timer);
          const detail = [errorText, e.code && `close code ${e.code}`, e.reason].filter(Boolean).join(', ');
          reject(new Error(detail || 'connection failed'));
          return;
        }
        clearInterval(this.pingTimer);
        const err = new DerivAPIError('ConnectionClosed', 'WebSocket closed');
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        this.onClose?.(err);
      };
    });
  }

  close() {
    clearInterval(this.pingTimer);
    this.onClose = null;
    this.ws?.close();
  }

  /** Send a one-shot request and resolve with its response. */
  request(payload, timeoutMs = 30_000) {
    const reqId = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new DerivAPIError('Timeout', `No response to ${Object.keys(payload)[0]}`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
    });
  }

  /**
   * Start a subscription. onMessage(msg) is called for every update, including the first.
   * Errors arrive as messages with an `error` field. Returns the req_id.
   */
  subscribe(payload, onMessage) {
    const reqId = this.nextId++;
    this.streams.set(reqId, onMessage);
    this.ws.send(JSON.stringify({ ...payload, subscribe: 1, req_id: reqId }));
    return reqId;
  }

  unsubscribe(reqId, subscriptionId) {
    this.streams.delete(reqId);
    if (subscriptionId) this.request({ forget: subscriptionId }).catch(() => {});
  }

  #handle(msg) {
    const id = msg.req_id;
    const stream = this.streams.get(id);
    if (stream) {
      stream(msg);
      return;
    }
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new DerivAPIError(msg.error.code, msg.error.message));
    else p.resolve(msg);
  }
}
