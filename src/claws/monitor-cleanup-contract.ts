import { z } from "zod";

const text = z.string().min(1).max(4096);
export const clawMonitorCleanupBindingSchema = z
  .object({
    configPath: text,
    statePath: text,
    cronStorePath: text,
  })
  .strict();
export type ClawMonitorCleanupBinding = z.infer<typeof clawMonitorCleanupBindingSchema>;
export const clawMonitorSnapshotSchema = z
  .object({
    id: text,
    name: z.string(),
    enabled: z.boolean(),
    agentId: text,
    ownerAgentId: z.null(),
    storeKey: text,
    declarationKey: text,
    revision: text,
  })
  .strict();
export const clawMonitorInventorySchema = z
  .object({
    monitors: z.array(clawMonitorSnapshotSchema).max(2),
  })
  .strict();
export type ClawMonitorSnapshot = z.infer<typeof clawMonitorSnapshotSchema>;
export const clawMonitorDrainSchema = z.object({ drained: z.literal(true) }).strict();

export type ClawMonitorCleanupGateway = {
  inspect: (agentId: string) => Promise<ClawMonitorSnapshot[]>;
  quiesce: (agentId: string, operationId: string, monitors: ClawMonitorSnapshot[]) => Promise<void>;
  drain: (agentId: string, operationId: string) => Promise<void>;
};
