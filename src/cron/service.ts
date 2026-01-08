import crypto from "node:crypto";

import { computeNextRunAtMs } from "./schedule.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronPayload,
  CronStoreFile,
} from "./types.js";

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

type Logger = {
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
  enqueueSystemEvent: (text: string) => void;
  requestHeartbeatNow: (opts?: { reason?: string }) => void;
  runIsolatedAgentJob: (params: { job: CronJob; message: string }) => Promise<{
    status: "ok" | "error" | "skipped";
    summary?: string;
    error?: string;
  }>;
  onEvent?: (evt: CronEvent) => void;
};

const STUCK_RUN_MS = 2 * 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function normalizeRequiredName(raw: unknown) {
  if (typeof raw !== "string") throw new Error("cron job name is required");
  const name = raw.trim();
  if (!name) throw new Error("cron job name is required");
  return name;
}

function normalizeOptionalText(raw: unknown) {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function truncateText(input: string, maxLen: number) {
  if (input.length <= maxLen) return input;
  return `${input.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function inferLegacyName(job: {
  schedule?: { kind?: unknown; everyMs?: unknown; expr?: unknown };
  payload?: { kind?: unknown; text?: unknown; message?: unknown };
}) {
  const text =
    job?.payload?.kind === "systemEvent" && typeof job.payload.text === "string"
      ? job.payload.text
      : job?.payload?.kind === "agentTurn" &&
          typeof job.payload.message === "string"
        ? job.payload.message
        : "";
  const firstLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  if (firstLine) return truncateText(firstLine, 60);

  const kind = typeof job?.schedule?.kind === "string" ? job.schedule.kind : "";
  if (kind === "cron" && typeof job?.schedule?.expr === "string")
    return `Cron: ${truncateText(job.schedule.expr, 52)}`;
  if (kind === "every" && typeof job?.schedule?.everyMs === "number")
    return `Every: ${job.schedule.everyMs}ms`;
  if (kind === "at") return "One-shot";
  return "Cron job";
}

function normalizePayloadToSystemText(payload: CronPayload) {
  if (payload.kind === "systemEvent") return payload.text.trim();
  return payload.message.trim();
}

export class CronService {
  private readonly deps: Required<Omit<CronServiceDeps, "onEvent">> &
    Pick<CronServiceDeps, "onEvent">;
  private store: CronStoreFile | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private op: Promise<unknown> = Promise.resolve();
  private warnedDisabled = false;

  constructor(deps: CronServiceDeps) {
    this.deps = {
      ...deps,
      nowMs: deps.nowMs ?? (() => Date.now()),
      onEvent: deps.onEvent,
    };
  }

  async start() {
    await this.locked(async () => {
      if (!this.deps.cronEnabled) {
        this.deps.log.info({ enabled: false }, "cron: disabled");
        return;
      }
      await this.ensureLoaded();
      this.recomputeNextRuns();
      await this.persist();
      this.armTimer();
      this.deps.log.info(
        {
          enabled: true,
          jobs: this.store?.jobs.length ?? 0,
          nextWakeAtMs: this.nextWakeAtMs() ?? null,
        },
        "cron: started",
      );
    });
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async status() {
    return await this.locked(async () => {
      await this.ensureLoaded();
      return {
        enabled: this.deps.cronEnabled,
        storePath: this.deps.storePath,
        jobs: this.store?.jobs.length ?? 0,
        nextWakeAtMs:
          this.deps.cronEnabled === true ? (this.nextWakeAtMs() ?? null) : null,
      };
    });
  }

  async list(opts?: { includeDisabled?: boolean }) {
    return await this.locked(async () => {
      await this.ensureLoaded();
      const includeDisabled = opts?.includeDisabled === true;
      const jobs = (this.store?.jobs ?? []).filter(
        (j) => includeDisabled || j.enabled,
      );
      return jobs.sort(
        (a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0),
      );
    });
  }

  async add(input: CronJobCreate) {
    return await this.locked(async () => {
      this.warnIfDisabled("add");
      await this.ensureLoaded();
      const now = this.deps.nowMs();
      const id = crypto.randomUUID();
      const job: CronJob = {
        id,
        name: normalizeRequiredName(input.name),
        description: normalizeOptionalText(input.description),
        enabled: input.enabled !== false,
        createdAtMs: now,
        updatedAtMs: now,
        schedule: input.schedule,
        sessionTarget: input.sessionTarget,
        wakeMode: input.wakeMode,
        payload: input.payload,
        isolation: input.isolation,
        state: {
          ...input.state,
        },
      };
      this.assertSupportedJobSpec(job);
      job.state.nextRunAtMs = this.computeJobNextRunAtMs(job, now);
      this.store?.jobs.push(job);
      await this.persist();
      this.armTimer();
      this.emit({
        jobId: id,
        action: "added",
        nextRunAtMs: job.state.nextRunAtMs,
      });
      return job;
    });
  }

  async update(id: string, patch: CronJobPatch) {
    return await this.locked(async () => {
      this.warnIfDisabled("update");
      await this.ensureLoaded();
      const job = this.findJobOrThrow(id);
      const now = this.deps.nowMs();

      if ("name" in patch) job.name = normalizeRequiredName(patch.name);
      if ("description" in patch)
        job.description = normalizeOptionalText(patch.description);
      if (typeof patch.enabled === "boolean") job.enabled = patch.enabled;
      if (patch.schedule) job.schedule = patch.schedule;
      if (patch.sessionTarget) job.sessionTarget = patch.sessionTarget;
      if (patch.wakeMode) job.wakeMode = patch.wakeMode;
      if (patch.payload) job.payload = patch.payload;
      if (patch.isolation) job.isolation = patch.isolation;
      if (patch.state) job.state = { ...job.state, ...patch.state };

      job.updatedAtMs = now;
      this.assertSupportedJobSpec(job);
      if (job.enabled) {
        job.state.nextRunAtMs = this.computeJobNextRunAtMs(job, now);
      } else {
        job.state.nextRunAtMs = undefined;
        job.state.runningAtMs = undefined;
      }
      await this.persist();
      this.armTimer();
      this.emit({
        jobId: id,
        action: "updated",
        nextRunAtMs: job.state.nextRunAtMs,
      });
      return job;
    });
  }

  async remove(id: string) {
    return await this.locked(async () => {
      this.warnIfDisabled("remove");
      await this.ensureLoaded();
      const before = this.store?.jobs.length ?? 0;
      if (!this.store) return { ok: false, removed: false };
      this.store.jobs = this.store.jobs.filter((j) => j.id !== id);
      const removed = (this.store.jobs.length ?? 0) !== before;
      await this.persist();
      this.armTimer();
      if (removed) this.emit({ jobId: id, action: "removed" });
      return { ok: true, removed };
    });
  }

  async run(id: string, mode?: "due" | "force") {
    return await this.locked(async () => {
      this.warnIfDisabled("run");
      await this.ensureLoaded();
      const job = this.findJobOrThrow(id);
      const now = this.deps.nowMs();
      const due =
        mode === "force" ||
        (job.enabled &&
          typeof job.state.nextRunAtMs === "number" &&
          now >= job.state.nextRunAtMs);
      if (!due) return { ok: true, ran: false, reason: "not-due" as const };
      await this.executeJob(job, now, { forced: mode === "force" });
      await this.persist();
      this.armTimer();
      return { ok: true, ran: true };
    });
  }

  wake(opts: { mode: "now" | "next-heartbeat"; text: string }) {
    const text = opts.text.trim();
    if (!text) return { ok: false };
    this.deps.enqueueSystemEvent(text);
    if (opts.mode === "now") {
      this.deps.requestHeartbeatNow({ reason: "wake" });
    }
    return { ok: true };
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.op.then(fn, fn);
    // Keep the chain alive even when the operation fails.
    this.op = next.then(
      () => undefined,
      () => undefined,
    );
    return (await next) as T;
  }

  private async ensureLoaded() {
    if (this.store) return;
    const loaded = await loadCronStore(this.deps.storePath);
    const jobs = (loaded.jobs ?? []) as unknown as Array<
      Record<string, unknown>
    >;
    let mutated = false;
    for (const raw of jobs) {
      const nameRaw = raw.name;
      if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
        raw.name = inferLegacyName({
          schedule: raw.schedule as never,
          payload: raw.payload as never,
        });
        mutated = true;
      } else {
        raw.name = nameRaw.trim();
      }

      const desc = normalizeOptionalText(raw.description);
      if (raw.description !== desc) {
        raw.description = desc;
        mutated = true;
      }
    }
    this.store = { version: 1, jobs: jobs as unknown as CronJob[] };
    if (mutated) await this.persist();
  }

  private warnIfDisabled(action: string) {
    if (this.deps.cronEnabled) return;
    if (this.warnedDisabled) return;
    this.warnedDisabled = true;
    this.deps.log.warn(
      { enabled: false, action, storePath: this.deps.storePath },
      "cron: scheduler disabled; jobs will not run automatically",
    );
  }

  private async persist() {
    if (!this.store) return;
    await saveCronStore(this.deps.storePath, this.store);
  }

  private findJobOrThrow(id: string) {
    const job = this.store?.jobs.find((j) => j.id === id);
    if (!job) throw new Error(`unknown cron job id: ${id}`);
    return job;
  }

  private computeJobNextRunAtMs(job: CronJob, nowMs: number) {
    if (!job.enabled) return undefined;
    if (job.schedule.kind === "at") {
      // One-shot jobs stay due until they successfully finish.
      if (job.state.lastStatus === "ok" && job.state.lastRunAtMs)
        return undefined;
      return job.schedule.atMs;
    }
    return computeNextRunAtMs(job.schedule, nowMs);
  }

  private recomputeNextRuns() {
    if (!this.store) return;
    const now = this.deps.nowMs();
    for (const job of this.store.jobs) {
      if (!job.state) job.state = {};
      if (!job.enabled) {
        job.state.nextRunAtMs = undefined;
        job.state.runningAtMs = undefined;
        continue;
      }
      const runningAt = job.state.runningAtMs;
      if (typeof runningAt === "number" && now - runningAt > STUCK_RUN_MS) {
        this.deps.log.warn(
          { jobId: job.id, runningAtMs: runningAt },
          "cron: clearing stuck running marker",
        );
        job.state.runningAtMs = undefined;
      }
      job.state.nextRunAtMs = this.computeJobNextRunAtMs(job, now);
    }
  }

  private nextWakeAtMs() {
    const jobs = this.store?.jobs ?? [];
    const enabled = jobs.filter(
      (j) => j.enabled && typeof j.state.nextRunAtMs === "number",
    );
    if (enabled.length === 0) return undefined;
    return enabled.reduce(
      (min, j) => Math.min(min, j.state.nextRunAtMs as number),
      enabled[0].state.nextRunAtMs as number,
    );
  }

  private armTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.deps.cronEnabled) return;
    const nextAt = this.nextWakeAtMs();
    if (!nextAt) return;
    const delay = Math.max(nextAt - this.deps.nowMs(), 0);
    // Avoid TimeoutOverflowWarning when a job is far in the future.
    const clampedDelay = Math.min(delay, MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => {
      void this.onTimer().catch((err) => {
        this.deps.log.error({ err: String(err) }, "cron: timer tick failed");
      });
    }, clampedDelay);
    this.timer.unref?.();
  }

  private async onTimer() {
    if (this.running) return;
    this.running = true;
    try {
      await this.locked(async () => {
        await this.ensureLoaded();
        await this.runDueJobs();
        await this.persist();
        this.armTimer();
      });
    } finally {
      this.running = false;
    }
  }

  private async runDueJobs() {
    if (!this.store) return;
    const now = this.deps.nowMs();
    const due = this.store.jobs.filter((j) => {
      if (!j.enabled) return false;
      if (typeof j.state.runningAtMs === "number") return false;
      const next = j.state.nextRunAtMs;
      return typeof next === "number" && now >= next;
    });
    for (const job of due) {
      await this.executeJob(job, now, { forced: false });
    }
  }

  private async executeJob(
    job: CronJob,
    nowMs: number,
    opts: { forced: boolean },
  ) {
    const startedAt = this.deps.nowMs();
    job.state.runningAtMs = startedAt;
    job.state.lastError = undefined;
    this.emit({ jobId: job.id, action: "started", runAtMs: startedAt });

    const finish = async (
      status: "ok" | "error" | "skipped",
      err?: string,
      summary?: string,
    ) => {
      const endedAt = this.deps.nowMs();
      job.state.runningAtMs = undefined;
      job.state.lastRunAtMs = startedAt;
      job.state.lastStatus = status;
      job.state.lastDurationMs = Math.max(0, endedAt - startedAt);
      job.state.lastError = err;

      if (job.schedule.kind === "at" && status === "ok") {
        // One-shot job completed successfully; disable it.
        job.enabled = false;
        job.state.nextRunAtMs = undefined;
      } else if (job.enabled) {
        job.state.nextRunAtMs = this.computeJobNextRunAtMs(job, endedAt);
      } else {
        job.state.nextRunAtMs = undefined;
      }

      this.emit({
        jobId: job.id,
        action: "finished",
        status,
        error: err,
        summary,
        runAtMs: startedAt,
        durationMs: job.state.lastDurationMs,
        nextRunAtMs: job.state.nextRunAtMs,
      });

      if (job.sessionTarget === "isolated") {
        const prefix = job.isolation?.postToMainPrefix?.trim() || "Cron";
        const body = (summary ?? err ?? status).trim();
        const statusPrefix = status === "ok" ? prefix : `${prefix} (${status})`;
        this.deps.enqueueSystemEvent(`${statusPrefix}: ${body}`);
        if (job.wakeMode === "now") {
          this.deps.requestHeartbeatNow({ reason: `cron:${job.id}:post` });
        }
      }
    };

    try {
      if (job.sessionTarget === "main") {
        if (job.payload.kind !== "systemEvent") {
          await finish(
            "skipped",
            'main job requires payload.kind="systemEvent"',
          );
          return;
        }
        const text = normalizePayloadToSystemText(job.payload);
        if (!text) {
          await finish(
            "skipped",
            "main job requires non-empty systemEvent text",
          );
          return;
        }
        this.deps.enqueueSystemEvent(text);
        if (job.wakeMode === "now") {
          this.deps.requestHeartbeatNow({ reason: `cron:${job.id}` });
        }
        await finish("ok", undefined, text);
        return;
      }

      if (job.payload.kind !== "agentTurn") {
        await finish("skipped", "isolated job requires payload.kind=agentTurn");
        return;
      }

      const res = await this.deps.runIsolatedAgentJob({
        job,
        message: job.payload.message,
      });
      if (res.status === "ok") await finish("ok", undefined, res.summary);
      else if (res.status === "skipped")
        await finish("skipped", undefined, res.summary);
      else await finish("error", res.error ?? "cron job failed", res.summary);
    } catch (err) {
      await finish("error", String(err));
    } finally {
      job.updatedAtMs = nowMs;
      if (!opts.forced && job.enabled) {
        // Keep nextRunAtMs in sync in case the schedule advanced during a long run.
        job.state.nextRunAtMs = this.computeJobNextRunAtMs(
          job,
          this.deps.nowMs(),
        );
      }
    }
  }

  private emit(evt: CronEvent) {
    try {
      this.deps.onEvent?.(evt);
    } catch {
      /* ignore */
    }
  }

  private assertSupportedJobSpec(
    job: Pick<CronJob, "sessionTarget" | "payload">,
  ) {
    if (job.sessionTarget === "main" && job.payload.kind !== "systemEvent") {
      throw new Error('main cron jobs require payload.kind="systemEvent"');
    }
    if (job.sessionTarget === "isolated" && job.payload.kind !== "agentTurn") {
      throw new Error('isolated cron jobs require payload.kind="agentTurn"');
    }
  }
}
