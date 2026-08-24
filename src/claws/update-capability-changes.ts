// Builds field-level capability change summaries for Claw update previews.
import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { expandToolGroups, resolveToolProfilePolicy } from "../agents/tool-policy-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { resolveRememberAcrossConversations } from "../memory-host-sdk/host/config-utils.js";
import { classifyAgentCapability } from "./agent-capability-rules.js";
import { resolveClawToolProfileSnapshot } from "./tool-profile-consent.js";

type ClawUpdateCapabilityValue = {
  summary: string;
  digest: string;
};

export type ClawUpdateCapabilityChange = {
  kind: "agent" | "package" | "mcpServer" | "cronJob";
  id: string;
  path: string;
  action: "add" | "change" | "remove" | "release" | "unchanged" | "manual";
  classification: "escalation" | "reduction" | "neutral";
  requiresDistinctConsent: boolean;
  reason: string;
  effect: Record<string, unknown>;
  current?: ClawUpdateCapabilityValue;
  desired?: ClawUpdateCapabilityValue;
};

function capabilityValue(
  summary: string,
  digestSource: unknown = summary,
): ClawUpdateCapabilityValue {
  return {
    summary,
    digest: `sha256:${createHash("sha256").update(stableStringify(digestSource)).digest("hex")}`,
  };
}

function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function summarizeAgentCapability(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : stableStringify(value);
}

function resolveProfileCapabilities(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const policy = resolveToolProfilePolicy(value);
  return policy?.allow ? expandToolGroups(policy.allow).toSorted() : value;
}

function pushAgentCapabilityChanges(params: {
  changes: ClawUpdateCapabilityChange[];
  agentId: string;
  currentAgent: unknown;
  desiredAgent: unknown;
  currentSandbox?: unknown;
  desiredSandbox?: unknown;
  currentHeartbeat?: unknown;
  desiredHeartbeat?: unknown;
  currentMemorySearch?: unknown;
  desiredMemorySearch?: unknown;
  currentTools?: unknown;
  desiredTools?: unknown;
}): void {
  const fields = [
    ["sandbox", "mode"],
    ["sandbox", "scope"],
    ["sandbox", "workspaceAccess"],
    ["tools", "profile"],
    ["tools", "allow"],
    ["tools", "alsoAllow"],
    ["tools", "deny"],
    ["tools", "fs", "workspaceOnly"],
    ["memory", "search", "enabled"],
    ["memory", "search", "rememberAcrossConversations"],
    ["memory", "search", "sources"],
    ["heartbeat", "every"],
    ["heartbeat", "activeHours"],
    ["heartbeat", "isolatedSession"],
    ["heartbeat", "timeoutSeconds"],
  ] as const;
  for (const field of fields) {
    const sandboxField = field[0] === "sandbox" ? field.slice(1) : undefined;
    const heartbeatField = field[0] === "heartbeat" ? field.slice(1) : undefined;
    const memorySearchField =
      field[0] === "memory" && field[1] === "search" ? field.slice(2) : undefined;
    const effectiveToolField =
      field[0] === "tools" &&
      (field[1] === "profile" || field[1] === "alsoAllow" || field[1] === "fs")
        ? field.slice(1)
        : undefined;
    const currentValue = sandboxField
      ? getPath(params.currentSandbox, sandboxField)
      : heartbeatField
        ? getPath(params.currentHeartbeat, heartbeatField)
        : memorySearchField
          ? getPath(params.currentMemorySearch, memorySearchField)
          : effectiveToolField
            ? getPath(params.currentTools, effectiveToolField)
            : getPath(params.currentAgent, field);
    const desiredValue = sandboxField
      ? getPath(params.desiredSandbox, sandboxField)
      : heartbeatField
        ? getPath(params.desiredHeartbeat, heartbeatField)
        : memorySearchField
          ? getPath(params.desiredMemorySearch, memorySearchField)
          : effectiveToolField
            ? getPath(params.desiredTools, effectiveToolField)
            : getPath(params.desiredAgent, field);
    const profileField = field[0] === "tools" && field[1] === "profile";
    const current = profileField ? resolveProfileCapabilities(currentValue) : currentValue;
    const desired = profileField ? resolveProfileCapabilities(desiredValue) : desiredValue;
    if (sameValue(current, desired)) {
      continue;
    }
    const path = field.join(".");
    const classification = classifyAgentCapability(
      path,
      current,
      desired,
      params.currentAgent !== undefined,
    );
    params.changes.push({
      kind: "agent",
      id: params.agentId,
      path: `agent.${path}`,
      action: "change",
      classification,
      requiresDistinctConsent: classification === "escalation",
      reason: `Agent capability field ${path} changes in the target manifest.`,
      effect: profileField
        ? {
            path,
            current: currentValue,
            desired: desiredValue,
            currentCapabilities: current,
            desiredCapabilities: desired,
          }
        : { path, current, desired },
      ...(currentValue === undefined
        ? {}
        : {
            current: capabilityValue(
              summarizeAgentCapability(currentValue),
              profileField ? { value: currentValue, resolvedCapabilities: current } : current,
            ),
          }),
      ...(desiredValue === undefined
        ? {}
        : {
            desired: capabilityValue(
              summarizeAgentCapability(desiredValue),
              profileField ? { value: desiredValue, resolvedCapabilities: desired } : desired,
            ),
          }),
    });
  }
}

type AgentConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

function normalizeLegacyAgent(
  config: OpenClawConfig,
  currentAgent: AgentConfig,
  desiredAgent: AgentConfig,
): AgentConfig {
  const tools = currentAgent.tools;
  if (!tools?.profile || desiredAgent.tools?.profile !== "full" || !desiredAgent.tools.allow) {
    return currentAgent;
  }
  const snapshot = resolveClawToolProfileSnapshot({
    ...tools,
    alsoAllow: (
      resolvePortableTools(config, currentAgent.id) as {
        alsoAllow?: string[];
      }
    ).alsoAllow,
  });
  if (!snapshot) {
    return currentAgent;
  }
  const {
    profile: _profile,
    allow: _allow,
    alsoAllow: _alsoAllow,
    deny: _deny,
    ...otherTools
  } = tools;
  return {
    ...currentAgent,
    tools: {
      ...otherTools,
      profile: "full",
      ...(snapshot.allow.length > 0 ? { allow: snapshot.allow } : {}),
      ...(snapshot.deny.length > 0 ? { deny: snapshot.deny } : {}),
    },
  };
}

function resolveHeartbeat(config: OpenClawConfig, agentId: string): unknown {
  const defaults = config.agents?.defaults?.heartbeat;
  const overrides = listAgentEntries(config).find((agent) => agent.id === agentId)?.heartbeat;
  return {
    ...defaults,
    ...overrides,
    every: resolveHeartbeatSummaryForAgent(config, agentId).every,
  };
}

function resolvePortableTools(config: OpenClawConfig, agentId: string): unknown {
  const globalTools = config.tools;
  const agentTools = listAgentEntries(config).find((agent) => agent.id === agentId)?.tools;
  return {
    profile: agentTools?.profile ?? globalTools?.profile,
    alsoAllow: agentTools?.alsoAllow ?? globalTools?.alsoAllow,
    fs: {
      workspaceOnly: agentTools?.fs?.workspaceOnly ?? globalTools?.fs?.workspaceOnly ?? false,
    },
  };
}

function resolvePortableMemorySearch(config: OpenClawConfig, agentId: string): unknown {
  const defaults = config.memory?.search;
  const overrides = listAgentEntries(config).find((agent) => agent.id === agentId)?.memory?.search;
  const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
  const rememberAcrossConversations = resolveRememberAcrossConversations(config, agentId);
  const sessionMemory =
    rememberAcrossConversations ||
    (overrides?.experimental?.sessionMemory ?? defaults?.experimental?.sessionMemory ?? false);
  const configuredSources = overrides?.sources ?? defaults?.sources ?? ["memory"];
  const sources = new Set<"memory" | "sessions">();
  for (const source of configuredSources) {
    if (source === "memory" || (source === "sessions" && sessionMemory)) {
      sources.add(source);
    }
  }
  if (rememberAcrossConversations) {
    sources.add("sessions");
  }
  if (sources.size === 0) {
    sources.add("memory");
  }
  return { enabled, rememberAcrossConversations, sources: [...sources].toSorted() };
}

