import type { CronListPageOptions, CronListPageResult } from "./service/list-page-types.js";
import type {
  CronAddInput,
  CronAddResult,
  CronListResult,
  CronRemoveResult,
  CronRunMode,
  CronRunResult,
  CronStatusSummary,
  CronUpdateInput,
  CronUpdateResult,
  CronWakeMode,
} from "./service/state.js";
import type { CronJob } from "./types.js";

export type { CronListPageOptions, CronListPageResult } from "./service/list-page-types.js";

export type CronWakeResult = { ok: true } | { ok: false };

export type CronServiceRunResult = CronRunResult | { ok: true; ran: false; reason: "invalid-spec" };

export interface CronServiceContract {
  start(): Promise<void>;
  stop(): void;
  status(): Promise<CronStatusSummary>;
  list(opts?: { includeDisabled?: boolean }): Promise<CronListResult>;
  listPage(opts?: CronListPageOptions): Promise<CronListPageResult>;
  add(input: CronAddInput): Promise<CronAddResult>;
  update(id: string, patch: CronUpdateInput): Promise<CronUpdateResult>;
  remove(id: string): Promise<CronRemoveResult>;
  run(id: string, mode?: CronRunMode): Promise<CronServiceRunResult>;
  enqueueRun(id: string, mode?: CronRunMode): Promise<CronServiceRunResult>;
  getJob(id: string): CronJob | undefined;
  getDefaultAgentId(): string | undefined;
  wake(opts: { mode: CronWakeMode; text: string }): CronWakeResult;
}
