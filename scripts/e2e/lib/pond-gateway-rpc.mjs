// Gateway RPC client used by the Pond E2E verifier.
import { WebSocket } from "ws";
import { waitForWebSocketOpen } from "./websocket-open.mjs";

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function formatCloseReason(code, reason) {
  const text = reason instanceof Uint8Array ? Buffer.from(reason).toString("utf8") : String(reason);
  return text ? ` (${code}): ${text}` : ` (${code})`;
}

export class PondGatewayRpc {
  constructor({
    url,
    token,
    scopes,
    openTimeoutMs = 15_000,
    webSocketFactory = (target) => new WebSocket(target),
  }) {
    this.url = url;
    this.token = token;
    this.scopes = scopes;
    this.openTimeoutMs = openTimeoutMs;
    this.webSocketFactory = webSocketFactory;
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    this.ws = this.webSocketFactory(this.url);
    this.ws.on("message", (data) => this.onMessage(data));
    // These listeners outlive the open wait so post-handshake failures reject RPCs
    // instead of surfacing as uncaught EventEmitter errors.
    this.ws.on("error", (error) => this.rejectPending(asError(error)));
    this.ws.on("close", (code, reason) => {
      this.rejectPending(new Error(`Gateway socket closed${formatCloseReason(code, reason)}`));
    });

    try {
      await waitForWebSocketOpen(
        this.ws,
        this.openTimeoutMs,
        `Gateway connect timeout: ${this.url}`,
      );
      await this.request("connect", {
        minProtocol: 1,
        maxProtocol: 99,
        client: {
          id: "gateway-client",
          displayName: "Pond proof verifier",
          version: "0.0.0",
          platform: process.platform,
          mode: "backend",
        },
        auth: { token: this.token },
        role: "operator",
        scopes: this.scopes,
      });
    } catch (error) {
      // Callers only receive the client after connect succeeds, so failed setup
      // must close its socket here or the E2E process can remain alive.
      this.close();
      throw error;
    }
  }

  rejectPending(error) {
    this.terminalError ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.terminalError);
    }
    this.pending.clear();
  }

  onMessage(data) {
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    if (frame?.type !== "res" || typeof frame.id !== "string") {
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    if (pending.expectFinal && frame.payload?.status === "accepted") {
      return;
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.payload);
      return;
    }
    pending.reject(new Error(frame.error?.message ?? `Gateway RPC failed: ${pending.method}`));
  }

  request(method, params = {}, options = {}) {
    if (this.terminalError) {
      return Promise.reject(asError(this.terminalError));
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Gateway socket is not open for RPC: ${method}`));
    }

    const id = `pond-proof-${this.nextId}`;
    this.nextId += 1;
    const timeoutMs = options.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        expectFinal: options.expectFinal === true,
        resolve,
        reject,
        timer,
      });
      try {
        this.ws.send(JSON.stringify({ type: "req", id, method, params }), (error) => {
          if (!error) {
            return;
          }
          const pending = this.pending.get(id);
          if (!pending) {
            return;
          }
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(asError(error));
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(asError(error));
      }
    });
  }

  close() {
    this.rejectPending(new Error("Gateway RPC client closed"));
    if (this.ws?.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}
