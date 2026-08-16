import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isUnsupportedCodexAppServerVersionError, type CodexAppServerClient } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

type CodexAppServerConnectionHealthServiceOptions = {
  getPluginConfig: () => unknown;
  getRuntimeConfig: () => OpenClawPluginServiceContext["config"] | undefined;
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
      } catch (error) {
        if (!signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.error(
            `codex app-server remote WebSocket configuration is invalid; update the configuration before reconnecting: ${message}`,
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
        await waitForCodexAppServerClose(leasedClient, signal);
        if (!signal.aborted) {
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
      monitor = run(ctx, abortController.signal);
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

function waitForCodexAppServerClose(
  client: CodexAppServerClient,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const finish = () => {
      removeCloseHandler();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const removeCloseHandler = client.addCloseHandler(finish);
    signal.addEventListener("abort", finish, { once: true });
  });
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
