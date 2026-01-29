import type { HeartbeatRunResult } from "../../infra/heartbeat-wake.js";
import type { CronJob, CronJobCreate, CronJobPatch, CronStoreFile } from "../types.js";

export type CronEvent = {
  jobId: string;
  action: "added" | "updated" | "removed" | "started" | "finished";
  runAtMs?: number;
  durationMs?: number;
  status?: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
  nextRunAtMs?: number;
};

export type Logger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

export type CronServiceDeps = {
  nowMs?: () => number;
  log: Logger;
  storePath: string;
  cronEnabled: boolean;
  /** Default timezone (IANA) for cron schedules that don't specify their own. */
  defaultTimezone?: string;
  enqueueSystemEvent: (text: string, opts?: { agentId?: string }) => void;
  requestHeartbeatNow: (opts?: { reason?: string }) => void;
  runHeartbeatOnce?: (opts?: { reason?: string }) => Promise<HeartbeatRunResult>;
  runIsolatedAgentJob: (params: { job: CronJob; message: string }) => Promise<{
    status: "ok" | "error" | "skipped";
    summary?: string;
    /** Last non-empty agent text output (not truncated). */
    outputText?: string;
    error?: string;
  }>;
  onEvent?: (evt: CronEvent) => void;
};

export type CronServiceDepsInternal = Omit<CronServiceDeps, "nowMs"> & {
  nowMs: () => number;
};

export type CronServiceState = {
  deps: CronServiceDepsInternal;
  store: CronStoreFile | null;
  timer: NodeJS.Timeout | null;
  running: boolean;
  op: Promise<unknown>;
  warnedDisabled: boolean;
};

export function createCronServiceState(deps: CronServiceDeps): CronServiceState {
  return {
    deps: { ...deps, nowMs: deps.nowMs ?? (() => Date.now()) },
    store: null,
    timer: null,
    running: false,
    op: Promise.resolve(),
    warnedDisabled: false,
  };
}

export type CronRunMode = "due" | "force";
export type CronWakeMode = "now" | "next-heartbeat";

export type CronStatusSummary = {
  enabled: boolean;
  storePath: string;
  jobs: number;
  nextWakeAtMs: number | null;
};

export type CronRunResult =
  | { ok: true; ran: true }
  | { ok: true; ran: false; reason: "not-due" }
  | { ok: false };

export type CronRemoveResult = { ok: true; removed: boolean } | { ok: false; removed: false };

export type CronAddResult = CronJob;
export type CronUpdateResult = CronJob;

export type CronListResult = CronJob[];
export type CronAddInput = CronJobCreate;
export type CronUpdateInput = CronJobPatch;
