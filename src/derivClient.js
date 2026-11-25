// Minimal client for the Deriv WebSocket API (https://api.deriv.com).
// Uses the WebSocket built into Node.js 22+.

export class DerivAPIError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

const FALLBACK_ENDPOINTS = ['ws.derivws.com', 'ws.binaryws.com'];

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

/** Plain HTTPS probe to learn why a host is unreachable (WebSocket errors hide the cause). */
async function diagnose(host) {
  try {
    const res = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(10_000) });
    return ` (server is reachable over HTTPS, status ${res.status})`;
  } catch (err) {
    const cause = err.cause ?? err;
    const code = cause.code || cause.name;
    return ` [${code}: ${HINTS[code] || cause.message}]`;
  }
}

export class DerivClient {
  constructor({ appId, endpoint = 'ws.derivws.com', log = console }) {
    this.appId = appId;
    // Try the configured server first, then Deriv's other public endpoints.
    this.endpoints = [...new Set([endpoint, ...FALLBACK_ENDPOINTS])];
    this.url = null;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map(); // req_id -> { resolve, reject, timer }
    this.streams = new Map(); // req_id -> onMessage
    this.ws = null;
    this.pingTimer = null;
    this.onClose = null;
  }

  /** Connect to the first reachable endpoint; throws with a diagnosis if none work. */
  async connect() {
    const failures = [];
    for (const host of this.endpoints) {
      const url = `wss://${host}/websockets/v3?app_id=${this.appId}`;
      try {
        await this.#open(url);
        this.url = url;
        this.log.info(`Connected to wss://${host}`);
        return;
      } catch (err) {
        const why = `${err.message}${await diagnose(host)}`;
        this.log.warn(`Could not connect to ${host}: ${why}`);
        failures.push(`${host}: ${why}`);
      }
    }
    throw new Error(
      `Could not reach any Deriv server.\n  ${failures.join('\n  ')}\n` +
        'Check your internet connection, firewall/antivirus, or whether Deriv is blocked on your network (try a VPN).',
    );
  }

  #open(url, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
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
