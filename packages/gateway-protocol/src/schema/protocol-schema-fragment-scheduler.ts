import * as cron from "./cron.js";
import * as logMigrations from "./log-migration-protocol-schemas.js";
import * as terminal from "./terminal-protocol-schemas.js";

export const SchedulerProtocolSchemas = {
  CronJob: cron.CronJobSchema,
  CronListParams: cron.CronListParamsSchema,
  CronStatusParams: cron.CronStatusParamsSchema,
  CronGetParams: cron.CronGetParamsSchema,
  CronAddParams: cron.CronAddParamsSchema,
  CronAddResult: cron.CronAddResultSchema,
  CronDeclarativeAddResult: cron.CronDeclarativeAddResultSchema,
  CronUpdateParams: cron.CronUpdateParamsSchema,
  CronRemoveParams: cron.CronRemoveParamsSchema,
  CronRunParams: cron.CronRunParamsSchema,
  CronRunsParams: cron.CronRunsParamsSchema,
  CronScratchGetParams: cron.CronScratchGetParamsSchema,
  CronScratchGetResult: cron.CronScratchGetResultSchema,
  CronScratchSetParams: cron.CronScratchSetParamsSchema,
  CronScratchSetResult: cron.CronScratchSetResultSchema,
  CronRunLogEntry: cron.CronRunLogEntrySchema,
  ...logMigrations.LogMigrationProtocolSchemas,
  ...terminal.TerminalProtocolSchemas,
} as const;
