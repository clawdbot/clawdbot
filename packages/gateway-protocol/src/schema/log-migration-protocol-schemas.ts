// Ordered protocol schema group for log-tail and migration control surfaces.
import { LogsTailParamsSchema, LogsTailResultSchema } from "./logs-chat.js";
import { MigrationProtocolSchemas } from "./migrations.js";

export const LogMigrationProtocolSchemas = {
  LogsTailParams: LogsTailParamsSchema,
  LogsTailResult: LogsTailResultSchema,
  ...MigrationProtocolSchemas,
} as const;
