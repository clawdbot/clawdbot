import { AsyncLocalStorage } from "node:async_hooks";
import type { CronCreatorToolAuthoritySnapshot, CronToolOptions } from "./tools/cron-tool.types.js";

type CronCreatorAuthorityResolver = NonNullable<CronToolOptions["resolveCreatorToolAuthority"]>;

type CronCreatorAuthorityScope = {
  active: boolean;
  runId: string;
};

type CronCreatorAuthorityResolverScope = {
  resolve: CronCreatorAuthorityResolver;
  runId: string;
};

const activeCronCreatorAuthority = new AsyncLocalStorage<CronCreatorAuthorityScope>();
const activeCronCreatorAuthorityResolver =
  new AsyncLocalStorage<CronCreatorAuthorityResolverScope>();

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  return "then" in value && typeof value.then === "function";
}

class CronCreatorAuthorityExpiredError extends Error {
  readonly status = 403;

  constructor() {
    super(
      "Configured MCP cron authority is no longer active for this run. Retry the automation mutation from the active local operator turn.",
    );
    this.name = "CronCreatorAuthorityExpiredError";
  }
}

/** Keeps fresh cron reauthorization within one admitted Gateway agent run. */
export function runWithCronCreatorAuthority<T>(runId: string, run: () => T): T {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) {
    return run();
  }
  const scope: CronCreatorAuthorityScope = { active: true, runId: normalizedRunId };
  try {
    const result = activeCronCreatorAuthority.run(scope, run);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(() => {
        scope.active = false;
      }) as T;
    }
    scope.active = false;
    return result;
  } catch (error) {
    scope.active = false;
    throw error;
  }
}

/** Carries a bundled-Codex resolver through synchronous core tool construction. */
export function runWithCronCreatorAuthorityResolver<T>(params: {
  runId: string;
  resolve: () => Promise<CronCreatorToolAuthoritySnapshot>;
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
  return async () => {
    // Tool callbacks can run on async resources created outside the ALS scope,
    // so retain the exact scope object and revoke it when the run settles.
    if (!authority.active) {
      throw new CronCreatorAuthorityExpiredError();
    }
    return await resolver.resolve();
  };
}
