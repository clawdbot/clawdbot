/** Public cron service interface shared by callers and implementations. */
import type { CronListPageOptions, CronListPageResult } from "./service/list-page-types.js";
import type {
  CronAddInput,
  CronAddOptions,
  CronAddResult,
  CronListResult,
  CronRemoveResult,
  CronRunMode,
  CronRunResult,
  CronStatusSummary,
  CronUpdateInput,
  CronUpdatePrecondition,
  CronUpdateResult,
  CronWakeMode,
} from "./service/state.js";
import type { CronJob, CronPayload } from "./types.js";

type CronWakeResult = { ok: true } | { ok: false; reason?: "unwakeable-session-key" };

/** Result shape for direct/queued cron runs. */
export type CronServiceRunResult = CronRunResult;
export type CronServiceRunOptions = {
  payload?: CronPayload;
  /** Internal event-source runs keep their persisted trigger on force execution. */
  evaluateTrigger?: boolean;
  /** Current stream batch exposed to trigger scripts as trigger.streamBatch. */
  streamBatch?: string;
  /** Source schedule identity checked under the cron store lock before admission. */
  streamScheduleKey?: string;
  /** Logical source identity; rejects retired batches under same-schedule ABA. */
  streamSourceIdentity?: string;
  onTriggerDisposition?: (disposition: "fired" | "dropped" | "busy" | "error") => void;
};

/** Public cron service facade used by gateway, plugin SDK, and tests. */
export interface CronServiceContract {
  start(): Promise<void>;
  stop(): void;
  status(): Promise<CronStatusSummary>;
  list(opts?: { includeDisabled?: boolean }): Promise<CronListResult>;
  listPage(opts?: CronListPageOptions): Promise<CronListPageResult>;
  add(input: CronAddInput, opts?: CronAddOptions): Promise<CronAddResult>;
  update(id: string, patch: CronUpdateInput): Promise<CronUpdateResult>;
  updateWithPrecondition(
    id: string,
    patch: CronUpdateInput,
    precondition: CronUpdatePrecondition,
  ): Promise<CronUpdateResult>;
  remove(id: string): Promise<CronRemoveResult>;
  run(id: string, mode?: CronRunMode, opts?: CronServiceRunOptions): Promise<CronServiceRunResult>;
  enqueueRun(id: string, mode?: CronRunMode): Promise<CronServiceRunResult>;
  getJob(id: string): CronJob | undefined;
  readJob(id: string): Promise<CronJob | undefined>;
  getDefaultAgentId(): string | undefined;
  wake(opts: {
    mode: CronWakeMode;
    text: string;
    sessionKey?: string;
    agentId?: string;
  }): CronWakeResult;
}
