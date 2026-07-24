import { getRuntimeConfig } from "../config/config.js";
import {
  type ExecDenylistEntry,
  resolveEffectiveExecDenylist,
} from "../infra/exec-approvals-denylist.js";
import { resolveAgentConfig } from "./agent-scope.js";

export function resolveCurrentExecConfigDenylist(params: {
  fallback?: readonly ExecDenylistEntry[];
  agentId?: string;
}): readonly ExecDenylistEntry[] {
  try {
    const cfg = getRuntimeConfig();
    const globalExec = cfg.tools?.exec;
    const agentExec = params.agentId
      ? resolveAgentConfig(cfg, params.agentId)?.tools?.exec
      : undefined;
    return resolveEffectiveExecDenylist({
      layers: [globalExec?.denylist, agentExec?.denylist],
    });
  } catch {
    return params.fallback ?? [];
  }
}
