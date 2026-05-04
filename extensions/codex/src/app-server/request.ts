import type { resolveCodexAppServerAuthProfileIdForAgent } from "./auth-bridge.js";
import type { CodexAppServerStartOptions } from "./config.js";
import type {
  CodexAppServerRequestMethod,
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  JsonValue,
} from "./protocol.js";
import { getSharedCodexAppServerClient } from "./shared-client.js";
import { withTimeout } from "./timeout.js";

export async function requestCodexAppServerJson<M extends CodexAppServerRequestMethod>(params: {
  method: M;
  requestParams: CodexAppServerRequestParams<M>;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
}): Promise<CodexAppServerRequestResult<M>>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(params: {
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
}): Promise<T>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(params: {
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
}): Promise<T> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  return await withTimeout(
    (async () => {
      const client = await getSharedCodexAppServerClient({
        startOptions: params.startOptions,
        timeoutMs,
        authProfileId: params.authProfileId,
        config: params.config,
      });
      return await client.request<T>(params.method, params.requestParams, { timeoutMs });
    })(),
    timeoutMs,
    `codex app-server ${params.method} timed out`,
  );
}
