import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

type GatewayConfigClient = {
  call: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
};

function isStaleConfigPatchError(error: unknown) {
  return formatErrorMessage(error).toLowerCase().includes("config changed since last load");
}

export async function readLiveQaGatewayConfig(gateway: GatewayConfigClient) {
  const snapshot = (await gateway.call("config.get", {}, { timeoutMs: 60_000 })) as {
    config?: Record<string, unknown>;
    hash?: string;
  };
  if (!snapshot.config || !snapshot.hash) {
    throw new Error("live QA config patch requires config.get config and hash");
  }
  return snapshot;
}

export async function patchLiveQaGatewayConfig(params: {
  gateway: GatewayConfigClient;
  patch: Record<string, unknown>;
  replacePaths?: string[];
  timeoutMs: number;
  waitForConfigRestartSettle: (options: {
    restartDelayMs: number;
    timeoutMs: number;
  }) => Promise<void>;
}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = await readLiveQaGatewayConfig(params.gateway);
    let patchResult: { noop?: boolean };
    try {
      patchResult =
        ((await params.gateway.call(
          "config.patch",
          {
            raw: JSON.stringify(params.patch, null, 2),
            baseHash: snapshot.hash,
            ...(params.replacePaths?.length ? { replacePaths: params.replacePaths } : {}),
            restartDelayMs: 0,
          },
          { timeoutMs: 60_000 },
        )) as { noop?: boolean } | null | undefined) ?? {};
    } catch (error) {
      if (attempt === 0 && isStaleConfigPatchError(error)) {
        continue;
      }
      throw error;
    }
    if (patchResult.noop !== true) {
      await params.waitForConfigRestartSettle({
        restartDelayMs: 0,
        timeoutMs: params.timeoutMs,
      });
    }
    return;
  }
  throw new Error("live QA config patch exhausted retries");
}
