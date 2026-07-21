import { resolveAgentDir } from "../agents/agent-scope.js";
import { copyPortableAuthProfiles } from "../agents/auth-profiles/copy-portable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { DefaultInferenceRouteProjection } from "./inference-route.js";

/** Reuses a verified directory only when setup is creating that same literal agent id. */
export function resolveVerifiedFirstAgentDir(params: {
  agentId: string;
  verifiedRoute?: DefaultInferenceRouteProjection;
}): string | undefined {
  const route = params.verifiedRoute?.route;
  return route && normalizeAgentId(route.agentId) === normalizeAgentId(params.agentId)
    ? route.agentDir
    : undefined;
}

/** Copies portable credentials when a renamed first agent gets its own canonical directory. */
export async function prepareFirstAgentCredentialDir(params: {
  agentId: string;
  config: OpenClawConfig;
  verifiedAgentDir?: string;
}): Promise<string> {
  const agentDir = resolveAgentDir(params.config, params.agentId);
  if (params.verifiedAgentDir && params.verifiedAgentDir !== agentDir) {
    await copyPortableAuthProfiles({
      sourceAgentDir: params.verifiedAgentDir,
      destAgentDir: agentDir,
    });
  }
  return agentDir;
}
