import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { CodexAppServerClient } from "./client.js";
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
      try {
        const pluginConfig = options.getPluginConfig();
        const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
        if (runtime.start.transport !== "websocket") {
          return;
        }

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
          consecutiveFailures += 1;
          const message = error instanceof Error ? error.message : String(error);
          ctx.logger.warn(`codex app-server remote WebSocket connection failed: ${message}`);
        }
      } finally {
        releaseClient();
      }

      if (!signal.aborted) {
        const reconnectDelayMs = Math.min(
          INITIAL_RECONNECT_DELAY_MS * 2 ** Math.max(0, consecutiveFailures - 1),
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
