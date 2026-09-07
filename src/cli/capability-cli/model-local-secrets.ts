import { resolveAgentDir } from "../../agents/agent-scope.js";
import { getRuntimeConfigSourceSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";

/** Prepare account-owned SecretRefs for one standalone local model run. */
export async function prepareLocalModelRunAccountSecrets(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  if (getActiveSecretsRuntimeConfigSnapshot()) {
    return;
  }

  const secretsRuntime = await import("../../secrets/runtime.js");
  const snapshot = await secretsRuntime.prepareSecretsRuntimeSnapshot({
    config: getRuntimeConfigSourceSnapshot() ?? params.cfg,
    assignmentConfig: params.cfg,
    agentDirs: [resolveAgentDir(params.cfg, params.agentId)],
    includeConfigRefs: false,
  });
  secretsRuntime.activateSecretsRuntimeSnapshot(snapshot);
}
