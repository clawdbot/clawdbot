import { resolveAgentDir } from "../../agents/agent-scope.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

export function resolveDirectiveRuntimeContext(
  params: Pick<HandleDirectiveOnlyParams, "cfg" | "ctx" | "sessionKey" | "agentId">,
) {
  const activeAgentId = params.agentId;
  const agentDir = resolveAgentDir(params.cfg, activeAgentId);
  const runtimePolicySessionKey = resolveRuntimePolicySessionKey({
    agentId: activeAgentId,
    cfg: params.cfg,
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
  const runtimeIsSandboxed = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    agentId: activeAgentId,
    sessionKey: params.sessionKey,
    classificationSessionKey: runtimePolicySessionKey,
  }).sandboxed;
  return { activeAgentId, agentDir, runtimePolicySessionKey, runtimeIsSandboxed };
}
