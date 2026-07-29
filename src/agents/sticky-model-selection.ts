import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { mutateConfigFileWithRetry } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { setAgentEffectiveModelPrimary, type AgentModelPrimaryWriteTarget } from "./agent-scope.js";

const log = createSubsystemLogger("agents/sticky-model-selection");

/** Persists a validated session model selection at the agent's effective config layer. */
export async function persistStickyModelSelection(params: {
  agentId: string;
  model: string;
}): Promise<AgentModelPrimaryWriteTarget> {
  const model = normalizeOptionalString(params.model);
  if (!model) {
    throw new Error("Sticky model selection must be non-empty.");
  }
  const agentId = normalizeAgentId(params.agentId);
  const committed = await mutateConfigFileWithRetry<AgentModelPrimaryWriteTarget>({
    afterWrite: { mode: "auto" },
    mutate: (draft) => setAgentEffectiveModelPrimary(draft, agentId, model),
  });
  if (!committed.result) {
    throw new Error("Sticky model config mutation did not return its write target.");
  }
  log.info(
    `persisted sticky model selection agentId=${agentId} model=${model} target=${committed.result}`,
  );
  return committed.result;
}
