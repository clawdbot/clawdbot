// Wire types derive from the cron schemas without importing the ProtocolSchemas registry.
import type { Static } from "typebox";
import type {
  CronAddParamsSchema,
  CronAddResultSchema,
  CronDeclarativeAddResultSchema,
  CronGetParamsSchema,
  CronJobSchema,
  CronListParamsSchema,
  CronRemoveParamsSchema,
  CronRunLogEntrySchema,
  CronRunParamsSchema,
  CronRunsParamsSchema,
  CronScratchGetParamsSchema,
  CronScratchGetResultSchema,
  CronScratchSetParamsSchema,
  CronScratchSetResultSchema,
  CronStatusParamsSchema,
  CronUpdateParamsSchema,
} from "./cron.js";

export type CronJob = Static<typeof CronJobSchema>;
export type CronListParams = Static<typeof CronListParamsSchema>;
export type CronStatusParams = Static<typeof CronStatusParamsSchema>;
export type CronGetParams = Static<typeof CronGetParamsSchema>;
export type CronAddParams = Static<typeof CronAddParamsSchema>;
export type CronAddResult = Static<typeof CronAddResultSchema>;
export type CronDeclarativeAddResult = Static<typeof CronDeclarativeAddResultSchema>;
export type CronUpdateParams = Static<typeof CronUpdateParamsSchema>;
export type CronRemoveParams = Static<typeof CronRemoveParamsSchema>;
export type CronRunParams = Static<typeof CronRunParamsSchema>;
export type CronRunsParams = Static<typeof CronRunsParamsSchema>;
export type CronScratchGetParams = Static<typeof CronScratchGetParamsSchema>;
export type CronScratchGetResult = Static<typeof CronScratchGetResultSchema>;
export type CronScratchSetParams = Static<typeof CronScratchSetParamsSchema>;
export type CronScratchSetResult = Static<typeof CronScratchSetResultSchema>;
export type CronRunLogEntry = Static<typeof CronRunLogEntrySchema>;
