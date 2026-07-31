import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  getLatestSubagentRunByChildSessionKey,
  hasSubagentRunIdentity,
  quarantineFailedSubagentSpawn,
} from "./subagent-registry.js";
import type { SubagentProgressOrigin } from "./subagent-registry.types.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export function hasDurableReservedSubagentIdentity(params: {
  runId: string;
  childSessionKey: string;
}): boolean {
  return (
    hasSubagentRunIdentity(params.runId) ||
    Boolean(getLatestSubagentRunByChildSessionKey(params.childSessionKey))
  );
}

export function recordIndeterminateFailedSubagentSpawn(params: {
  runId: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  progressOrigin?: SubagentProgressOrigin;
  requesterDisplayKey: string;
  requesterAgentId: string;
  task: string;
  taskName?: string;
  agentId: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds: number;
  spawnMode: SpawnSubagentMode;
  reason: string;
}): boolean {
  try {
    quarantineFailedSubagentSpawn(params);
    return true;
  } catch {
    return false;
  }
}