function prepareCapabilityComparisonConfig(
  config: OpenClawConfig,
  entries: AgentConfig[],
  preferredDefaultAgentId: string,
): OpenClawConfig {
  const hasDefault = entries.some((entry) => entry.default === true);
  const comparisonEntries = hasDefault
    ? entries
    : entries.map((entry) =>
        entry.id === preferredDefaultAgentId ? { ...entry, default: true } : entry,
      );
  const { list: _legacyList, ...agents } = config.agents ?? {};
  return {
    ...config,
    agents: { ...agents, entries: toAgentEntriesRecord(comparisonEntries) },
  };
}
export function pushResolvedAgentCapabilityChanges(params: {
  changes: ClawUpdateCapabilityChange[];
  agentId: string;
  config: OpenClawConfig;
  desiredAgent: AgentConfig;
}): void {
  const currentAgents = listAgentEntries(params.config);
  const currentIndex = currentAgents.findIndex((agent) => agent.id === params.agentId);
  const existingCurrentAgent = currentIndex === -1 ? undefined : currentAgents[currentIndex];
  const currentAgent = existingCurrentAgent
    ? normalizeLegacyAgent(params.config, existingCurrentAgent, params.desiredAgent)
    : undefined;
  const comparisonAgents = [...currentAgents];
  if (currentAgent && currentIndex !== -1) {
    comparisonAgents[currentIndex] = currentAgent;
  }
  const desiredAgents = [...currentAgents];
  if (currentIndex === -1) {
    desiredAgents.push(params.desiredAgent);
  } else {
    desiredAgents[currentIndex] = params.desiredAgent;
  }
  const currentConfig = prepareCapabilityComparisonConfig(
    params.config,
    comparisonAgents,
    params.agentId,
  );
  const desiredConfig = prepareCapabilityComparisonConfig(
    params.config,
    desiredAgents,
    params.agentId,
  );
  pushAgentCapabilityChanges({
    changes: params.changes,
    agentId: params.agentId,
    currentAgent,
    desiredAgent: params.desiredAgent,
    currentSandbox: currentAgent
      ? resolveSandboxConfigForAgent(currentConfig, params.agentId)
      : undefined,
    desiredSandbox: resolveSandboxConfigForAgent(desiredConfig, params.agentId),
    currentHeartbeat: currentAgent ? resolveHeartbeat(currentConfig, params.agentId) : undefined,
    desiredHeartbeat: resolveHeartbeat(desiredConfig, params.agentId),
    currentMemorySearch: currentAgent
      ? resolvePortableMemorySearch(params.config, params.agentId)
      : undefined,
    desiredMemorySearch: resolvePortableMemorySearch(desiredConfig, params.agentId),
    currentTools: currentAgent ? resolvePortableTools(currentConfig, params.agentId) : undefined,
    desiredTools: resolvePortableTools(desiredConfig, params.agentId),
  });
}

export function packageCapabilityChange(params: {
  pkg: { kind: string; ref: string; version: string };
  action: ClawUpdateCapabilityChange["action"];
  currentVersion?: string;
  desiredVersion?: string;
  integrity?: string;
  installId?: string;
  riskWarning?: string;
  currentExtension?: unknown;
  desiredExtension?: unknown;
}): ClawUpdateCapabilityChange | undefined {
  if (params.pkg.kind !== "plugin" || params.action === "unchanged") {
    return undefined;
  }
  const reduction = params.desiredVersion === undefined;
  return {
    kind: "package",
    id: `plugin:${params.pkg.ref}`,
    path: `packages.plugin.${params.pkg.ref}`,
    action: params.action,
    classification: reduction ? "reduction" : "escalation",
    requiresDistinctConsent: !reduction,
    reason: reduction
      ? "Target manifest removes or releases plugin executable code."
      : "Target manifest adds or changes plugin executable code.",
    effect: {
      kind: params.pkg.kind,
      ref: params.pkg.ref,
      ...(params.desiredVersion ? { version: params.desiredVersion } : {}),
      ...(params.integrity ? { integrity: params.integrity } : {}),
      ...(params.installId ? { installId: params.installId } : {}),
      ...(params.riskWarning ? { riskWarning: params.riskWarning } : {}),
      ...(params.desiredExtension ? { extension: params.desiredExtension } : {}),
    },
    ...(params.currentVersion
      ? {
          current: capabilityValue(
            `version ${params.currentVersion}${params.currentExtension ? "; extension mapping recorded" : ""}`,
            {
              version: params.currentVersion,
              extension: params.currentExtension,
            },
          ),
        }
      : {}),
    ...(params.desiredVersion
      ? {
          desired: capabilityValue(
            `version ${params.desiredVersion}${params.desiredExtension ? "; extension mapping updated" : ""}`,
            {
              version: params.desiredVersion,
              extension: params.desiredExtension,
            },
          ),
        }
      : {}),
  };
}

function summarizeMcpCapability(server: unknown): string {
  if (!server || typeof server !== "object") {
    return "not configured";
  }
  const value = server as Record<string, unknown>;
  const summary: string[] = [];
  if (typeof value.command === "string") {
    summary.push(`local process (${Array.isArray(value.args) ? value.args.length : 0} args)`);
  } else if (typeof value.url === "string") {
    summary.push("remote server");
  } else {
    summary.push("configured server");
  }
  if (value.auth !== undefined) {
    summary.push("auth configured");
  }
  if (value.toolFilter !== undefined) {
    summary.push("tool filter configured");
  }
  if (value.env && typeof value.env === "object") {
    summary.push(`${Object.keys(value.env).length} env entries`);
  }
  return summary.join("; ");
}

