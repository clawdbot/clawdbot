import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { OpenClawConfig } from "./types.js";

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
  cfg: OpenClawConfig,
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
  const state = await deps
    .loadLegacyCronRepairState({ cfg, storePath, env, readOnly: true })
    .catch((error: unknown) => {
      throw refused(
        `Config write refused: cannot inspect cron ownership at ${storePath} (${formatErrorMessage(error)}).${RETRY}`,
        error,
      );
    });
  const unresolved =
    state?.rawJobs.filter((job) => {
      const id = normalizeOptionalString(job.id) ?? normalizeOptionalString(job.jobId);
      const projection = id ? state.projectedOwnersByJobId.get(id) : undefined;
      return !hasOwner(job) && (!projection || projection.kind === "unresolved");
    }).length ?? 0;
  const projectedDynamicDefaults =
    state?.rawJobs.filter((job) => {
      const id = normalizeOptionalString(job.id) ?? normalizeOptionalString(job.jobId);
      const projection = id ? state.projectedOwnersByJobId.get(id) : undefined;
      return !hasOwner(job) && projection?.kind === "runtime-default";
    }).length ?? 0;
  const unverifiable = state?.invalidConfigRows?.length ?? 0;
  if (unverifiable > 0) {
    throw refused(
      `Config write refused: cron store ${storePath} contains ${unverifiable} corrupt row(s) whose ownership cannot be verified.${RETRY}`,
    );
  }
  if (unresolved > 0 && !provenOwnerAgentId) {
    throw refused(
      `Config write refused: cron store ${storePath} contains ${unresolved} ownerless legacy cron job(s).${RETRY}`,
    );
  }
  if (active && active.pid !== process.pid && active.cronOwnerProjection !== "dynamic-default-v1") {
    throw refused(
      `Config write refused: live external Gateway pid ${active.pid} does not prove compatibility with the current cron ownership projection. Restart it with this OpenClaw version, or stop it, then retry.`,
    );
  }
  if ((unresolved > 0 || projectedDynamicDefaults > 0) && provenOwnerAgentId) {
    try {
      await deps.materializeLegacyDefaultCronJobOwners({
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
    return await assertSafe(cfg, storePath, env, deps);
  }
}

export async function prepareCronOwnerWriteRefusal(
  cfg: OpenClawConfig,
  params: {
    storePath: string;
    provenOwnerAgentId?: string;
    env?: NodeJS.ProcessEnv;
  },
  injectedDeps?: CronOwnerRefusalDeps,
): Promise<{ recheck: () => Promise<void> }> {
  const env = params.env ?? process.env;
  const deps = injectedDeps ?? (await loadDefaultDeps());
  const recheck = () => assertSafe(cfg, params.storePath, env, deps, params.provenOwnerAgentId);
  await recheck();
  return { recheck };
}
