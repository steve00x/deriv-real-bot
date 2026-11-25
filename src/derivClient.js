// Minimal client for the Deriv WebSocket API (https://api.deriv.com).
// Uses the WebSocket built into Node.js 22+.

export class DerivAPIError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export class DerivClient {
  constructor({ appId, endpoint = 'ws.derivws.com', log = console }) {
    this.url = `wss://${endpoint}/websockets/v3?app_id=${appId}`;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map(); // req_id -> { resolve, reject, timer }
    this.streams = new Map(); // req_id -> onMessage
    this.ws = null;
    this.pingTimer = null;
    this.onClose = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        // Deriv drops idle connections after ~2 minutes.
        this.pingTimer = setInterval(() => this.request({ ping: 1 }).catch(() => {}), 30_000);
        resolve();
      };
      ws.onerror = (e) => reject(new Error(`WebSocket error: ${e.message ?? 'connection failed'}`));
      ws.onmessage = (e) => this.#handle(JSON.parse(e.data));
      ws.onclose = () => {
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
