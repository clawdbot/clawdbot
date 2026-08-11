import { AsyncLocalStorage } from "node:async_hooks";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
  type CronCreatorAuthorityRunScope,
} from "../gateway/cron-creator-authority-grant.js";
import type {
  CronCreatorToolAuthorityMaterialization,
  CronToolOptions,
} from "./tools/cron-tool.types.js";

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
): CronCreatorAuthorityCapability | undefined {
  const normalizedRunId = runId.trim();
  return normalizedRunId ? createCronCreatorAuthorityRunScope(normalizedRunId) : undefined;
}

const activeCronCreatorAuthority = new AsyncLocalStorage<CronCreatorAuthorityRunScope>();
const activeCronCreatorAuthorityResolver =
  new AsyncLocalStorage<CronCreatorAuthorityResolverScope>();

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
  if (!normalizedRunId || authority?.active !== true || authority.runId !== normalizedRunId) {
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
