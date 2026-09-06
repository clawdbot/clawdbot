/**
 * agents_list built-in tool.
 *
 * Lists configured or allowed agent ids plus model/runtime metadata for subagent spawn decisions.
 */
import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { Type, type Static } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveModelAgentRuntimeMetadata } from "../agent-runtime-metadata.js";
import { listAgentEntries, listAgentIds } from "../agent-scope-config.js";
import { resolveAgentConfig, resolveSessionAgentIds } from "../agent-scope.js";
import {
  estimateToolResultTextChars,
  sliceToolResultTextToBudget,
} from "../embedded-agent-runner/tool-result-text-budget.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { resolveSubagentAllowedTargetIds } from "../subagents/spawn/subagent-target-policy.js";
import { describeAgentsListTool } from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

// Bound model-visible capability summaries without shrinking the authorized agent roster.
const MAX_AGENT_DESCRIPTION_CHARS = 512;
const MAX_AGENT_DESCRIPTION_BUDGET = 4096;

const AgentsListToolSchema = Type.Object({});
const AgentRuntimeSourceSchema = Type.Union([
  Type.Literal("env"),
  Type.Literal("agent"),
  Type.Literal("defaults"),
  Type.Literal("model"),
  Type.Literal("provider"),
  Type.Literal("implicit"),
  Type.Literal("session"),
  Type.Literal("session-key"),
]);
const AgentsListOutputSchema = Type.Object(
  {
    requester: Type.String(),
    allowAny: Type.Boolean(),
    agents: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          name: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          configured: Type.Boolean(),
          model: Type.Optional(Type.String()),
          agentRuntime: Type.Optional(
            Type.Object(
              {
                id: Type.String(),
                source: AgentRuntimeSourceSchema,
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type AgentListEntry = Static<typeof AgentsListOutputSchema>["agents"][number];

function truncateAgentDescription(value: string, maxBudgetUnits: number): string {
  const bounded = truncateWithMarker(value, MAX_AGENT_DESCRIPTION_CHARS, {
    marker: "…",
    reserve: 1,
    trimEnd: true,
  });
  if (estimateToolResultTextChars(bounded) <= maxBudgetUnits) {
    return bounded;
  }
  return `${sliceToolResultTextToBudget(bounded, maxBudgetUnits - 1).trimEnd()}…`;
}

export function createAgentsListTool(opts?: {
  agentSessionKey?: string;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Agents",
    name: "agents_list",
    description: describeAgentsListTool(false),
    parameters: AgentsListToolSchema,
    outputSchema: AgentsListOutputSchema,
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
      const requesterAgentId = resolveSessionAgentIds({
        config: cfg,
        sessionKey: requesterInternalKey,
        agentId: opts?.requesterAgentIdOverride,
      }).sessionAgentId;

      const allowAgents =
        resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??
        cfg?.agents?.defaults?.subagents?.allowAgents;

      const configuredAgents = listAgentEntries(cfg);
      const configuredIds = listAgentIds(cfg);
      const configuredNameMap = new Map<string, string>();
      const configuredDescriptionMap = new Map<string, string>();
      for (const entry of configuredAgents) {
        const description = entry?.description?.trim();
        if (description) {
          configuredDescriptionMap.set(normalizeAgentId(entry.id), description);
        }
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
      let remainingDescriptionBudget = MAX_AGENT_DESCRIPTION_BUDGET;
      const agents: AgentListEntry[] = ordered.map((id) => {
        const resolvedModel = resolveDefaultModelForAgent({ cfg, agentId: id });
        // Publish the resolved identity (aliases are routing-only) so the model
        // field matches the agentRuntime derived from the same resolvedModel.
        const model = `${resolvedModel.provider}/${resolvedModel.model}`;
        const agentRuntime = resolveModelAgentRuntimeMetadata({
          cfg,
          agentId: id,
          provider: resolvedModel.provider,
          model: resolvedModel.model,
        });
        const entry: AgentListEntry = {
          id,
          name: configuredNameMap.get(id),
          configured: configuredIds.includes(id),
          model,
          agentRuntime,
        };
        const description = configuredDescriptionMap.get(id);
        if (description && remainingDescriptionBudget > 0) {
          entry.description = truncateAgentDescription(description, remainingDescriptionBudget);
          remainingDescriptionBudget -= estimateToolResultTextChars(entry.description);
        }
        return entry;
      });

      return jsonResult({
        requester: requesterAgentId,
        allowAny: allowed.allowAny,
        agents,
      });
    },
  };
}
