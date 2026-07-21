// Gateway cron contracts stay separate from the runtime so shared request
// types do not pull scheduler implementation dependencies into their graph.
import type { CronServiceContract } from "../cron/service-contract.js";

export type GatewayCronServiceContract = CronServiceContract & {
  /** Serialize agent-job removal with the roster commit and restore on failure. */
  removeAgentJobsTransactional<T>(agentId: string, commit: () => Promise<T>): Promise<T>;
  /** Temporarily disarm ticks without running startup recovery on resume. */
  pauseScheduling(): void;
  resumeScheduling(): void;
  /** Scheduler-owned work not represented by active cron run markers. */
  getSuspensionBlockerCount?(): number;
  /** Stop cron and await scheduler-owned child process teardown. */
  stopAndDrain?(): Promise<void>;
};
