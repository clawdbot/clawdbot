import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

export function resolveDirectiveRuntimeContext(
  params: Pick<HandleDirectiveOnlyParams, "cfg" | "ctx" | "sessionKey">,
) {
  const activeAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const agentDir = resolveAgentDir(params.cfg, activeAgentId);
  const runtimePolicySessionKey = resolveRuntimePolicySessionKey({
    agentId: activeAgentId,
    cfg: params.cfg,
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
  const runtimeIsSandboxed = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: runtimePolicySessionKey,
  }).sandboxed;
  return { activeAgentId, agentDir, runtimePolicySessionKey, runtimeIsSandboxed };
}
