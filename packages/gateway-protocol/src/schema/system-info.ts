// Gateway Protocol schema module defines Gateway host system information.
import type { Static } from "typebox";
import { Type } from "typebox";

/** Empty request payload for Gateway host system information. */
export const SystemInfoParamsSchema = Type.Object({}, { additionalProperties: false });

/** Gateway host identity and resource snapshot. */
export const SystemInfoResultSchema = Type.Object(
  {
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
    uptimeMs: Type.Integer(),
    cpuCount: Type.Integer(),
    cpuModel: Type.Optional(Type.String()),
    loadAverage: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number()])),
    memoryTotalBytes: Type.Integer(),
    memoryFreeBytes: Type.Integer(),
    diskTotalBytes: Type.Optional(Type.Integer()),
    diskAvailableBytes: Type.Optional(Type.Integer()),
    diskPath: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type SystemInfoParams = Static<typeof SystemInfoParamsSchema>;
export type SystemInfoResult = Static<typeof SystemInfoResultSchema>;
