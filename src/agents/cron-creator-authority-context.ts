import { AsyncLocalStorage } from "node:async_hooks";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CronScheduledToolCallerOrigin } from "../cron/scheduled-tool-policy.js";
import {
  CRON_MANAGEMENT_METHODS,
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
  type CronCreatorAuthorityRunScope,
} from "../gateway/cron-creator-authority-grant.js";
import { validateAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import type {
  CronCreatorToolAuthorityMaterialization,
  CronToolOptions,
} from "./tools/cron-tool.types.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

type CronCreatorAuthorityResolver = NonNullable<CronToolOptions["resolveCreatorToolAuthority"]>;
type CronCreatorAuthorityMaterializer = (options?: {
  signal?: AbortSignal;
}) => Promise<CronCreatorToolAuthorityMaterialization>;

type CronCreatorAuthorityResolverScope = {
  resolve: CronCreatorAuthorityMaterializer;
  runId: string;
};

/** Opaque in-process capability minted only by an admitted exact run. */
export type CronCreatorAuthorityCapability = CronCreatorAuthorityRunScope;

export function createCronCreatorAuthorityCapability(
  runId: string,
  callerOrigin: CronScheduledToolCallerOrigin = { kind: "unknown" },
  controlUiAdmin?: true,
): CronCreatorAuthorityCapability | undefined {
  const normalizedRunId = runId.trim();
  return normalizedRunId
    ? createCronCreatorAuthorityRunScope(normalizedRunId, callerOrigin, controlUiAdmin)
    : undefined;
}

const activeCronCreatorAuthority = new AsyncLocalStorage<CronCreatorAuthorityRunScope>();
const activeCronCreatorAuthorityResolver =
  new AsyncLocalStorage<CronCreatorAuthorityResolverScope>();

/** Bind at tool construction, never rediscover authority from model arguments or routes. */
export function bindCronManagementGrant(runId: string | undefined) {
  const scope = activeCronCreatorAuthority.getStore();
  const authority = getGatewayToolCallerIdentity()?.approvalAuthority;
  if (
    !scope?.controlUiAdmin ||
    !scope.active ||
    scope.signal.aborted ||
    scope.runId !== runId ||
    !authority ||
    authority.operationalRunInstance.runId !== runId ||
    !validateAgentRunDelegatedAuthority(authority)
  ) {
    return undefined;
  }
  const managementOnly = scope.callerOrigin.kind === "unknown";
  return {
    managementOnly,
    mint: (method: string, signal?: AbortSignal) => {
      if (!CRON_MANAGEMENT_METHODS.some((allowed) => allowed === method)) {
        if (managementOnly) {
          throw new Error(
            "This Control UI turn can only list, get, update, run, or remove automations. Use the Automations page for other actions.",
          );
        }
        return undefined;
      }
      return mintCronCreatorAuthorityGrant(scope, signal, undefined, { method, authority });
    },
  };
}

export function shouldAdmitFreshChannelOwnerCronAuthority(params: {
  senderIsOwner: boolean;
  messageProvider?: string;
  senderId?: string;
  isHeartbeat: boolean;
  isRoomEvent: boolean;
  inputProvenance?: unknown;
  spawnedBy?: string;
  suppressNextUserMessagePersistence?: boolean;
}): boolean {
  return (
    params.senderIsOwner &&
    Boolean(params.messageProvider) &&
    Boolean(normalizeOptionalString(params.senderId)) &&
    !params.isHeartbeat &&
    !params.isRoomEvent &&
    params.inputProvenance === undefined &&
    params.spawnedBy === undefined &&
    params.suppressNextUserMessagePersistence !== true
  );
}
/** Owns one explicitly transported creator-authority capability until run settlement. */
export function runWithCronCreatorAuthorityCapability<T>(
  scope: CronCreatorAuthorityCapability,
  run: () => T,
  signal?: AbortSignal,
): T {
  const revoke = () => revokeCronCreatorAuthorityRunScope(scope);
  signal?.addEventListener("abort", revoke, { once: true });
  if (signal?.aborted) {
    revoke();
  }
  try {
    const result = activeCronCreatorAuthority.run(scope, run);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(() => {
        signal?.removeEventListener("abort", revoke);
        revoke();
      }) as T;
    }
    signal?.removeEventListener("abort", revoke);
    revoke();
    return result;
  } catch (error) {
    signal?.removeEventListener("abort", revoke);
    revoke();
    throw error;
  }
}

