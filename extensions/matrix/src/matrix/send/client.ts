import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import type { MatrixClient } from "../sdk.js";

type MatrixSendClientRuntime = Pick<
  typeof import("../client-bootstrap.js"),
  "withResolvedRuntimeMatrixClient"
>;

let matrixSendClientRuntimePromise: Promise<MatrixSendClientRuntime> | null = null;

async function loadMatrixSendClientRuntime(): Promise<MatrixSendClientRuntime> {
  matrixSendClientRuntimePromise ??= import("../client-bootstrap.js");
  return await matrixSendClientRuntimePromise;
}

export function resolveMediaMaxBytes(
  accountId?: string | null,
  cfg?: CoreConfig,
): number | undefined {
  if (!cfg) {
    throw new Error(
      "Matrix media limits requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const resolvedCfg = requireRuntimeConfig(cfg, "Matrix media limits") as CoreConfig;
  const matrixCfg = resolveMatrixAccountConfig({ cfg: resolvedCfg, accountId });
  const mediaMaxMb = typeof matrixCfg.mediaMaxMb === "number" ? matrixCfg.mediaMaxMb : undefined;
  if (typeof mediaMaxMb === "number") {
    return mediaMaxMb * 1024 * 1024;
  }
  return undefined;
}

export async function withResolvedMatrixSendClient<T>(
  opts: {
    client?: MatrixClient;
    cfg?: CoreConfig;
    timeoutMs?: number;
    accountId?: string | null;
  },
  run: (client: MatrixClient) => Promise<T>,
): Promise<T> {
  return await withResolvedMatrixClient(
    {
      ...opts,
      // One-off outbound sends still need a started client so room encryption
      // state and live crypto sessions are available before sendMessage/sendEvent.
      readiness: "started",
    },
    run,
    // Started one-off send clients should flush sync/crypto state before CLI
    // shutdown paths can tear down the process.
    "persist",
  );
}

export async function withResolvedMatrixControlClient<T>(
  opts: {
    client?: MatrixClient;
    cfg?: CoreConfig;
    timeoutMs?: number;
    accountId?: string | null;
  },
  run: (client: MatrixClient) => Promise<T>,
): Promise<T> {
  return await withResolvedMatrixClient(
    {
      ...opts,
      readiness: "none",
    },
    run,
  );
}

async function withResolvedMatrixClient<T>(
  opts: {
    client?: MatrixClient;
    cfg?: CoreConfig;
    timeoutMs?: number;
    accountId?: string | null;
    readiness: "started" | "none";
  },
  run: (client: MatrixClient) => Promise<T>,
  shutdownBehavior?: "persist",
): Promise<T> {
  if (opts.client) {
    return await run(opts.client);
  }
  const { withResolvedRuntimeMatrixClient } = await loadMatrixSendClientRuntime();
  return await withResolvedRuntimeMatrixClient(opts, run, shutdownBehavior);
}
