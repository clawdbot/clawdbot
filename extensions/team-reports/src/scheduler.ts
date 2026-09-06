import { randomUUID } from "node:crypto";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { TeamReportsConfig } from "./config.js";
import { describePeriod } from "./periods.js";
import {
  createReportSources,
  generateReportPeriods,
  runPeriods,
  type ReportSourceFactory,
  type ResolvedTeamReportsConfig,
} from "./run.js";
import type { TeamReportsStore } from "./store.js";
import type { Person, PeriodDescriptor, SourceStatus } from "./types.js";

const DAY_MS = 86_400_000;
const RUN_DEADLINE_MS = 45 * 60_000;
const STOP_TIMEOUT_MS = 30_000;
type RunKind = "closed-day" | "intraday" | "manual";
type ActiveRun = { id: string; controller: AbortController; done: Promise<void> };

function nextClosedDayDue(
  nowMs: number,
  schedule: TeamReportsConfig["schedule"],
  random = Math.random(),
): number {
  const [hours = 0, minutes = 0] = schedule.closedDayUtc.split(":").map(Number);
  const today = describePeriod("day", nowMs).sinceMs;
  const jitter = Math.floor(Math.max(0, Math.min(1, random)) * schedule.jitterMinutes * 60_000);
  const scheduled = today + hours * 3_600_000 + minutes * 60_000 + jitter;
  return scheduled > nowMs ? scheduled : scheduled + DAY_MS;
}

