import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveModelAgentRuntimeMetadata } from "../agent-runtime-metadata.js";
import { resolveAgentConfig, resolveAgentEffectiveModelPrimary } from "../agent-scope.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { resolveSubagentAllowedTargetIds } from "../subagent-target-policy.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const AgentsListToolSchema = Type.Object({});

type AgentListEntry = {
  id: string;
  name?: string;
  configured: boolean;
  model?: string;
  agentRuntime?: {
    id: string;
    source: "env" | "agent" | "defaults" | "model" | "provider" | "implicit";
  };
};

export function createAgentsListTool(opts?: {
  agentSessionKey?: string;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Agents",
    name: "agents_list",
    description:
      'List OpenClaw agent ids you can target with `sessions_spawn` when `runtime="subagent"` (based on subagent allowlists).',
    parameters: AgentsListToolSchema,
    execute: async () => {
      const cfg = getRuntimeConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterInternalKey =
        typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()
          ? resolveInternalSessionKey({
              key: opts.agentSessionKey,
              alias,
              mainKey,
            })
          : alias;
      const requesterAgentId = normalizeAgentId(
        opts?.requesterAgentIdOverride ??
          parseAgentSessionKey(requesterInternalKey)?.agentId ??
          DEFAULT_AGENT_ID,
      );

      const allowAgents =
        resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??
        cfg?.agents?.defaults?.subagents?.allowAgents;

      const configuredAgents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
      const configuredIds = configuredAgents.map((entry) => normalizeAgentId(entry.id));
      const configuredNameMap = new Map<string, string>();
      for (const entry of configuredAgents) {
        const name = entry?.name?.trim() ?? "";
        if (!name) {
          continue;
        }
        configuredNameMap.set(normalizeAgentId(entry.id), name);
      }

      const allowed = resolveSubagentAllowedTargetIds({
        requesterAgentId,
        allowAgents,
        configuredAgentIds: configuredIds,
      });
      const all = allowed.allowedIds;
      const rest = all
        .filter((id) => id !== requesterAgentId)
        .toSorted((a, b) => a.localeCompare(b));
      const ordered = all.includes(requesterAgentId) ? [requesterAgentId, ...rest] : rest;
      const agents: AgentListEntry[] = ordered.map((id) => {
        const model = resolveAgentEffectiveModelPrimary(cfg, id);
        const resolvedModel = resolveDefaultModelForAgent({ cfg, agentId: id });
        const agentRuntime = resolveModelAgentRuntimeMetadata({
          cfg,
          agentId: id,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
        });
        return {
          id,
          name: configuredNameMap.get(id),
          configured: configuredIds.includes(id),
          model,
          agentRuntime,
        };
      });

      return jsonResult({
        requester: requesterAgentId,
        allowAny: allowed.allowAny,
        agents,
      });
    },
  };
}