/** Combines an admitted capability with a late exact-thread tool-surface resolver. */
function bindCronCreatorAuthorityResolver(params: {
  capability: CronCreatorAuthorityCapability | undefined;
  runId: string | undefined;
  resolve: CronCreatorAuthorityMaterializer;
}): CronCreatorAuthorityResolver | undefined {
  const normalizedRunId = params.runId?.trim();
  const authority = params.capability;
  if (
    !normalizedRunId ||
    authority?.active !== true ||
    authority.runId !== normalizedRunId ||
    (authority.controlUiAdmin && authority.callerOrigin.kind === "unknown")
  ) {
    return undefined;
  }
  return async (options) => {
    // Tool callbacks can run after construction; retain the exact scope object
    // and let its owner revoke it when the admitted run settles.
    const operationSignal = options?.signal;
    authority.signal.throwIfAborted();
    operationSignal?.throwIfAborted();
    const signal = operationSignal
      ? AbortSignal.any([authority.signal, operationSignal])
      : authority.signal;
    const snapshot = await params.resolve({ signal });
    authority.signal.throwIfAborted();
    operationSignal?.throwIfAborted();
    if (!authority.active) {
      authority.signal.throwIfAborted();
    }
    return Object.freeze({
      tools: snapshot.tools,
      provenance: snapshot.provenance,
      grant: mintCronCreatorAuthorityGrant(authority, operationSignal, snapshot.runtimeAuthority),
    });
  };
}

/** Installs an explicitly transported capability only for synchronous tool construction. */
export function runWithCronCreatorAuthorityCapabilityResolver<T>(params: {
  capability: CronCreatorAuthorityCapability | undefined;
  runId: string | undefined;
  resolve: CronCreatorAuthorityMaterializer;
  run: () => T;
}): T {
  const normalizedRunId = params.runId?.trim();
  const authority = params.capability;
  if (!normalizedRunId || authority?.active !== true || authority.runId !== normalizedRunId) {
    return params.run();
  }
  return activeCronCreatorAuthority.run(authority, () =>
    activeCronCreatorAuthorityResolver.run(
      { runId: normalizedRunId, resolve: params.resolve },
      params.run,
    ),
  );
}

/** Carries a bundled-Codex resolver through synchronous core tool construction. */
export function runWithCronCreatorAuthorityResolver<T>(params: {
  runId: string;
  resolve: CronCreatorAuthorityMaterializer;
  run: () => T;
}): T {
  return activeCronCreatorAuthorityResolver.run(
    { runId: params.runId.trim(), resolve: params.resolve },
    params.run,
  );
}

/** Binds the resolver to the exact active run and revokes retained callbacks at settlement. */
export function bindActiveCronCreatorAuthorityResolver(
  runId: string | undefined,
): CronCreatorAuthorityResolver | undefined {
  const authority = activeCronCreatorAuthority.getStore();
  const resolver = activeCronCreatorAuthorityResolver.getStore();
  const normalizedRunId = runId?.trim();
  if (!normalizedRunId || resolver?.runId !== normalizedRunId) {
    return undefined;
  }
  return bindCronCreatorAuthorityResolver({
    capability: authority,
    runId: normalizedRunId,
    resolve: resolver.resolve,
  });
}

/** Retains the exact admitted owner turn only while its run scope remains live. */
export function bindActiveOperatorTurnAuthority(runId: string | undefined):
  | {
      source: "channel-owner" | "local";
      assertActive: () => void;
    }
  | undefined {
  const authority = activeCronCreatorAuthority.getStore();
  const normalizedRunId = runId?.trim();
  if (
    !normalizedRunId ||
    authority?.active !== true ||
    authority.runId !== normalizedRunId ||
    authority.callerOrigin.kind === "unknown"
  ) {
    return undefined;
  }
  return {
    source: authority.callerOrigin.kind === "local" ? "local" : "channel-owner",
    assertActive: () => {
      authority.signal.throwIfAborted();
      if (!authority.active || authority.runId !== normalizedRunId) {
        authority.signal.throwIfAborted();
        throw new Error("operator turn authority is no longer active");
      }
    },
  };
}
