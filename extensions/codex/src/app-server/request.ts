import type { CodexAppServerStartOptions } from "./config.js";
import type { JsonValue } from "./protocol.js";
import { getSharedCodexAppServerClient } from "./shared-client.js";
import { withTimeout } from "./timeout.js";

export async function requestCodexAppServerJson<T = JsonValue | undefined>(params: {
  method: string;
  requestParams?: JsonValue;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string;
}): Promise<T> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  return await withTimeout(
    (async () => {
      const client = await getSharedCodexAppServerClient({
        startOptions: params.startOptions,
        timeoutMs,
        authProfileId: params.authProfileId,
      });
      return await client.request<T>(params.method, params.requestParams, { timeoutMs });
    })(),
    timeoutMs,
    `codex app-server ${params.method} timed out`,
  );
}
