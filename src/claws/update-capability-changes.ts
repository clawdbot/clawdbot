// Builds field-level capability change summaries for Claw update previews.
import { createHash } from "node:crypto";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { stableStringify } from "../agents/stable-stringify.js";
import { expandToolGroups, resolveToolProfilePolicy } from "../agents/tool-policy-shared.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { resolveRememberAcrossConversations } from "../memory-host-sdk/host/config-utils.js";

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

function rankedValue(value: unknown, rank: Record<string, number>): number {
  return typeof value === "string" ? (rank[value] ?? 0) : 0;
}

function compareRankedCapability(
  current: unknown,
  desired: unknown,
  rank: Record<string, number>,
): ClawUpdateCapabilityChange["classification"] {
  const currentRank = rankedValue(current, rank);
  const desiredRank = rankedValue(desired, rank);
  return desiredRank > currentRank
    ? "escalation"
    : desiredRank < currentRank
      ? "reduction"
      : "neutral";
}

function classifyToolSet(
  current: unknown,
  desired: unknown,
): ClawUpdateCapabilityChange["classification"] {
  if (!Array.isArray(current) || !Array.isArray(desired)) {
    return "neutral";
  }
  const currentTools = new Set(
    current.filter((value): value is string => typeof value === "string"),
  );
  const desiredTools = new Set(
    desired.filter((value): value is string => typeof value === "string"),
  );
  if (currentTools.has("*") !== desiredTools.has("*")) {
    return desiredTools.has("*") ? "escalation" : "reduction";
  }
  if (desiredTools.has("*")) {
    return "neutral";
  }
  if ([...desiredTools].some((tool) => !currentTools.has(tool))) {
    return "escalation";
  }
  return [...currentTools].some((tool) => !desiredTools.has(tool)) ? "reduction" : "neutral";
}

function classifyHeartbeatEvery(
  current: unknown,
  desired: unknown,
): ClawUpdateCapabilityChange["classification"] {
  const toInterval = (value: unknown): number | undefined => {
    if (value === "disabled") {
      return 0;
    }
    if (typeof value !== "string") {
      return undefined;
    }
    try {
      return Math.max(0, parseDurationMs(value, { defaultUnit: "m" }));
    } catch {
      return undefined;
    }
  };
  const currentMs = toInterval(current);
  const desiredMs = toInterval(desired);
  if (currentMs === undefined || desiredMs === undefined || currentMs === desiredMs) {
    return "neutral";
  }
  if (currentMs === 0) {
    return "escalation";
  }
  if (desiredMs === 0) {
    return "reduction";
  }
  return desiredMs < currentMs ? "escalation" : "reduction";
}

