import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../routing/session-key.js";

type CronOwnerRefusalDeps = Pick<
  typeof import("../infra/gateway-lock.js"),
  "readActiveGatewayLockIdentity"
> &
  Pick<typeof import("../commands/doctor/cron/legacy-repair.js"), "loadLegacyCronRepairState">;
const RETRY = ' Run "openclaw doctor --fix", then retry.';

function refused(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "CONFIG_WRITE_REJECTED",
  });
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
  const [{ readActiveGatewayLockIdentity }, { loadLegacyCronRepairState }] = await Promise.all([
    import("../infra/gateway-lock.js"),
    import("../commands/doctor/cron/legacy-repair.js"),
  ]);
  return { readActiveGatewayLockIdentity, loadLegacyCronRepairState };
}

async function assertSafe(
  storePath: string,
  env: NodeJS.ProcessEnv,
  deps: CronOwnerRefusalDeps,
): Promise<void> {
  const active = await deps.readActiveGatewayLockIdentity({ env }).catch((error: unknown) => {
    throw refused(`Config write refused: cannot inspect the Gateway lock.${RETRY}`, error);
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
        `Config write refused: cannot inspect cron ownership at ${storePath}.${RETRY}`,
        error,
      );
    });
  const ownerless =
    state?.rawJobs.filter((job) => {
      const id = normalizeOptionalString(job.id) ?? normalizeOptionalString(job.jobId);
      return !hasOwner(job) && !hasOwner(id ? state.projectedOwnersByJobId.get(id) : undefined);
    }).length ?? 0;
  if (ownerless > 0) {
    throw refused(
      `Config write refused: cron store ${storePath} contains ${ownerless} ownerless legacy cron job(s).${RETRY}`,
    );
  }
}

export async function prepareCronOwnerWriteRefusal(
  params: { storePath: string; env?: NodeJS.ProcessEnv },
  injectedDeps?: CronOwnerRefusalDeps,
): Promise<{ recheck: () => Promise<void> }> {
  const env = params.env ?? process.env;
  const deps = injectedDeps ?? (await loadDefaultDeps());
  const recheck = () => assertSafe(params.storePath, env, deps);
  await recheck();
  return { recheck };
}
