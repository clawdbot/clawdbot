/** Reads ACP session status from the runtime and reconciles persisted identity metadata. */
import { resolveSessionIdentityFromMeta } from "@openclaw/acp-core/runtime/session-identity";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
} from "@openclaw/acp-core/runtime/types";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import type {
  AcpSessionStatus,
  EnsureManagerRuntimeHandle,
  ReconcileManagerRuntimeSessionIdentifiers,
  ResolveManagerSession,
} from "./manager.types.js";
import { requireReadySessionMeta } from "./manager.utils.js";
import { resolveRuntimeOptionsFromMeta } from "./runtime-options.js";

/** Reads a fresh ACP session status and reconciles runtime identifiers from the status response. */
export async function runManagerGetSessionStatus(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  signal?: AbortSignal;
  throwIfAborted: (signal?: AbortSignal) => void;
  resolveSession: ResolveManagerSession;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  resolveRuntimeCapabilities: (params: {
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
  }) => Promise<AcpRuntimeCapabilities>;
  reconcileRuntimeSessionIdentifiers: ReconcileManagerRuntimeSessionIdentifiers;
}): Promise<AcpSessionStatus> {
  params.throwIfAborted(params.signal);
  const resolution = params.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const resolvedMeta = requireReadySessionMeta(resolution);
  const {
    runtime,
    handle: ensuredHandle,
    meta: initialMeta,
  } = await params.ensureRuntimeHandle({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    meta: resolvedMeta,
  });
  let handle = ensuredHandle;
  const capabilities = await params.resolveRuntimeCapabilities({ runtime, handle });
  let runtimeStatus: AcpRuntimeStatus | undefined;
  if (runtime.getStatus) {
    runtimeStatus = await withAcpRuntimeErrorBoundary({
      run: async () => {
        params.throwIfAborted(params.signal);
        const status = await runtime.getStatus!({
          handle,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        params.throwIfAborted(params.signal);
        return status;
      },
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not read ACP runtime status.",
    });
  }
  const reconciledSession = await params.reconcileRuntimeSessionIdentifiers({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    runtime,
    handle,
    meta: initialMeta,
    runtimeStatus,
    failOnStatusError: true,
  });
  handle = reconciledSession.handle;
  const meta = reconciledSession.meta;
  runtimeStatus = reconciledSession.runtimeStatus;
  const identity = resolveSessionIdentityFromMeta(meta);
  return {
    sessionKey: params.sessionKey,
    backend: handle.backend || meta.backend,
    agent: meta.agent,
    ...(identity ? { identity } : {}),
    state: meta.state,
    mode: meta.mode,
    runtimeOptions: resolveRuntimeOptionsFromMeta(meta),
    capabilities,
    runtimeStatus,
    lastActivityAt: meta.lastActivityAt,
    lastError: meta.lastError,
  };
}
