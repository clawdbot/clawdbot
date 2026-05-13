import type { resolveCodexAppServerAuthProfileIdForAgent } from "./auth-bridge.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type {
  CodexAppServerRequestMethod,
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  JsonValue,
} from "./protocol.js";
import {
  createIsolatedCodexAppServerClient,
  getSharedCodexAppServerClient,
} from "./shared-client.js";
import { withTimeout } from "./timeout.js";

export async function requestCodexAppServerJson<M extends CodexAppServerRequestMethod>(params: {
  method: M;
  requestParams: CodexAppServerRequestParams<M>;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  isolated?: boolean;
}): Promise<CodexAppServerRequestResult<M>>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(params: {
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  isolated?: boolean;
}): Promise<T>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(params: {
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  isolated?: boolean;
}): Promise<T> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  return await withTimeout(
    (async () => {
      const client = await (
        params.isolated ? createIsolatedCodexAppServerClient : getSharedCodexAppServerClient
      )({
        startOptions: params.startOptions,
        timeoutMs,
        authProfileId: params.authProfileId,
        agentDir: params.agentDir,
        config: params.config,
      });
      try {
        return await client.request<T>(params.method, params.requestParams, { timeoutMs });
      } finally {
        if (params.isolated) {
          // Wait for the child to actually exit (with a SIGKILL fallback) so
          // the parent process doesn't hang on an orphaned codex app-server.
          // The stdio bin shim does not always propagate stdin EOF to the
          // underlying codex binary, so the unref'd close() path can leave
          // the child running and keep the parent's event loop alive.
          await client.closeAndWait({ exitTimeoutMs: 2_000, forceKillDelayMs: 250 });
        }
      }
    })(),
    timeoutMs,
    `codex app-server ${params.method} timed out`,
  );
}
