import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
// Matrix plugin module implements probe behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runChannelProbe } from "openclaw/plugin-sdk/text-utility-runtime";
import { isBunRuntime } from "./client/runtime.js";

const loadMatrixProbeRuntimeDeps = createLazyRuntimeModule(() =>
  import("./probe.runtime.js").then((runtimeModule) => ({
    createMatrixClient: runtimeModule.createMatrixClient,
  })),
);

export type MatrixProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  userId?: string | null;
};

export async function probeMatrix(params: {
  homeserver: string;
  accessToken: string;
  userId?: string;
  deviceId?: string;
  timeoutMs?: number;
  accountId?: string | null;
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}): Promise<MatrixProbe> {
  return await runChannelProbe(
    undefined,
    async () => {
      const result: Omit<MatrixProbe, "elapsedMs"> = {
        ok: false,
        status: null,
        error: null,
      };
      if (isBunRuntime()) {
        return { ...result, error: "Matrix probe requires Node (bun runtime not supported)" };
      }
      if (!params.homeserver?.trim()) {
        return { ...result, error: "missing homeserver" };
      }
      if (!params.accessToken?.trim()) {
        return { ...result, error: "missing access token" };
      }
      const { createMatrixClient } = await loadMatrixProbeRuntimeDeps();
      const inputUserId = normalizeOptionalString(params.userId);
      const client = await createMatrixClient({
        homeserver: params.homeserver,
        // A seeded userId makes getUserId() a local getter; probes must force whoami auth.
        userId: undefined,
        accessToken: params.accessToken,
        deviceId: params.deviceId,
        persistStorage: false,
        localTimeoutMs: params.timeoutMs,
        accountId: params.accountId,
        allowPrivateNetwork: params.allowPrivateNetwork,
        ssrfPolicy: params.ssrfPolicy,
        dispatcherPolicy: params.dispatcherPolicy,
      });
      const userId = await client.getUserId();
      if (inputUserId && inputUserId !== userId) {
        return { ...result, error: "Matrix access token user does not match configured userId" };
      }
      return { ...result, ok: true, userId };
    },
    (error) => ({
      ok: false,
      status:
        typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode?: number }).statusCode)
          : null,
      error: formatErrorMessage(error),
    }),
  );
}
