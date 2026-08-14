import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

type CronOwnerRefusalDeps = Pick<
  typeof import("../infra/gateway-lock.js"),
  "readActiveGatewayLockIdentity"
> &
  Pick<typeof import("../commands/doctor/cron/legacy-repair.js"), "loadLegacyCronRepairState"> &
  Pick<
    typeof import("../cron/legacy-default-agent-owner-migration.js"),
    "materializeLegacyDefaultCronJobOwners"
  >;
const RETRY = ' Run "openclaw doctor --fix", then retry.';
const CRON_OWNER_REFUSAL = "cron-owner-safety";

function refused(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "CONFIG_WRITE_REJECTED",
    refusal: CRON_OWNER_REFUSAL,
  });
}

export function isCronOwnerWriteRefusalError(error: unknown): error is Error {
  return error instanceof Error && "refusal" in error && error.refusal === CRON_OWNER_REFUSAL;
}

function hasOwner(record: Record<string, unknown> | undefined): boolean {
  if (!record) {
    return false;
  }
  return Boolean(
    normalizeOptionalString(record.agentId) ||
    parseAgentSessionKey(normalizeOptionalString(record.sessionKey))?.agentId,
  );
}

async function loadDefaultDeps(): Promise<CronOwnerRefusalDeps> {
  const [
    { readActiveGatewayLockIdentity },
    { loadLegacyCronRepairState },
    { materializeLegacyDefaultCronJobOwners },
  ] = await Promise.all([
    import("../infra/gateway-lock.js"),
    import("../commands/doctor/cron/legacy-repair.js"),
    import("../cron/legacy-default-agent-owner-migration.js"),
  ]);
  return {
    readActiveGatewayLockIdentity,
    loadLegacyCronRepairState,
    materializeLegacyDefaultCronJobOwners,
  };
}

async function assertSafe(
  storePath: string,
  env: NodeJS.ProcessEnv,
  deps: CronOwnerRefusalDeps,
  provenOwnerAgentId?: string,
): Promise<void> {
  const active = await deps.readActiveGatewayLockIdentity({ env }).catch((error: unknown) => {
    throw refused(
      `Config write refused: cannot inspect the Gateway lock (${formatErrorMessage(error)}).${RETRY}`,
      error,
    );
  });
  if (active && active.pid !== process.pid) {
    throw refused(
      `Config write refused: live external Gateway pid ${active.pid} may write ownerless cron jobs. Stop it.${RETRY}`,
    );
  }
  const state = await deps
    .loadLegacyCronRepairState({ cfg: {}, storePath, env, readOnly: true })
    .catch((error: unknown) => {
      throw refused(
        `Config write refused: cannot inspect cron ownership at ${storePath} (${formatErrorMessage(error)}).${RETRY}`,
        error,
      );
    });
  const ownerless =
    state?.rawJobs.filter((job) => {
      const id = normalizeOptionalString(job.id) ?? normalizeOptionalString(job.jobId);
      return !hasOwner(job) && !hasOwner(id ? state.projectedOwnersByJobId.get(id) : undefined);
    }).length ?? 0;
  const unverifiable = state?.invalidConfigRows?.length ?? 0;
  if (unverifiable > 0) {
    throw refused(
      `Config write refused: cron store ${storePath} contains ${unverifiable} corrupt row(s) whose ownership cannot be verified.${RETRY}`,
    );
  }
  if (ownerless > 0 && provenOwnerAgentId) {
    try {
      deps.materializeLegacyDefaultCronJobOwners({
        storePath,
        legacyDefaultAgentId: provenOwnerAgentId,
        env,
      });
    } catch (error) {
      throw refused(
        `Config write refused: cannot assign ownerless cron jobs at ${storePath} to the retained legacy owner (${formatErrorMessage(error)}).${RETRY}`,
        error,
      );
    }
    return await assertSafe(storePath, env, deps);
  }
  if (ownerless > 0) {
    throw refused(
      `Config write refused: cron store ${storePath} contains ${ownerless} ownerless legacy cron job(s).${RETRY}`,
    );
  }
}

export async function prepareCronOwnerWriteRefusal(
  params: { storePath: string; provenOwnerAgentId?: string; env?: NodeJS.ProcessEnv },
  injectedDeps?: CronOwnerRefusalDeps,
): Promise<{ recheck: () => Promise<void> }> {
  const env = params.env ?? process.env;
  const deps = injectedDeps ?? (await loadDefaultDeps());
  const recheck = () => assertSafe(params.storePath, env, deps, params.provenOwnerAgentId);
  await recheck();
  return { recheck };
}
