import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

type GatewayConfigClient = {
  call: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
};

function isStaleConfigPatchError(error: unknown) {
  return formatErrorMessage(error).toLowerCase().includes("config changed since last load");
}

async function waitForLiveQaGatewayConfigApplied(params: {
  expectedHash: string;
  gateway: GatewayConfigClient;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  let lastStatus:
    | {
        appliedConfigHash?: string;
        configRevisionHash?: string;
        hash?: string;
      }
    | undefined;
  while (Date.now() < deadline) {
    try {
      const status = (await params.gateway.call(
        "config.get",
        {},
        { timeoutMs: Math.max(1, Math.min(5_000, deadline - Date.now())) },
      )) as {
        appliedConfigHash?: string;
        configRevisionHash?: string;
        hash?: string;
      };
      lastStatus = {
        appliedConfigHash: status.appliedConfigHash,
        configRevisionHash: status.configRevisionHash,
        hash: status.hash,
      };
      if (
        status.hash === params.expectedHash &&
        status.configRevisionHash === params.expectedHash &&
        status.appliedConfigHash === params.expectedHash
      ) {
        return;
      }
    } catch {
      // A restart can disconnect the control client before the new Gateway is ready.
    }
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  throw new Error(
    `live QA config was not applied by the active Gateway; last status: ${JSON.stringify(lastStatus ?? {})}`,
  );
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
    let patchResult: { hash?: string; noop?: boolean };
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
      if (!patchResult.hash) {
        throw new Error("live QA config patch returned no persisted hash");
      }
      // Restart-required writes acknowledge before SIGUSR1 completes. The old
      // Gateway can still look healthy, so require the active runtime revision.
      await waitForLiveQaGatewayConfigApplied({
        expectedHash: patchResult.hash,
        gateway: params.gateway,
        timeoutMs: params.timeoutMs,
      });
    }
    return;
  }
  throw new Error("live QA config patch exhausted retries");
}
