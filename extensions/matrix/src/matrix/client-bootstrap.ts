import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Matrix plugin module implements client bootstrap behavior.
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { CoreConfig } from "../types.js";
import type { SharedMatrixClientLease } from "./client/shared.js";
import type { MatrixClient } from "./sdk.js";

type ResolvedRuntimeMatrixClient = {
  client: MatrixClient;
  lease?: SharedMatrixClientLease;
};

type MatrixRuntimeClientReadiness = "none" | "prepared" | "started";
type ResolvedRuntimeMatrixClientStopMode = "stop" | "persist" | "discard";

const loadMatrixSharedClientRuntimeDeps = createLazyRuntimeModule(() =>
  import("./client.js").then((clientModule) => ({
    acquireSharedMatrixClient: clientModule.acquireSharedMatrixClient,
    resolveMatrixAuthContext: clientModule.resolveMatrixAuthContext,
  })),
);

async function ensureResolvedClientReadiness(params: {
  client: MatrixClient;
  lease?: SharedMatrixClientLease;
  readiness?: MatrixRuntimeClientReadiness;
  preparedByDefault: boolean;
}): Promise<void> {
  if (params.readiness === "started") {
    if (params.lease) {
      await params.lease.start();
    } else {
      await params.client.start();
    }
    return;
  }
  if (params.readiness === "prepared" || (!params.readiness && params.preparedByDefault)) {
    await params.client.prepareForOneOff();
  }
}

export async function resolveRuntimeMatrixClientWithReadiness(opts: {
  client?: MatrixClient;
  cfg?: CoreConfig;
  timeoutMs?: number;
  accountId?: string | null;
  readiness?: MatrixRuntimeClientReadiness;
}): Promise<ResolvedRuntimeMatrixClient> {
  if (opts.client) {
    await ensureResolvedClientReadiness({
      client: opts.client,
      readiness: opts.readiness,
      preparedByDefault: false,
    });
    return { client: opts.client };
  }

  if (!opts.cfg) {
    throw new Error(
      "Matrix runtime client requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const cfg = requireRuntimeConfig(opts.cfg, "Matrix runtime client") as CoreConfig;
  const { acquireSharedMatrixClient, resolveMatrixAuthContext } =
    await loadMatrixSharedClientRuntimeDeps();
  const authContext = resolveMatrixAuthContext({
    cfg,
    accountId: opts.accountId,
  });
  const lease = await acquireSharedMatrixClient({
    cfg,
    timeoutMs: opts.timeoutMs,
    accountId: authContext.accountId,
    startClient: false,
    role: "transient",
  });
  try {
    await ensureResolvedClientReadiness({
      client: lease.client,
      lease,
      readiness: opts.readiness,
      preparedByDefault: true,
    });
  } catch (err) {
    await lease.release({ mode: "stop" });
    throw err;
  }
  return {
    client: lease.client,
    lease,
  };
}

export async function withResolvedRuntimeMatrixClient<T>(
  opts: {
    client?: MatrixClient;
    cfg?: CoreConfig;
    timeoutMs?: number;
    accountId?: string | null;
    readiness?: MatrixRuntimeClientReadiness;
  },
  run: (client: MatrixClient, abortSignal?: AbortSignal) => Promise<T>,
  stopMode: ResolvedRuntimeMatrixClientStopMode = "stop",
): Promise<T> {
  const resolved = await resolveRuntimeMatrixClientWithReadiness(opts);
  try {
    return await run(resolved.client, resolved.lease?.abortSignal);
  } finally {
    await resolved.lease?.release({ mode: stopMode });
  }
}
