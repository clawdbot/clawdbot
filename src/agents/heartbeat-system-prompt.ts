/**
 * Builds heartbeat-specific guidance for agent system prompts.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  DEFAULT_HEARTBEAT_EVERY,
  HEARTBEAT_CRON_TASK_GUIDANCE,
  resolveHeartbeatPromptCore as resolveHeartbeatPromptText,
} from "../auto-reply/heartbeat.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { tryResolveAmbientOwnerAgentId } from "./agent-scope-config.js";
import { listAgentEntries, resolveAgentConfig } from "./agent-scope.js";

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];

function isHeartbeatSharedAcrossAgents(config: OpenClawConfig): boolean {
  return (
    config.agents?.defaults?.heartbeat !== undefined &&
    normalizeOptionalString(config.agents.defaults.heartbeat.agentId) === undefined &&
    !listAgentEntries(config).some((entry) => Boolean(entry?.heartbeat))
  );
}

function tryResolveHeartbeatOwnerAgentId(config?: OpenClawConfig): string | undefined {
  return tryResolveAmbientOwnerAgentId(config ?? {}, config?.agents?.defaults?.heartbeat?.agentId);
}

// System prompt heartbeat config inherits defaults, then per-agent overrides,
// matching runtime scheduling without exposing disabled agents to the section.
function resolveHeartbeatConfigForSystemPrompt(
  config?: OpenClawConfig,
  agentId?: string,
): HeartbeatConfig | undefined {
  const defaults = config?.agents?.defaults?.heartbeat;
  if (!config || !agentId) {
    return defaults;
  }
  const overrides = resolveAgentConfig(config, agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return overrides;
  }
  return { ...defaults, ...overrides };
}

function isAgentExplicitlyEnrolledForHeartbeat(config: OpenClawConfig, agentId: string): boolean {
  const resolvedAgentId = normalizeAgentId(agentId);
  return listAgentEntries(config).some(
    (entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry.id) === resolvedAgentId,
  );
}

// Explicit heartbeat config on any agent means only those agents are opted in;
// shared defaults without an owner enroll every configured agent.
function isHeartbeatEnabledByAgentPolicy(config: OpenClawConfig, agentId: string): boolean {
  const agents = listAgentEntries(config);
  const hasExplicitHeartbeatAgents = agents.some((entry) => Boolean(entry?.heartbeat));
  if (hasExplicitHeartbeatAgents) {
    return isAgentExplicitlyEnrolledForHeartbeat(config, agentId);
  }
  if (isHeartbeatSharedAcrossAgents(config)) {
    return true;
  }
  const heartbeatOwnerAgentId = tryResolveHeartbeatOwnerAgentId(config);
  return (
    heartbeatOwnerAgentId !== undefined &&
    normalizeAgentId(agentId) === normalizeAgentId(heartbeatOwnerAgentId)
  );
}

function isHeartbeatCadenceEnabled(heartbeat?: HeartbeatConfig): boolean {
  const rawEvery = heartbeat?.every ?? DEFAULT_HEARTBEAT_EVERY;
  const trimmedEvery = normalizeOptionalString(rawEvery) ?? "";
  if (!trimmedEvery) {
    return false;
  }
  try {
    return parseDurationMs(trimmedEvery, { defaultUnit: "m" }) > 0;
  } catch {
    return false;
  }
}

/** Returns true when heartbeat guidance should be included in the system prompt. */
function shouldIncludeHeartbeatGuidanceForSystemPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  defaultAgentId?: string;
}): boolean {
  const heartbeatSharedAcrossAgents = params.config
    ? isHeartbeatSharedAcrossAgents(params.config)
    : false;
  const defaultAgentId = params.defaultAgentId ?? tryResolveHeartbeatOwnerAgentId(params.config);
  const agentId = params.agentId ?? defaultAgentId;
  const explicitlyEnrolledAgent =
    params.config && agentId
      ? isAgentExplicitlyEnrolledForHeartbeat(params.config, agentId)
      : false;
  if (
    !agentId ||
    (!explicitlyEnrolledAgent &&
      !heartbeatSharedAcrossAgents &&
      normalizeAgentId(agentId) !== normalizeAgentId(defaultAgentId))
  ) {
    return false;
  }
  if (params.config && !isHeartbeatEnabledByAgentPolicy(params.config, agentId)) {
    return false;
  }
  const heartbeat = resolveHeartbeatConfigForSystemPrompt(params.config, agentId);
  return isHeartbeatCadenceEnabled(heartbeat);
}

/** Resolves the heartbeat system prompt section for the selected/default agent. */
export function resolveHeartbeatPromptForSystemPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  defaultAgentId?: string;
}): string | undefined {
  const agentId =
    params.agentId ?? params.defaultAgentId ?? tryResolveHeartbeatOwnerAgentId(params.config);
  if (!agentId) {
    return undefined;
  }
  const heartbeat = resolveHeartbeatConfigForSystemPrompt(params.config, agentId);
  if (!shouldIncludeHeartbeatGuidanceForSystemPrompt(params)) {
    return undefined;
  }
  const prompt = resolveHeartbeatPromptText(heartbeat?.prompt);
  return prompt.includes(HEARTBEAT_CRON_TASK_GUIDANCE)
    ? prompt
    : `${prompt} ${HEARTBEAT_CRON_TASK_GUIDANCE}`;
}
