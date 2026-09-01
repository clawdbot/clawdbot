import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAcpRuntimeBackend } from "../../../acp/runtime/registry.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentIdStrict, normalizeOptionalAgentId } from "../../../routing/session-key.js";
import { listAgentEntries, resolveAgentEntry } from "../../agent-scope-config.js";
import { listAgentIds } from "../../agent-scope.js";

type ResolvedAcpAgentTarget = {
  ok: true;
  agentId: string;
  configAgentId?: string;
  backendId?: string;
};

function resolveAcpAgentTarget(params: {
  cfg: OpenClawConfig;
  agentId: string;
  configAgentId?: string;
  agentBackend?: string;
}): ResolvedAcpAgentTarget {
  const backendId =
    normalizeOptionalString(params.agentBackend) ??
    normalizeOptionalString(params.cfg.acp?.backend) ??
    getAcpRuntimeBackend()?.id;
  return {
    ok: true,
    agentId: params.agentId,
    ...(params.configAgentId ? { configAgentId: params.configAgentId } : {}),
    ...(backendId ? { backendId } : {}),
  };
}

export function resolveTargetAcpAgentId(params: {
  requestedAgentId?: string;
  cfg: OpenClawConfig;
}): ResolvedAcpAgentTarget | { ok: false; error: string } {
  const normalizedRequest =
    params.requestedAgentId === undefined ? null : normalizeAgentIdStrict(params.requestedAgentId);
  if (normalizedRequest && !normalizedRequest.ok) {
    return { ok: false, error: `agentId "${params.requestedAgentId}" was not found` };
  }
  const requested = normalizedRequest?.value;
  if (requested) {
    const configuredAgent = resolveAgentEntry(params.cfg, requested);
    if (configuredAgent?.runtime?.type === "acp") {
      return resolveAcpAgentTarget({
        cfg: params.cfg,
        agentId: normalizeOptionalAgentId(configuredAgent.runtime.acp?.agent) ?? requested,
        configAgentId: requested,
        agentBackend: configuredAgent.runtime.acp?.backend,
      });
    }
    if (configuredAgent && !isExplicitlyAllowedAcpAgent(params.cfg, requested)) {
      return {
        ok: false,
        error:
          `agentId "${requested}" is an OpenClaw config agent, not an ACP harness. ` +
          'Use runtime="subagent" or omit runtime for OpenClaw config agents. ' +
          'Use runtime="acp" only with external ACP harness ids such as codex, claude, droid, gemini, or opencode, or configure agents.entries.*.runtime.type="acp" with runtime.acp.agent.',
      };
    }
    return resolveAcpAgentTarget({
      cfg: params.cfg,
      agentId: requested,
      ...(configuredAgent ? { configAgentId: requested } : {}),
    });
  }

  const configuredDefault = normalizeOptionalAgentId(params.cfg.acp?.defaultAgent);
  if (configuredDefault) {
    const configuredAgent = resolveAgentEntry(params.cfg, configuredDefault);
    return resolveAcpAgentTarget({
      cfg: params.cfg,
      agentId: configuredDefault,
      agentBackend:
        configuredAgent?.runtime?.type === "acp" ? configuredAgent.runtime.acp?.backend : undefined,
    });
  }

  return {
    ok: false,
    error:
      "ACP target agent is not configured. Pass `agentId` in `sessions_spawn` or set `acp.defaultAgent` in config.",
  };
}

function isExplicitlyAllowedAcpAgent(cfg: OpenClawConfig, agentId: string): boolean {
  return (cfg.acp?.allowedAgents ?? []).some((entry) => {
    if (entry.trim() === "*") {
      return true;
    }
    const normalized = normalizeOptionalAgentId(entry);
    return normalized === agentId;
  });
}

export function resolveConfiguredAcpSubagentTargetIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>(listAgentIds(cfg));
  for (const agent of listAgentEntries(cfg)) {
    if (agent.runtime?.type !== "acp") {
      continue;
    }
    const acpAgent = normalizeOptionalAgentId(agent.runtime.acp?.agent);
    if (acpAgent) {
      ids.add(acpAgent);
    }
  }
  const defaultAgent = normalizeOptionalAgentId(cfg.acp?.defaultAgent);
  if (defaultAgent) {
    ids.add(defaultAgent);
  }
  for (const entry of cfg.acp?.allowedAgents ?? []) {
    if (entry.trim() === "*") {
      continue;
    }
    const id = normalizeOptionalAgentId(entry);
    if (id) {
      ids.add(id);
    }
  }
  return Array.from(ids);
}