function summarizeMcpCapabilityEffect(server: unknown): Record<string, unknown> {
  if (!server || typeof server !== "object") {
    return { configured: false };
  }
  const value = server as Record<string, unknown>;
  return {
    connection:
      typeof value.command === "string"
        ? "local-process"
        : typeof value.url === "string"
          ? "remote-server"
          : "configured-server",
    ...(typeof value.transport === "string" ? { transport: value.transport } : {}),
    ...(typeof value.command === "string"
      ? {
          commandConfigured: true,
          argumentCount: Array.isArray(value.args) ? value.args.length : 0,
        }
      : {}),
    ...(value.auth !== undefined ? { authConfigured: true } : {}),
    ...(value.toolFilter !== undefined ? { toolFilterConfigured: true } : {}),
    ...(value.env && typeof value.env === "object"
      ? { envEntryCount: Object.keys(value.env).length }
      : {}),
  };
}

export function mcpCapabilityChange(params: {
  id: string;
  action: ClawUpdateCapabilityChange["action"];
  current?: unknown;
  desired?: unknown;
}): ClawUpdateCapabilityChange | undefined {
  if (params.action === "unchanged") {
    return undefined;
  }
  const reduction = params.desired === undefined;
  return {
    kind: "mcpServer",
    id: params.id,
    path: `mcpServers.${params.id}`,
    action: params.action,
    classification: reduction ? "reduction" : "escalation",
    requiresDistinctConsent: !reduction,
    reason: reduction
      ? "Target manifest removes or releases an MCP tool surface."
      : "Target manifest adds, restores, or changes an MCP tool surface.",
    effect:
      params.desired === undefined
        ? { removed: true }
        : summarizeMcpCapabilityEffect(params.desired),
    ...(params.current === undefined
      ? {}
      : {
          current: capabilityValue(summarizeMcpCapability(params.current), params.current),
        }),
    ...(params.desired === undefined
      ? {}
      : {
          desired: capabilityValue(summarizeMcpCapability(params.desired), params.desired),
        }),
  };
}

function summarizeCronCapability(cron: unknown): string {
  if (!cron || typeof cron !== "object") {
    return "not configured";
  }
  const value = cron as Record<string, unknown>;
  const schedule = value.schedule as Record<string, unknown> | undefined;
  const scheduleKind = schedule
    ? (Object.keys(schedule).find((key) => key !== "timezone") ?? "configured")
    : "configured";
  return `schedule ${scheduleKind}; session ${typeof value.session === "string" ? value.session : "default"}; payload withheld`;
}

function summarizeCronCapabilityEffect(cron: unknown): Record<string, unknown> {
  if (!cron || typeof cron !== "object") {
    return { configured: false };
  }
  const value = cron as Record<string, unknown>;
  const schedule = value.schedule as Record<string, unknown> | undefined;
  return {
    schedule:
      schedule && typeof schedule === "object"
        ? (Object.keys(schedule).find((key) => key !== "timezone") ?? "configured")
        : "configured",
    timezoneConfigured: typeof schedule?.timezone === "string",
    session: typeof value.session === "string" ? value.session : "default",
    deliveryConfigured: value.delivery !== undefined,
    payloadWithheld: true,
  };
}

export function cronCapabilityChange(params: {
  id: string;
  action: ClawUpdateCapabilityChange["action"];
  current?: unknown;
  desired?: unknown;
}): ClawUpdateCapabilityChange | undefined {
  if (params.action === "unchanged") {
    return undefined;
  }
  const reduction = params.desired === undefined;
  return {
    kind: "cronJob",
    id: params.id,
    path: `cronJobs.${params.id}`,
    action: params.action,
    classification: reduction ? "reduction" : "escalation",
    requiresDistinctConsent: !reduction,
    reason: reduction
      ? "Target manifest removes a scheduled automation."
      : "Target manifest adds, restores, or changes a scheduled automation.",
    effect:
      params.desired === undefined
        ? { removed: true }
        : summarizeCronCapabilityEffect(params.desired),
    ...(params.current === undefined
      ? {}
      : {
          current: capabilityValue(summarizeCronCapability(params.current), params.current),
        }),
    ...(params.desired === undefined
      ? {}
      : {
          desired: capabilityValue(summarizeCronCapability(params.desired), params.desired),
        }),
  };
}
