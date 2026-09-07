import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import {
  clawMonitorInventorySchema,
  clawMonitorDrainSchema,
  type ClawMonitorCleanupGateway,
} from "../claws/monitor-cleanup-contract.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { callGatewayFromCli } from "./gateway-rpc.js";

const binding = () =>
  resolveClawMonitorCleanupBinding(resolveCronJobsStorePathFromConfig(getRuntimeConfig()));

export const clawMonitorCleanupGateway: ClawMonitorCleanupGateway = {
  inspect: async (agentId) =>
    clawMonitorInventorySchema.parse(
      await callGatewayFromCli(
        "claws.monitors",
        { timeout: "5000" },
        { phase: "inspect", agentId, binding: binding() },
      ),
    ).monitors,
  quiesce: async (agentId, operationId, monitors) => {
    clawMonitorDrainSchema.parse(
      await callGatewayFromCli(
        "claws.monitors",
        {},
        { phase: "quiesce", agentId, operationId, monitors, binding: binding() },
      ),
    );
  },
  drain: async (agentId, operationId) => {
    clawMonitorDrainSchema.parse(
      await callGatewayFromCli(
        "claws.monitors",
        {},
        { phase: "drain", agentId, operationId, binding: binding() },
      ),
    );
  },
};
