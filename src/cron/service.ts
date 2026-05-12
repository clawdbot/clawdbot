import type { CronServiceContract, CronServiceRunResult } from "./service-contract.js";
import type { CronListPageOptions } from "./service/list-page-types.js";
import * as ops from "./service/ops.js";
import {
  type CronServiceDeps,
  type CronWakeMode,
  createCronServiceState,
} from "./service/state.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

export type { CronEvent, CronServiceDeps } from "./service/state.js";

export class CronService implements CronServiceContract {
  private readonly state;
  constructor(deps: CronServiceDeps) {
    this.state = createCronServiceState(deps);
  }

  async start() {
    await ops.start(this.state);
  }

  stop() {
    ops.stop(this.state);
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

  async add(input: CronJobCreate) {
    return await ops.add(this.state, input);
  }

  async update(id: string, patch: CronJobPatch) {
    return await ops.update(this.state, id, patch);
  }

  async remove(id: string) {
    return await ops.remove(this.state, id);
  }

  async run(id: string, mode?: "due" | "force"): Promise<CronServiceRunResult> {
    return await ops.run(this.state, id, mode);
  }

  async enqueueRun(id: string, mode?: "due" | "force"): Promise<CronServiceRunResult> {
    const result = await ops.enqueueRun(this.state, id, mode);
    if (result.ok && "runnable" in result) {
      throw new Error("cron enqueueRun returned unresolved runnable disposition");
    }
    return result;
  }

  getJob(id: string): CronJob | undefined {
    return this.state.store?.jobs.find((job) => job.id === id);
  }

  async readJob(id: string): Promise<CronJob | undefined> {
    return await ops.readJob(this.state, id);
  }

  getDefaultAgentId(): string | undefined {
    return this.state.deps.defaultAgentId;
  }

  wake(opts: { mode: CronWakeMode; text: string; sessionKey?: string }) {
    return ops.wakeNow(this.state, opts);
  }
}
