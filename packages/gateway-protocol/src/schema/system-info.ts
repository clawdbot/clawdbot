// Gateway Protocol schema module defines Gateway host system information.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

/** Empty request payload for Gateway host system information. */
export const SystemInfoParamsSchema = closedObject({});

const UtilityModelStatusSchema = Type.Union([
  closedObject({ status: Type.Literal("auto"), model: Type.String({ minLength: 1 }) }),
  closedObject({ status: Type.Literal("configured"), model: Type.String({ minLength: 1 }) }),
  closedObject({ status: Type.Literal("disabled") }),
  closedObject({ status: Type.Literal("unavailable") }),
]);

/** Gateway host identity and resource snapshot. */
export const SystemInfoResultSchema = closedObject({
  machineName: Type.String(),
  hostname: Type.String(),
  platform: Type.String(),
  release: Type.String(),
  arch: Type.String(),
  osLabel: Type.String(),
  lanAddress: Type.Optional(Type.String()),
  port: Type.Optional(Type.Integer()),
  nodeVersion: Type.String(),
  pid: Type.Integer(),
  /** Process-start identity for invalidating work that cannot survive a Gateway restart. */
  processInstanceId: Type.Optional(Type.String({ minLength: 1 })),
  uptimeMs: Type.Integer(),
  cpuCount: Type.Integer(),
  cpuModel: Type.Optional(Type.String()),
  loadAverage: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number()])),
  memoryTotalBytes: Type.Integer(),
  memoryFreeBytes: Type.Integer(),
  diskTotalBytes: Type.Optional(Type.Integer()),
  diskAvailableBytes: Type.Optional(Type.Integer()),
  diskPath: Type.Optional(Type.String()),
  /** Resolved utility model for the configured default agent. */
  defaultAgentUtilityModel: Type.Optional(UtilityModelStatusSchema),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type SystemInfoParams = Static<typeof SystemInfoParamsSchema>;
export type SystemInfoResult = Static<typeof SystemInfoResultSchema>;
