import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveAgentRuntimePolicy } from "../agent-runtime-policy.js";
import {
  listAgentEntries,
  resolveAgentConfig,
  resolveAgentEffectiveModelPrimary,
} from "../agent-scope.js";
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
    fallback?: "pi" | "none";
    source: "env" | "agent" | "defaults" | "implicit";
  };
};

function normalizeRuntimeValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function resolveAgentRuntimeMetadata(
  cfg: ReturnType<typeof getRuntimeConfig>,
  agentId: string,
): NonNullable<AgentListEntry["agentRuntime"]> {
  const envRuntime = normalizeRuntimeValue(process.env.OPENCLAW_AGENT_RUNTIME);
  if (envRuntime) {
    return {
      id: envRuntime,
      source: "env",
    };
  }

  const agentEntry = listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === agentId);
  const agentPolicy = resolveAgentRuntimePolicy(agentEntry);
  const agentRuntime = normalizeRuntimeValue(agentPolicy?.id);
  if (agentRuntime) {
    return {
      id: agentRuntime,
      fallback: agentPolicy?.fallback,
      source: "agent",
    };
  }

  const defaultsPolicy = resolveAgentRuntimePolicy(cfg.agents?.defaults);
  const defaultsRuntime = normalizeRuntimeValue(defaultsPolicy?.id);
  if (defaultsRuntime) {
    return {
      id: defaultsRuntime,
      fallback: defaultsPolicy?.fallback,
      source: "defaults",
    };
  }

  return {
    id: "pi",
    source: "implicit",
  };
}

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
        const agentRuntime = resolveAgentRuntimeMetadata(cfg, id);
        return {
          id,
          name: configuredNameMap.get(id),
          configured: configuredIds.includes(id),
          model: resolveAgentEffectiveModelPrimary(cfg, id),
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
