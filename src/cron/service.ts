/** Stateful CronService facade around the locked service operation helpers. */
import type {
  CronServiceContract,
  CronServiceRunOptions,
  CronServiceRunResult,
} from "./service-contract.js";
import type { CronListPageOptions } from "./service/list-page-types.js";
import * as lifecycleOps from "./service/ops-lifecycle.js";
import * as mutationOps from "./service/ops-mutations.js";
import * as readOps from "./service/ops-read.js";
import * as runOps from "./service/ops-run.js";
import {
  type CronAddOptions,
  type CronServiceDeps,
  type CronRunMode,
  type CronUpdatePrecondition,
  type CronUpdateOptions,
  type CronWakeMode,
  createCronServiceState,
} from "./service/state.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

export type { CronEvent } from "./service/state.js";

/** Public cron service facade that owns mutable scheduler state and delegates to locked ops. */
export class CronService implements CronServiceContract {
  stopAndDrain?: () => Promise<void>;
  private readonly state;
  private startInProgress = 0;
  private startState: { generation: number; promise: Promise<void> } | null = null;

  constructor(deps: CronServiceDeps) {
    this.state = createCronServiceState(deps);
  }

  async start() {
    const generation = this.state.lifecycleGeneration;
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
      await lifecycleOps.start(this.state);
      if (generation !== this.state.lifecycleGeneration) {
        lifecycleOps.stop(this.state);
        return;
      }
      this.state.schedulerStarted = !this.state.stopped;
    } finally {
      this.startInProgress -= 1;
    }
  }

  stop() {
    lifecycleOps.stop(this.state);
  }

  pauseScheduling() {
    lifecycleOps.pauseScheduling(this.state);
  }

  resumeScheduling() {
    lifecycleOps.resumeScheduling(this.state);
  }

  getSuspensionBlockerCount() {
    return this.startInProgress;
  }

  async status() {
    return await readOps.status(this.state);
  }

  async list(opts?: { includeDisabled?: boolean }) {
    return await readOps.list(this.state, opts);
  }

  async listPage(opts?: CronListPageOptions) {
    return await readOps.listPage(this.state, opts);
  }

  async add(input: CronJobCreate, opts?: CronAddOptions) {
    return await mutationOps.add(this.state, input, opts);
  }

  async removeStaleJobFamily(
    family: { declarationKey: string; name: string; ownerPluginTag: string },
    opts?: { commitGuard?: () => void },
  ) {
    return await mutationOps.removeStaleJobFamily(this.state, family, opts);
  }

  async update(id: string, patch: CronJobPatch, opts?: CronUpdateOptions) {
    return await mutationOps.update(this.state, id, patch, opts);
  }

  async updateWithPrecondition(
    id: string,
    patch: CronJobPatch,
    precondition: CronUpdatePrecondition,
    opts?: CronUpdateOptions,
  ) {
    return await mutationOps.updateWithPrecondition(this.state, id, patch, precondition, opts);
  }

  async remove(id: string, opts?: { systemOwned?: boolean; commitGuard?: () => void }) {
    return await mutationOps.remove(this.state, id, opts);
  }

  async removeAgentJobsTransactional<T>(agentId: string, commit: () => Promise<T>): Promise<T> {
    return await mutationOps.removeAgentJobsTransactional(this.state, agentId, commit);
  }

  async quiesceJobs(jobs: readonly { id: string; revision: string }[], commitGuard: () => void) {
    await mutationOps.quiesceJobs(this.state, jobs, commitGuard);
  }

  async run(
    id: string,
    mode?: CronRunMode,
    opts?: CronServiceRunOptions,
  ): Promise<CronServiceRunResult> {
    return await runOps.run(this.state, id, mode, opts);
  }

  async enqueueRun(
    id: string,
    mode?: CronRunMode,
    opts?: { commitGuard?: () => void },
  ): Promise<CronServiceRunResult> {
    const result = await runOps.enqueueRun(this.state, id, mode, opts);
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
    return await readOps.readJob(this.state, id);
  }

  async readScratch(id: string) {
    return await readOps.readScratch(this.state, id);
  }

  async writeScratch(
    id: string,
    params: {
      content: string | null;
      expectedRevision?: number;
      sourceSha256?: string;
      commitGuard?: () => void;
    },
  ) {
    return await readOps.writeScratch(this.state, id, params);
  }

  async recordExternalFailure(
    id: string,
    error: string,
    statePatch: Partial<CronJob["state"]>,
    source?: { scheduleKey: string; identity: string },
  ): Promise<void> {
    await readOps.recordExternalFailure(this.state, id, error, statePatch, source);
  }

  async updateExternalState(
    id: string,
    streamScheduleKey: string,
    streamSourceIdentity: string,
    statePatch: Partial<CronJob["state"]>,
  ): Promise<boolean> {
    return await readOps.updateExternalState(
      this.state,
      id,
      streamScheduleKey,
      streamSourceIdentity,
      statePatch,
    );
  }

  async retireExternalStreamSource(
    id: string,
    streamScheduleKey: string,
    streamSourceIdentity: string,
  ): Promise<string | undefined> {
    return await readOps.retireExternalStreamSource(
      this.state,
      id,
      streamScheduleKey,
      streamSourceIdentity,
    );
  }

  async updateExternalCounters(
    id: string,
    counters: Pick<CronJob["state"], "streamDroppedBatches" | "streamCoalescedBatches">,
  ): Promise<void> {
    await readOps.updateExternalCounters(this.state, id, counters);
  }

  getDefaultAgentId(): string | undefined {
    return this.state.deps.resolveDefaultAgentId
      ? this.state.deps.resolveDefaultAgentId()
      : this.state.deps.defaultAgentId;
  }

  wake(opts: { mode: CronWakeMode; text: string; sessionKey?: string; agentId?: string }) {
    return runOps.wakeNow(this.state, opts);
  }
}