function classifyAgentCapability(
  path: string,
  current: unknown,
  desired: unknown,
  currentAgentExists: boolean,
): ClawUpdateCapabilityChange["classification"] {
  if (path === "tools.profile" || path === "tools.allow" || path === "tools.deny") {
    if (!currentAgentExists && desired !== undefined) {
      return "escalation";
    }
    if (desired === undefined) {
      return "escalation";
    }
    if (current === undefined) {
      return "reduction";
    }
  }
  if (path === "tools.alsoAllow") {
    if (!currentAgentExists && desired !== undefined) {
      return "escalation";
    }
    if (desired === undefined) {
      return "reduction";
    }
    if (current === undefined) {
      return "escalation";
    }
  }
  if (desired === undefined) {
    return "reduction";
  }
  if (current === undefined) {
    return "escalation";
  }
  if (path === "sandbox.workspaceAccess") {
    const rank = { none: 0, ro: 1, rw: 2 } as Record<string, number>;
    return compareRankedCapability(current, desired, rank);
  }
  if (path === "sandbox.mode") {
    const rank = { all: 0, "non-main": 1, off: 2 } as Record<string, number>;
    return compareRankedCapability(current, desired, rank);
  }
  if (path === "sandbox.scope") {
    const rank = { session: 0, agent: 1, shared: 2 } as Record<string, number>;
    return compareRankedCapability(current, desired, rank);
  }
  if (path === "heartbeat.every") {
    return classifyHeartbeatEvery(current, desired);
  }
  if (path === "heartbeat.isolatedSession" || path === "heartbeat.skipWhenBusy") {
    return desired === true ? "reduction" : "escalation";
  }
  if (path === "heartbeat.timeoutSeconds") {
    return typeof current === "number" && typeof desired === "number" && desired < current
      ? "reduction"
      : "escalation";
  }
  if (path === "tools.fs.workspaceOnly") {
    return desired === true ? "reduction" : "escalation";
  }
  if (path === "memory.search.enabled") {
    return desired === false ? "reduction" : "escalation";
  }
  if (path === "memory.search.rememberAcrossConversations") {
    return desired === true ? "escalation" : "reduction";
  }
  if (path === "memory.search.sources") {
    if (!Array.isArray(current) || !Array.isArray(desired)) {
      return desired === undefined ? "reduction" : "escalation";
    }
    const currentSources = new Set(current);
    return desired.some((source) => !currentSources.has(source)) ? "escalation" : "reduction";
  }
  if (path === "tools.deny") {
    if (!Array.isArray(current) || !Array.isArray(desired)) {
      return "escalation";
    }
    const desiredTools = new Set(
      desired.filter((value): value is string => typeof value === "string"),
    );
    if (current.some((value) => typeof value === "string" && !desiredTools.has(value))) {
      return "escalation";
    }
    const currentTools = new Set(
      current.filter((value): value is string => typeof value === "string"),
    );
    return desired.some((value) => typeof value === "string" && !currentTools.has(value))
      ? "reduction"
      : "neutral";
  }
  if (
    (path === "tools.profile" || path === "tools.allow" || path === "tools.alsoAllow") &&
    Array.isArray(current) &&
    Array.isArray(desired)
  ) {
    return classifyToolSet(current, desired);
  }
  return path.startsWith("sandbox.") ||
    path.startsWith("tools.") ||
    path.startsWith("heartbeat.") ||
    path.startsWith("memory.search.")
    ? "escalation"
    : "neutral";
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
    ["heartbeat", "skipWhenBusy"],
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

function resolveHeartbeat(config: OpenClawConfig, agentId: string): unknown {
  const defaults = config.agents?.defaults?.heartbeat;
  const overrides = config.agents?.list?.find((agent) => agent.id === agentId)?.heartbeat;
  return {
    ...defaults,
    ...overrides,
    every: resolveHeartbeatSummaryForAgent(config, agentId).every,
  };
}

function resolvePortableTools(config: OpenClawConfig, agentId: string): unknown {
  const globalTools = config.tools;
  const agentTools = config.agents?.list?.find((agent) => agent.id === agentId)?.tools;
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
  const overrides = config.agents?.list?.find((agent) => agent.id === agentId)?.memory?.search;
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

export function pushResolvedAgentCapabilityChanges(params: {
  changes: ClawUpdateCapabilityChange[];
  agentId: string;
  config: OpenClawConfig;
  desiredAgent: AgentConfig;
}): void {
  const currentAgents = params.config.agents?.list ?? [];
  const currentIndex = currentAgents.findIndex((agent) => agent.id === params.agentId);
  const currentAgent = currentIndex === -1 ? undefined : currentAgents[currentIndex];
  const desiredAgents = [...currentAgents];
  if (currentIndex === -1) {
    desiredAgents.push(params.desiredAgent);
  } else {
    desiredAgents[currentIndex] = params.desiredAgent;
  }
  const desiredConfig: OpenClawConfig = {
    ...params.config,
    agents: {
      ...params.config.agents,
      list: desiredAgents,
    },
  };
  pushAgentCapabilityChanges({
    changes: params.changes,
    agentId: params.agentId,
    currentAgent,
    desiredAgent: params.desiredAgent,
    currentSandbox: currentAgent
      ? resolveSandboxConfigForAgent(params.config, params.agentId)
      : undefined,
    desiredSandbox: resolveSandboxConfigForAgent(desiredConfig, params.agentId),
    currentHeartbeat: currentAgent ? resolveHeartbeat(params.config, params.agentId) : undefined,
    desiredHeartbeat: resolveHeartbeat(desiredConfig, params.agentId),
    currentMemorySearch: currentAgent
      ? resolvePortableMemorySearch(params.config, params.agentId)
      : undefined,
    desiredMemorySearch: resolvePortableMemorySearch(desiredConfig, params.agentId),
    currentTools: currentAgent ? resolvePortableTools(params.config, params.agentId) : undefined,
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
    },
    ...(params.currentVersion
      ? {
          current: capabilityValue(`version ${params.currentVersion}`),
        }
      : {}),
    ...(params.desiredVersion
      ? {
          desired: capabilityValue(`version ${params.desiredVersion}`),
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
