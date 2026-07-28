import {
  createCopilotTokenStore,
  loadOrCreateCopilotIdentity,
  resolveCopilotClose,
} from "./copilot-gateway-lifecycle.js";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  GatewayBrowserDeviceAuthLifecycle,
  GatewayProtocolClient,
  GatewayProtocolRequestError,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "./copilot-runtime.js";
import { normalizeGatewayUrl } from "./panel-core.js";

const CLIENT_ID = GATEWAY_CLIENT_IDS.BROWSER_COPILOT;
const CLIENT_MODE = GATEWAY_CLIENT_MODES.UI;
const ROLE = "operator";
const SCOPES = ["operator.read", "operator.write"];
export function isDefinitiveGatewayRejection(error) {
  return error instanceof GatewayProtocolRequestError;
}

export async function waitForCopilotGatewayReady(client, gatewayScope) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } else {
        resolve();
      }
    };
    const unsubscribe = client.onStatus((status) => {
      if (status.state === "ready") {
        finish();
      } else if (
        status.state === "approval" ||
        status.state === "denied" ||
        status.state === "error"
      ) {
        finish(new Error(status.label || "Gateway recovery failed"));
      }
    });
    const timer = setTimeout(() => finish(new Error("Gateway recovery timed out")), 30_000);
    client.start(gatewayScope);
  });
}

function createBrowserSocket(url, handlers, WebSocketImpl) {
  const socket = new WebSocketImpl(url);
  socket.addEventListener("open", handlers.open);
  socket.addEventListener("message", (event) => handlers.message(String(event.data)));
  socket.addEventListener("close", (event) => handlers.close(event.code, event.reason));
  socket.addEventListener("error", () => handlers.error(new Error("Gateway WebSocket error")));
  return {
    isOpen: () => socket.readyState === WebSocketImpl.OPEN,
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
}

/** Dedicated browser-copilot Gateway client. It never accepts or stores shared auth. */
export class CopilotGatewayClient {
  constructor({ storage = chrome.storage.local, WebSocketImpl = WebSocket } = {}) {
    this.storage = storage;
    this.WebSocketImpl = WebSocketImpl;
    this.protocol = null;
    this.url = null;
    this.ready = false;
    this.hello = null;
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.lifecycle = null;
    this.tokenRecovery = null;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  start(url) {
    const gatewayScope = normalizeGatewayUrl(url);
    if (!gatewayScope) {
      this.stop();
      this.#emitStatus({ state: "error", label: "Invalid Gateway endpoint" });
      return;
    }
    if (this.protocol && this.url === gatewayScope) {
      return;
    }
    this.stop();
    this.url = gatewayScope;
    const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
      loadIdentity: () => loadOrCreateCopilotIdentity(this.storage, gatewayScope),
      tokenStore: createCopilotTokenStore(this.storage, gatewayScope),
    });
    this.lifecycle = lifecycle;
    this.#emitStatus({ state: "connecting", label: "Connecting to Gateway" });
    const protocol = new GatewayProtocolClient({
      createSocket: (handlers) => createBrowserSocket(gatewayScope, handlers, this.WebSocketImpl),
      createRequestId: () => crypto.randomUUID(),
      buildConnectPlan: ({ nonce }) =>
        lifecycle.buildPlan({
          client: {
            id: CLIENT_ID,
            version: chrome.runtime.getManifest().version,
            platform: "chrome",
            deviceFamily: "extension",
            mode: CLIENT_MODE,
          },
          role: ROLE,
          defaultScopes: SCOPES,
          nonce,
        }),
      buildConnectParams: (plan) => ({
        minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: CLIENT_ID,
          version: chrome.runtime.getManifest().version,
          platform: "chrome",
          deviceFamily: "extension",
          mode: CLIENT_MODE,
        },
        role: ROLE,
        scopes: plan.scopes,
        caps: [GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS, GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
        auth: plan.auth,
        device: plan.device,
        userAgent: navigator.userAgent,
        locale: navigator.language,
      }),
      onConnectHello: (hello, { plan }) => {
        void lifecycle.acceptHello(hello, plan);
      },
      onHello: (hello) => {
        this.ready = true;
        this.hello = hello;
        this.#emitStatus({ state: "ready", label: "Gateway connected", hello });
      },
      onConnectFailure: (error, { plan }) => {
        const details = error.details && typeof error.details === "object" ? error.details : {};
        if (details.code === "AUTH_DEVICE_TOKEN_MISMATCH") {
          const cleared = lifecycle.clearStoredToken(plan);
          void cleared.catch(() => undefined);
          this.tokenRecovery = { gatewayScope, protocol, cleared };
        }
        this.#emitStatus({
          state: details.code === "PAIRING_REQUIRED" ? "approval" : "error",
          label: error.message,
          requestId: typeof details.requestId === "string" ? details.requestId : undefined,
        });
        return {
          closeCode: 4008,
          closeReason: "connect failed",
          reconnectDelayMs: details.code === "PAIRING_REQUIRED" ? 2_000 : undefined,
          stop:
            details.code === "AUTH_DEVICE_TOKEN_MISMATCH" ||
            (details.pauseReconnect === true && details.code !== "PAIRING_REQUIRED"),
        };
      },
      resolveClose: resolveCopilotClose,
      onClose: (_context, decision) => {
        if (this.protocol !== protocol) {
          return;
        }
        this.ready = false;
        this.hello = null;
        if (!decision.retry) {
          this.protocol = null;
          this.lifecycle = null;
        }
        const recovery = this.tokenRecovery;
        if (!decision.retry && recovery?.protocol === protocol) {
          /** @param {unknown} error */
          const onClearRejected = (error) => {
            if (this.tokenRecovery !== recovery) {
              return;
            }
            this.tokenRecovery = null;
            this.#emitStatus({
              state: "error",
              label:
                error instanceof Error
                  ? error.message
                  : "Could not clear the rejected device token",
            });
          };
          void recovery.cleared.then(() => {
            if (
              this.tokenRecovery !== recovery ||
              this.protocol ||
              this.url !== recovery.gatewayScope
            ) {
              return;
            }
            this.tokenRecovery = null;
            this.start(recovery.gatewayScope);
          }, onClearRejected);
        }
        if (decision.notify) {
          this.#emitStatus({ state: "connecting", label: "Gateway reconnecting" });
        }
      },
      onConnectError: (error) =>
        this.#emitStatus({ state: "error", label: error.message || "Gateway unavailable" }),
      onEvent: (event) => {
        for (const listener of this.listeners) {
          listener(event);
        }
      },
      handshake: { mode: "require-challenge", timeoutMs: 5_000 },
      reconnect: { initialMs: 1_000, multiplier: 2, maxMs: 30_000 },
      requestTimeoutMs: 30_000,
    });
    this.protocol = protocol;
    protocol.start();
  }

  stop() {
    this.ready = false;
    this.hello = null;
    this.tokenRecovery = null;
    const protocol = this.protocol;
    this.protocol = null;
    protocol?.stop();
    this.lifecycle = null;
    this.url = null;
  }

  request(method, params, options) {
    if (!this.ready || !this.protocol) {
      return Promise.reject(new Error("Gateway is not ready"));
    }
    return this.protocol.request(method, params, options);
  }

  #emitStatus(status) {
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}