function nextIntradayDue(nowMs: number, everyHours: number): number | undefined {
  if (everyHours === 0) {
    return undefined;
  }
  const today = describePeriod("day", nowMs).sinceMs;
  const interval = everyHours * 3_600_000;
  return today + Math.min(DAY_MS, (Math.floor((nowMs - today) / interval) + 1) * interval);
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class TeamReportsScheduler {
  private accepting = false;
  private closed = false;
  private active?: ActiveRun;
  private stopPromise?: Promise<void>;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private due: { closedDay?: number; intraday?: number; catchUp?: number } = {};
  private deferred = new Set<"closed-day" | "intraday">();
  private roster: Person[];

  constructor(
    private readonly options: {
      config: TeamReportsConfig;
      resolved: ResolvedTeamReportsConfig;
      store: TeamReportsStore;
      llm: OpenClawPluginApi["runtime"]["llm"];
      context: Pick<OpenClawPluginServiceContext, "logger" | "serviceHealth">;
      sources?: ReportSourceFactory;
    },
  ) {
    this.roster = options.resolved.people;
  }

  start(): void {
    if (this.closed || this.accepting) {
      throw new Error("Team Reports scheduler cannot be started again");
    }
    this.accepting = true;
    this.armClosedDay();
    this.armIntraday();
    const yesterday = describePeriod("day", Date.now() - DAY_MS);
    const completed = this.closedDayCompleted(yesterday.key);
    if (!completed) {
      this.due.catchUp = Date.now() + 60_000;
      this.schedule(this.due.catchUp, () => {
        delete this.due.catchUp;
        this.tick("closed-day", true);
      });
    }
  }

  people(): Person[] {
    return this.roster;
  }

  status() {
    return {
      running: this.accepting,
      activeRunId: this.active?.id,
      nextDue: { ...this.due },
      runs: this.options.store.listRuns(),
      periods: this.options.store.listPeriods(),
      sourceWarnings: this.options.store
        .listPeriods({ period: "day", limit: 1 })
        .flatMap((entry) => {
          const report = this.options.store.getPeriod("day", entry.key)?.report;
          return report
            ? report.sources.github.warnings.concat(report.sources.discord?.warnings ?? [])
            : [];
        }),
    };
  }

  generate(params: { date?: string; intraday?: boolean } = {}): string {
    const now = Date.now();
    const day = describePeriod("day", params.date ?? now - (params.intraday ? 0 : DAY_MS));
    const today = describePeriod("day", now);
    if (day.sinceMs > today.sinceMs) {
      throw new Error("Cannot generate a future UTC day");
    }
    if (params.intraday && day.key !== today.key) {
      throw new Error("intraday generation requires today's UTC date");
    }
    return this.begin("manual", [day]);
  }

  stop(): Promise<void> {
    return (this.stopPromise ??= this.stopOnce());
  }

  private async stopOnce(): Promise<void> {
    this.accepting = false;
    this.due = {};
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.deferred.clear();
    const active = this.active;
    try {
      if (active) {
        const timeout = setTimeout(
          () => active.controller.abort(new Error("Team Reports stopped after 30 seconds")),
          STOP_TIMEOUT_MS,
        );
        try {
          await active.done;
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      this.closed = true;
      this.options.store.close();
    }
  }

  private schedule(atMs: number, callback: () => void): void {
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        if (this.accepting) {
          callback();
        }
      },
      Math.max(0, atMs - Date.now()),
    );
    timer.unref?.();
    this.timers.add(timer);
  }

  private armClosedDay(afterMs = Date.now()): void {
    const due = nextClosedDayDue(afterMs, this.options.config.schedule);
    this.due.closedDay = due;
    this.schedule(due, () => {
      this.tick("closed-day");
      this.armClosedDay(describePeriod("day", due).untilMs - 1);
    });
  }

  private armIntraday(): void {
    this.due.intraday = nextIntradayDue(
      Date.now(),
      this.options.config.schedule.intradayEveryHours,
    );
    if (this.due.intraday !== undefined) {
      this.schedule(this.due.intraday, () => {
        this.tick("intraday");
        this.armIntraday();
      });
    }
  }

  private tick(kind: "closed-day" | "intraday", catchUp = false): void {
    if (catchUp && this.closedDayCompleted(describePeriod("day", Date.now() - DAY_MS).key)) {
      return;
    }
    if (this.active) {
      if (!this.deferred.has(kind)) {
        this.deferred.add(kind);
        this.schedule(Date.now() + 60_000, () => {
          this.deferred.delete(kind);
          this.tick(kind, catchUp);
        });
      }
      return;
    }
    const now = Date.now();
    const days =
      kind === "closed-day"
        ? [describePeriod("day", now - DAY_MS), describePeriod("day", now)]
        : [describePeriod("day", now)];
    this.begin(kind, days);
  }

  private closedDayCompleted(key: string): boolean {
    return this.options.store
      .listRuns(1, { kind: "closed-day", status: "ok" })
      .some((run) => run.periods.some((period) => period.period === "day" && period.key === key));
  }

  private begin(kind: RunKind, days: PeriodDescriptor[]): string {
    if (!this.accepting) {
      throw new Error("Team Reports service is not running");
    }
    if (this.active) {
      throw new Error("A Team Reports run is already in progress");
    }
    const id = randomUUID();
    const periods = runPeriods(this.options.config, days);
    const controller = new AbortController();
    this.options.store.startRun({
      id,
      kind,
      startedAtMs: Date.now(),
      periods: periods.map(({ period, key }) => ({ period, key })),
    });
    const deadline = setTimeout(
      () => controller.abort(new Error("Team Reports run exceeded its 45-minute deadline")),
      RUN_DEADLINE_MS,
    );
    const done = Promise.resolve().then(async () => {
      let stats: Record<string, SourceStatus> | undefined;
      try {
        stats = await untilAborted(
          generateReportPeriods({
            ...this.options,
            periods,
            sources:
              this.options.sources ??
              ((runtime) => createReportSources(runtime, Boolean(this.options.resolved.discord))),
            runtime: { logger: this.options.context.logger, signal: controller.signal },
            onRoster: (people) => {
              this.roster = people;
            },
          }),
          controller.signal,
        );
        controller.signal.throwIfAborted();
        if (kind === "closed-day") {
          this.options.store.prune(this.options.config.retention.days);
        }
        const failed = Object.values(stats).some((source) => !source.ok);
        if (failed) {
          throw new Error(
            "An activity source failed; inspect report source warnings and check access",
          );
        }
        this.options.store.finishRun(id, { status: "ok", finishedAtMs: Date.now(), stats });
        this.options.context.serviceHealth?.clearFailure();
      } catch (error) {
        const message = this.safeError(error);
        try {
          this.options.store.finishRun(id, {
            status: "error",
            finishedAtMs: Date.now(),
            error: message,
            stats,
          });
        } catch {
          this.options.context.logger.error(
            "team-reports: failed to record run outcome; check database access and disk space",
          );
        }
        this.options.context.serviceHealth?.reportFailure(new Error(message));
        this.options.context.logger.error(`team-reports: ${message}`);
      } finally {
        clearTimeout(deadline);
        if (this.active?.id === id) {
          this.active = undefined;
        }
      }
    });
    this.active = { id, controller, done };
    return id;
  }

  private safeError(error: unknown): string {
    let message = error instanceof Error ? error.message : "Team Reports run failed";
    for (const token of [
      this.options.resolved.github.token,
      this.options.resolved.discord?.token,
    ]) {
      if (token) {
        message = message.replaceAll(token, "[redacted]");
      }
    }
    return message.slice(0, 2000);
  }
}
