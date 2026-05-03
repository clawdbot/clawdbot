import { vi } from "vitest";
import {
  createDefaultIsolatedRunner,
  noopLogger,
  setupCronRegressionFixtures,
  createAbortAwareIsolatedRunner,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  createRunningCronServiceState,
  createDeferred,
  topOfHourOffsetMs,
  writeCronJobs,
  writeCronStoreSnapshot,
} from "../../test/helpers/cron/service-regression-fixtures.js";
import { CronService } from "./service.js";

type CronServiceOptions = ConstructorParameters<typeof CronService>[0];

export const setupCronIssueRegressionFixtures = () =>
  setupCronRegressionFixtures({ prefix: "cron-issues-" });

export {
  createAbortAwareIsolatedRunner,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  createRunningCronServiceState,
  createDeferred,
  noopLogger,
  topOfHourOffsetMs,
  writeCronJobs,
  writeCronStoreSnapshot,
};

export async function startCronForStore(params: {
  storePath: string;
  cronEnabled?: boolean;
  enqueueSystemEvent?: CronServiceOptions["enqueueSystemEvent"];
  requestHeartbeat?: CronServiceOptions["requestHeartbeat"];
  runIsolatedAgentJob?: CronServiceOptions["runIsolatedAgentJob"];
  onEvent?: CronServiceOptions["onEvent"];
}) {
  const enqueueSystemEvent =
    params.enqueueSystemEvent ?? (vi.fn() as unknown as CronServiceOptions["enqueueSystemEvent"]);
  const requestHeartbeat =
    params.requestHeartbeat ?? (vi.fn() as unknown as CronServiceOptions["requestHeartbeat"]);
  const runIsolatedAgentJob = params.runIsolatedAgentJob ?? createDefaultIsolatedRunner();

  const cron = new CronService({
    cronEnabled: params.cronEnabled ?? true,
    storePath: params.storePath,
    log: noopLogger,
    enqueueSystemEvent,
    requestHeartbeat,
    runIsolatedAgentJob,
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
  await cron.start();
  return cron;
}
