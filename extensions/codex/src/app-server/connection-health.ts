import {
  emitTrustedDiagnosticEvent,
  type DiagnosticModelAuthStateEvent,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  CodexAppServerRpcError,
  isCodexAppServerConnectionClosedError,
  isUnsupportedCodexAppServerVersionError,
  type CodexAppServerClient,
} from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { isJsonObject } from "./protocol.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MODEL_AUTH_PROBE_INTERVAL_MS = 60_000;
const MODEL_AUTH_PROBE_JITTER_RATIO = 0.1;
const MODEL_AUTH_PROBE_TIMEOUT_MS = 10_000;

type ModelAuthStateInput = Omit<DiagnosticModelAuthStateEvent, "seq" | "ts" | "type">;

type CodexAppServerConnectionHealthServiceOptions = {
  getPluginConfig: () => unknown;
  getRuntimeConfig: () => OpenClawPluginServiceContext["config"] | undefined;
  modelAuthProbeIntervalMs?: number;
  random?: () => number;
};

export function createCodexAppServerConnectionHealthService(
  options: CodexAppServerConnectionHealthServiceOptions,
): OpenClawPluginService {
  let abortController: AbortController | undefined;
  let monitor: Promise<void> | undefined;
  let leasedClient: CodexAppServerClient | undefined;

  const releaseClient = () => {
    if (!leasedClient) {
      return;
    }
    const client = leasedClient;
    leasedClient = undefined;
    releaseLeasedSharedCodexAppServerClient(client);
  };

  const run = async (ctx: OpenClawPluginServiceContext, signal: AbortSignal) => {
    let consecutiveFailures = 0;

    while (!signal.aborted) {
      let pluginConfig: unknown;
      let runtime: ReturnType<typeof resolveCodexAppServerRuntimeOptions>;
      try {
        pluginConfig = options.getPluginConfig();
        runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
      } catch {
        if (!signal.aborted) {
          ctx.logger.error(
            "codex app-server remote WebSocket configuration is invalid; update the configuration before reconnecting",
          );
        }
        return;
      }
      if (runtime.start.transport !== "websocket") {
        return;
      }

      try {
        leasedClient = await getLeasedSharedCodexAppServerClient({
          pluginConfig,
          config: options.getRuntimeConfig() ?? ctx.config,
          timeoutMs: runtime.requestTimeoutMs,
          abandonSignal: signal,
        });
        if (signal.aborted) {
          return;
        }

        consecutiveFailures = 0;
        ctx.logger.info("codex app-server remote WebSocket connection is healthy");
        await runModelAuthProbeLoop({
          client: leasedClient,
          signal,
          timeoutMs: Math.min(runtime.requestTimeoutMs, MODEL_AUTH_PROBE_TIMEOUT_MS),
          intervalMs: options.modelAuthProbeIntervalMs ?? MODEL_AUTH_PROBE_INTERVAL_MS,
          random: options.random ?? Math.random,
        });
        if (!signal.aborted) {
          emitModelAuthState({
            state: "unknown",
            authMode: "unknown",
            reason: "transport_error",
          });
          ctx.logger.warn("codex app-server remote WebSocket disconnected; reconnecting");
        }
      } catch (error) {
        if (!signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          if (isPermanentCodexAppServerConnectionFailure(error)) {
            ctx.logger.error(
              `codex app-server remote WebSocket requires an authentication or version update; not retrying: ${message}`,
            );
            return;
          }
          emitModelAuthState({
            state: "unknown",
            authMode: "unknown",
            reason: "transport_error",
          });
          consecutiveFailures += 1;
          ctx.logger.warn(`codex app-server remote WebSocket connection failed: ${message}`);
        }
      } finally {
        releaseClient();
      }

      if (!signal.aborted) {
        const exponentialDelayMs = Math.min(
          INITIAL_RECONNECT_DELAY_MS * 2 ** Math.max(0, consecutiveFailures - 1),
          MAX_RECONNECT_DELAY_MS,
        );
        const reconnectDelayMs = Math.min(
          Math.round(exponentialDelayMs * (0.75 + Math.random() * 0.5)),
          MAX_RECONNECT_DELAY_MS,
        );
        await waitForReconnect(reconnectDelayMs, signal);
      }
    }
  };

  return {
    id: "codex-app-server-connection-health",
    start(ctx) {
      if (abortController) {
        return;
      }
      abortController = new AbortController();
      monitor = run(ctx, abortController.signal).finally(clearModelAuthState);
    },
    async stop() {
      abortController?.abort();
      await monitor;
      releaseClient();
      monitor = undefined;
      abortController = undefined;
    },
  };
}

function emitModelAuthState(state: ModelAuthStateInput): void {
  emitTrustedDiagnosticEvent({ type: "model.auth.state", ...state });
}

