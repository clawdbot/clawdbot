import type {
  CronListPageOptions,
  CronServiceContract,
  CronServiceRunResult,
} from "./service-contract.js";
import * as ops from "./service/ops.js";
import { type CronServiceDeps, createCronServiceState } from "./service/state.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

export type { CronEvent, CronServiceDeps } from "./service/state.js";
export type {
  CronListPageOptions,
  CronListPageResult,
  CronServiceContract,
  CronServiceRunResult,
  CronWakeResult,
} from "./service-contract.js";

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

  wake(opts: { mode: "now" | "next-heartbeat"; text: string }) {
    return ops.wakeNow(this.state, opts);
  }
}
