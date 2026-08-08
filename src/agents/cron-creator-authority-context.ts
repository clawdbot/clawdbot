import { AsyncLocalStorage } from "node:async_hooks";
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

type CronCreatorAuthorityResolverScope = {
  resolve: (options?: { signal?: AbortSignal }) => Promise<CronCreatorToolAuthorityMaterialization>;
  runId: string;
};

const activeCronCreatorAuthority = new AsyncLocalStorage<CronCreatorAuthorityRunScope>();
const activeCronCreatorAuthorityResolver =
  new AsyncLocalStorage<CronCreatorAuthorityResolverScope>();

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  return "then" in value && typeof value.then === "function";
}

/** Keeps fresh cron reauthorization within one admitted Gateway agent run. */
export function runWithCronCreatorAuthority<T>(
  runId: string,
  run: () => T,
  signal?: AbortSignal,
): T {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return run();
  }
  const scope = createCronCreatorAuthorityRunScope(normalizedRunId);
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

/** Carries a bundled-Codex resolver through synchronous core tool construction. */
export function runWithCronCreatorAuthorityResolver<T>(params: {
  runId: string;
  resolve: (options?: { signal?: AbortSignal }) => Promise<CronCreatorToolAuthorityMaterialization>;
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
  if (
    !normalizedRunId ||
    authority?.active !== true ||
    authority.runId !== normalizedRunId ||
    resolver?.runId !== normalizedRunId
  ) {
    return undefined;
  }
  return async (options) => {
    // Tool callbacks can run on async resources created outside the ALS scope,
    // so retain the exact scope object and revoke it when the run settles.
    const operationSignal = options?.signal;
    authority.signal.throwIfAborted();
    operationSignal?.throwIfAborted();
    const signal = operationSignal
      ? AbortSignal.any([authority.signal, operationSignal])
      : authority.signal;
    const snapshot = await resolver.resolve({ signal });
    authority.signal.throwIfAborted();
    operationSignal?.throwIfAborted();
    if (!authority.active) {
      authority.signal.throwIfAborted();
    }
    return Object.freeze({
      tools: snapshot.tools,
      provenance: snapshot.provenance,
      grant: mintCronCreatorAuthorityGrant(authority, operationSignal),
    });
  };
}
