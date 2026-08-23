/** Process-local index of session keys that enabled cron jobs are bound to. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobBoundSessionKeys } from "../cron/job-session-bindings.js";
import type { CronJob } from "../cron/types.js";

type SessionAutomationSource = {
  /** Current in-memory cron jobs; undefined until the cron store is loaded. */
  getJobs: () => readonly CronJob[] | undefined;
  getDefaultAgentId: () => string | undefined;
};

let source: SessionAutomationSource | null = null;
// Bumped on every cron service event so in-place job mutations (enable/disable,
// auto-disable during runs) invalidate the memo even when the array identity
// and config reference stay stable.
let sourceVersion = 0;
let epochCounter = 0;
let registeredEpoch = 0;

let memo: {
  jobs: readonly CronJob[];
  version: number;
  cfg: OpenClawConfig;
  keys: ReadonlySet<string>;
} | null = null;

/**
 * Claimed at cron service build time so registration authority follows build
 * order: a stale service whose start resolves after a config reload cannot
 * clobber the replacement's registration.
 */
export function claimSessionAutomationEpoch(): number {
  return ++epochCounter;
}

/** Registered by the gateway cron owner; newer epochs win over stale services. */
export function registerSessionAutomationSource(
  next: SessionAutomationSource | null,
  epoch?: number,
): void {
  const effectiveEpoch = epoch ?? claimSessionAutomationEpoch();
  if (effectiveEpoch < registeredEpoch) {
    return;
  }
  registeredEpoch = effectiveEpoch;
  source = next;
  memo = null;
  sourceVersion += 1;
}

/**
 * Owner-compare unregistration: a stopped cron service must not clear a
 * replacement's registration when config reloads race the lazy service build.
 */
export function unregisterSessionAutomationSource(owner: SessionAutomationSource): void {
  if (source !== owner) {
    return;
  }
  source = null;
  memo = null;
  sourceVersion += 1;
}

/** Called from the cron onEvent hook after any job/store change. */
export function bumpSessionAutomationVersion(): void {
  sourceVersion += 1;
}

function buildAutomationKeys(
  jobs: readonly CronJob[],
  cfg: OpenClawConfig,
  defaultAgentId: string | undefined,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const job of jobs) {
    if (!job.enabled) {
      continue;
    }
    for (const key of resolveCronJobBoundSessionKeys(job, { cfg, defaultAgentId })) {
      keys.add(key);
    }
  }
  return keys;
}

/** True when an enabled cron job is bound to the canonical session key. */
export function sessionHasAutomation(sessionKey: string, cfg: OpenClawConfig): boolean {
  const jobs = source?.getJobs();
  if (!source || !jobs || jobs.length === 0) {
    return false;
  }
  if (!memo || memo.jobs !== jobs || memo.version !== sourceVersion || memo.cfg !== cfg) {
    memo = {
      jobs,
      version: sourceVersion,
      cfg,
      keys: buildAutomationKeys(jobs, cfg, source.getDefaultAgentId()),
    };
  }
  return memo.keys.has(sessionKey);
}