function clearModelAuthState(): void {
  emitTrustedDiagnosticEvent({ type: "model.auth.clear" });
}

async function runModelAuthProbeLoop(params: {
  client: CodexAppServerClient;
  signal: AbortSignal;
  timeoutMs: number;
  intervalMs: number;
  random: () => number;
}): Promise<void> {
  const connectionAbort = new AbortController();
  const close = () => connectionAbort.abort();
  const removeCloseHandler = params.client.addCloseHandler(close);
  params.signal.addEventListener("abort", close, { once: true });
  try {
    while (!connectionAbort.signal.aborted) {
      const state = await probeModelAuthState(params.client, {
        signal: connectionAbort.signal,
        timeoutMs: params.timeoutMs,
      });
      if (connectionAbort.signal.aborted) {
        break;
      }
      emitModelAuthState(state);
      await waitForReconnect(
        jitteredModelAuthProbeDelayMs(params.intervalMs, params.random),
        connectionAbort.signal,
      );
    }
  } finally {
    removeCloseHandler();
    params.signal.removeEventListener("abort", close);
  }
}

async function probeModelAuthState(
  client: CodexAppServerClient,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<ModelAuthStateInput> {
  try {
    const response = await client.request("account/read", { refreshToken: false }, options);
    const requiresOpenaiAuth =
      response.requiresOpenaiAuth === true
        ? true
        : response.requiresOpenaiAuth === false
          ? false
          : undefined;
    if (!response.account) {
      return requiresOpenaiAuth === true
        ? { state: "not_ready", authMode: "subscription", reason: "missing_account" }
        : { state: "unknown", authMode: "unknown", reason: "unsupported_auth_mode" };
    }
    if (!isJsonObject(response.account) || typeof response.account.type !== "string") {
      return { state: "unknown", authMode: "unknown", reason: "probe_error" };
    }
    if (response.account.type === "chatgpt" && requiresOpenaiAuth === false) {
      return { state: "not_ready", authMode: "api_key", reason: "route_mismatch" };
    }
    if (response.account.type !== "chatgpt") {
      if (requiresOpenaiAuth === true) {
        return { state: "not_ready", authMode: "subscription", reason: "route_mismatch" };
      }
      return {
        state: "unknown",
        authMode: response.account.type === "apiKey" ? "api_key" : "native",
        reason: "unsupported_auth_mode",
      };
    }
    await client.request("account/rateLimits/read", undefined, options);
    return { state: "ready", authMode: "subscription", reason: "ready" };
  } catch (error) {
    if (options.signal.aborted || isCodexAppServerConnectionClosedError(error)) {
      return { state: "unknown", authMode: "unknown", reason: "transport_error" };
    }
    if (isDefiniteModelAuthFailure(error)) {
      return { state: "not_ready", authMode: "subscription", reason: "unauthenticated" };
    }
    if (isUnsupportedModelAuthProbe(error)) {
      return { state: "unknown", authMode: "unknown", reason: "unsupported_version" };
    }
    return { state: "unknown", authMode: "unknown", reason: "probe_error" };
  }
}

function isDefiniteModelAuthFailure(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRpcError)) {
    return false;
  }
  if (error.code === 401 || error.code === 403) {
    return true;
  }
  const data = isJsonObject(error.data) ? error.data : undefined;
  const nested = isJsonObject(data?.error) ? data.error : data;
  return (
    nested?.statusCode === 401 ||
    nested?.statusCode === 403 ||
    nested?.action === "relogin" ||
    (nested?.reason === "cloudRequirements" && nested?.errorCode === "Auth")
  );
}

function isUnsupportedModelAuthProbe(error: unknown): boolean {
  return error instanceof CodexAppServerRpcError && error.code === -32601;
}

function jitteredModelAuthProbeDelayMs(intervalMs: number, random: () => number): number {
  const factor = 1 - MODEL_AUTH_PROBE_JITTER_RATIO + random() * MODEL_AUTH_PROBE_JITTER_RATIO * 2;
  return Math.max(1, Math.round(intervalMs * factor));
}

function isPermanentCodexAppServerConnectionFailure(error: unknown): boolean {
  const seen = new Set<Error>();
  let current = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (isUnsupportedCodexAppServerVersionError(current)) {
      return true;
    }

    const status =
      "statusCode" in current
        ? current.statusCode
        : "status" in current
          ? current.status
          : undefined;
    if (
      status === 401 ||
      status === 403 ||
      /^Unexpected server response: (?:401|403)\b/u.test(current.message)
    ) {
      return true;
    }

    const data = "data" in current ? current.data : undefined;
    if (data && typeof data === "object" && "statusCode" in data) {
      if (data.statusCode === 401 || data.statusCode === 403) {
        return true;
      }
    }
    current = current.cause;
  }

  return false;
}

function waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
  });
}
