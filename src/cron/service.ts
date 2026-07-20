/** Stateful CronService facade around the locked service operation helpers. */
import type {
  CronServiceContract,
  CronServiceRunOptions,
  CronServiceRunResult,
} from "./service-contract.js";
import type { CronListPageOptions } from "./service/list-page-types.js";
import * as ops from "./service/ops.js";
import {
  type CronAddOptions,
  type CronServiceDeps,
  type CronUpdatePrecondition,
  type CronWakeMode,
  createCronServiceState,
} from "./service/state.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

export type { CronEvent } from "./service/state.js";

/** Public cron service facade that owns mutable scheduler state and delegates to locked ops. */
export class CronService implements CronServiceContract {
  private readonly state;
  private startInProgress = 0;
  private startState: { generation: number; promise: Promise<void> } | null = null;
  private lifecycleGeneration = 0;

  constructor(deps: CronServiceDeps) {
    this.state = createCronServiceState(deps);
  }

  async start() {
    const generation = this.lifecycleGeneration;
    const pending = this.startState;
    if (pending) {
      try {
        await pending.promise;
      } catch (err) {
        if (pending.generation === generation) {
          throw err;
        }
      }
      if (pending.generation === generation) {
        return;
      }
      await this.start();
      return;
    }
    const promise = this.startOnce(generation);
    this.startState = { generation, promise };
    try {
      await promise;
    } finally {
      if (this.startState?.promise === promise) {
        this.startState = null;
      }
    }
  }

  private async startOnce(generation: number) {
    this.startInProgress += 1;
    this.state.schedulerStarted = false;
    try {
      await ops.start(this.state);
      if (generation !== this.lifecycleGeneration) {
        ops.stop(this.state);
        return;
      }
      this.state.schedulerStarted = !this.state.stopped;
    } finally {
      this.startInProgress -= 1;
    }
  }

  stop() {
    this.lifecycleGeneration += 1;
    ops.stop(this.state);
  }

  pauseScheduling() {
    ops.pauseScheduling(this.state);
  }

  resumeScheduling() {
    ops.resumeScheduling(this.state);
  }

  getSuspensionBlockerCount() {
    return this.startInProgress;
  }

  async status() {
    return await ops.status(this.state);
  }

  async list(opts?: { includeDisabled?: boolean }) {
    return await ops.list(this.state, opts);
  }

  async listPage(opts?: CronListPageOptions) {
    return await ops.listPage(this.state, opts);
  }

  async add(input: CronJobCreate, opts?: CronAddOptions) {
    return await ops.add(this.state, input, opts);
  }

  async update(id: string, patch: CronJobPatch) {
    return await ops.update(this.state, id, patch);
  }

  async updateWithPrecondition(
    id: string,
    patch: CronJobPatch,
    precondition: CronUpdatePrecondition,
  ) {
    return await ops.updateWithPrecondition(this.state, id, patch, precondition);
  }

  async remove(id: string) {
    return await ops.remove(this.state, id);
  }

  async removeAgentJobsTransactional<T>(agentId: string, commit: () => Promise<T>): Promise<T> {
    return await ops.removeAgentJobsTransactional(this.state, agentId, commit);
  }

  async run(
    id: string,
    mode?: "due" | "force",
    opts?: CronServiceRunOptions,
  ): Promise<CronServiceRunResult> {
    return await ops.run(this.state, id, mode, opts);
  }

  async enqueueRun(id: string, mode?: "due" | "force"): Promise<CronServiceRunResult> {
    const result = await ops.enqueueRun(this.state, id, mode);
    if (result.ok && "runnable" in result) {
      // ops.enqueueRun resolves runnable dispositions before crossing the
      // public facade; leaking one would expose an internal scheduler detail.
      throw new Error("cron enqueueRun returned unresolved runnable disposition");
    }
    return result;
  }

  getJob(id: string): CronJob | undefined {
    return this.state.store?.jobs.find((job) => job.id === id);
  }

  /** In-memory job snapshot; undefined until the store is loaded. */
  getLoadedJobs(): readonly CronJob[] | undefined {
    return this.state.store?.jobs;
  }

  async readJob(id: string): Promise<CronJob | undefined> {
    return await ops.readJob(this.state, id);
  }

  getDefaultAgentId(): string | undefined {
    return this.state.deps.defaultAgentId;
  }

  wake(opts: { mode: CronWakeMode; text: string; sessionKey?: string; agentId?: string }) {
    return ops.wakeNow(this.state, opts);
  }
}
