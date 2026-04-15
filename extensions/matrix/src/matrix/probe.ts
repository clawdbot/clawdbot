import { formatErrorMessage, type PinnedDispatcherPolicy } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SsrFPolicy } from "../runtime-api.js";
import type { BaseProbeResult } from "../runtime-api.js";
import { isBunRuntime } from "./client/runtime.js";

type MatrixProbeRuntimeDeps = Pick<typeof import("./probe.runtime.js"), "createMatrixClient">;

let matrixProbeRuntimeDepsPromise: Promise<MatrixProbeRuntimeDeps> | undefined;

async function loadMatrixProbeRuntimeDeps(): Promise<MatrixProbeRuntimeDeps> {
  matrixProbeRuntimeDepsPromise ??= import("./probe.runtime.js").then((runtimeModule) => ({
    createMatrixClient: runtimeModule.createMatrixClient,
  }));
  return await matrixProbeRuntimeDepsPromise;
}

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
  const started = Date.now();
  const result: MatrixProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
  };
  if (isBunRuntime()) {
    return {
      ...result,
      error: "Matrix probe requires Node (bun runtime not supported)",
      elapsedMs: Date.now() - started,
    };
  }
  if (!params.homeserver?.trim()) {
    return {
      ...result,
      error: "missing homeserver",
      elapsedMs: Date.now() - started,
    };
  }
  if (!params.accessToken?.trim()) {
    return {
      ...result,
      error: "missing access token",
      elapsedMs: Date.now() - started,
    };
  }
  try {
    const { createMatrixClient } = await loadMatrixProbeRuntimeDeps();
    const inputUserId = normalizeOptionalString(params.userId);
    const client = await createMatrixClient({
      homeserver: params.homeserver,
      userId: inputUserId,
      accessToken: params.accessToken,
      deviceId: params.deviceId,
      persistStorage: false,
      localTimeoutMs: params.timeoutMs,
      accountId: params.accountId,
      allowPrivateNetwork: params.allowPrivateNetwork,
      ssrfPolicy: params.ssrfPolicy,
      dispatcherPolicy: params.dispatcherPolicy,
    });
    // The client wrapper resolves user ID via whoami when needed.
    const userId = await client.getUserId();
    result.ok = true;
    result.userId = userId ?? null;

    result.elapsedMs = Date.now() - started;
    return result;
  } catch (err) {
    return {
      ...result,
      status:
        typeof err === "object" && err && "statusCode" in err
          ? Number((err as { statusCode?: number }).statusCode)
          : result.status,
      error: formatErrorMessage(err),
      elapsedMs: Date.now() - started,
    };
  }
}
