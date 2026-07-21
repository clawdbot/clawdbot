// First-run onboarding agent creation through the canonical agent service.
import { createAgent } from "../agents/agent-create.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export async function ensureOnboardingAgent(params: {
  config: OpenClawConfig;
  name: string;
  workspace: string;
}): Promise<{ config: OpenClawConfig; agentId?: string; bootstrapPending?: boolean }> {
  if ((params.config.agents?.list?.length ?? 0) > 0) {
    return { config: params.config };
  }
  const result = await createAgent({
    name: params.name,
    workspace: params.workspace,
    skipBootstrap: params.config.agents?.defaults?.skipBootstrap,
    skipOptionalBootstrapFiles: params.config.agents?.defaults?.skipOptionalBootstrapFiles,
  });
  if (result.status === "error") {
    throw new Error(result.message);
  }
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    throw new Error("Agent creation wrote an invalid OpenClaw config.");
  }
  return {
    config: snapshot.sourceConfig ?? snapshot.config,
    agentId: result.agentId,
    bootstrapPending: result.bootstrapPending,
  };
}
