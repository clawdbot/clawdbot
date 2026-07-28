/** Maps cron jobs to the canonical session-store keys they are bound to. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import type { CronServiceContract } from "./service-contract.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";
import type { CronJob } from "./types.js";

type CronJobSessionBinding = Pick<CronJob, "id" | "agentId" | "sessionKey" | "sessionTarget">;

/**
 * Resolves every canonical session key a job is bound to: the session the run
 * joins (main/isolated/session:<key>) plus the explicit wake/delivery lane in
 * job.sessionKey. Keys use the same canonicalization as cron run/session
 * creation, so they compare equal to gateway session-store row keys.
 */
export function resolveCronJobBoundSessionKeys(
  job: CronJobSessionBinding,
  opts: { cfg: OpenClawConfig; defaultAgentId?: string },
): Set<string> {
  const agentId = normalizeAgentId(job.agentId ?? opts.defaultAgentId);
  const keys = new Set<string>();
  const add = (sessionKey: string | undefined) => {
    const trimmed = sessionKey?.trim();
    if (!trimmed) {
      return;
    }
    keys.add(
      resolveCronAgentSessionKey({
        sessionKey: trimmed,
        agentId,
        mainKey: opts.cfg.session?.mainKey,
        cfg: opts.cfg,
      }),
    );
  };
  try {
    if (job.sessionTarget === "main") {
      add("main");
    } else if (job.sessionTarget === "isolated" || job.sessionTarget === "current") {
      // Gateway execution runs isolated jobs — and stale persisted "current"
      // targets, which patches can store un-resolved — in the deterministic
      // cron:<jobId> session (server-cron.ts falls back to it for non-session
      // targets); job.sessionKey is only a delivery/wake lane, added below.
      add(`cron:${job.id}`);
    } else {
      add(resolveCronSessionTargetSessionKey(job.sessionTarget));
    }
    add(job.sessionKey);
  } catch {
    // Malformed persisted targets are quarantined by the store loader; a job
    // that slips through must not break session listing, so bind nothing.
    keys.clear();
  }
  return keys;
}

/** Signals a locked re-check found the job no longer bound; a per-job no-op. */
class CronJobBindingStaleError extends Error {
  constructor() {
    super("cron job binding changed concurrently");
  }
}

/**
 * Disables every enabled cron job bound to a session, used when the session is
 * archived so schedules stop targeting a lane that rejects new work.
 * Returns the disabled job ids.
 */
export async function disableCronJobsBoundToSession(params: {
  cron: Pick<CronServiceContract, "list" | "updateWithPrecondition" | "getDefaultAgentId">;
  cfg: OpenClawConfig;
  sessionKey: string;
}): Promise<string[]> {
  const jobs = await params.cron.list();
  const defaultAgentId = params.cron.getDefaultAgentId();
  const boundToSession = (job: CronJobSessionBinding & Pick<CronJob, "enabled">) =>
    job.enabled &&
    resolveCronJobBoundSessionKeys(job, { cfg: params.cfg, defaultAgentId }).has(params.sessionKey);
  const disabled: string[] = [];
  const failures: unknown[] = [];
  for (const job of jobs) {
    if (!boundToSession(job)) {
      continue;
    }
    try {
      // Re-check the binding under the store lock: a job retargeted after the
      // list snapshot must not be disabled, and one failing/removed job must
      // not abort the remaining bound jobs.
      await params.cron.updateWithPrecondition(job.id, { enabled: false }, (currentJob) => {
        if (!boundToSession(currentJob)) {
          throw new CronJobBindingStaleError();
        }
      });
      disabled.push(job.id);
    } catch (error) {
      if (error instanceof CronJobBindingStaleError) {
        continue;
      }
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `failed to disable ${failures.length} cron job(s) bound to ${params.sessionKey}`,
    );
  }
  return disabled;
}
