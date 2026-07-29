// Doctor checks for context engine host requirements against configured agent runtimes.
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeEmbeddedAgentRuntime } from "../../../agents/agent-runtime-id.js";
import {
  listAgentEntriesWithSource,
  resolveDefaultAgentDir,
} from "../../../agents/agent-scope-config.js";
import { resolveCliBackendConfig } from "../../../agents/cli-backends.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { resolveAgentHarnessPolicy } from "../../../agents/harness/policy.js";
import { getRegisteredAgentHarness } from "../../../agents/harness/registry.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  buildGenericCliContextEngineHostSupport,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  evaluateContextEngineHostSupport,
  OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
  type ContextEngineHostSupport,
} from "../../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../../context-engine/init.js";
import {
  getContextEngineRegistration,
  resolveContextEngine,
} from "../../../context-engine/registry.js";
import type { ContextEngineInfo } from "../../../context-engine/types.js";
import { ensurePluginRegistryLoaded } from "../../../plugins/runtime/runtime-registry-loader.js";
import { defaultSlotIdForKey } from "../../../plugins/slots.js";
import { isRecord, resolveUserPath } from "../../../utils.js";

type HostCandidate = {
  /** Runtime or harness id that will host an agent run. */
  runtimeId: string;
  /** Context-engine host capability descriptor for the runtime. */
  host: ContextEngineHostSupport;
  /** Config paths that caused doctor to consider this host. */
  paths: string[];
};

type HostCompatibilityIssue = {
  candidate: HostCandidate;
  missingCapabilities: string[];
  requiredCapabilities: string[];
};

type ContextEngineInfoResult =
  | { info: ContextEngineInfo; warnings: [] }
  | { info?: undefined; warnings: string[] };

function normalizeRuntimeId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeEmbeddedAgentRuntime(value.trim().toLowerCase());
  return normalized || undefined;
}

function parseModelRef(value: unknown): { provider: string; modelId: string } | undefined {
  return typeof value === "string" ? (parseModelCatalogRef(value) ?? undefined) : undefined;
}

function listModelRefs(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (!isRecord(value)) {
    return [];
  }
  const refs: string[] = [];
  if (typeof value.primary === "string" && value.primary.trim()) {
    refs.push(value.primary.trim());
  }
  if (Array.isArray(value.fallbacks)) {
    for (const fallback of value.fallbacks) {
      if (typeof fallback === "string" && fallback.trim()) {
        refs.push(fallback.trim());
      }
    }
  }
  return refs;
}

function collectExplicitRuntimeRefs(
  cfg: OpenClawConfig,
): Array<{ runtimeId: string; path: string }> {
  const refs: Array<{ runtimeId: string; path: string }> = [];
  const push = (runtime: unknown, path: string) => {
    const runtimeId = normalizeRuntimeId(runtime);
    if (runtimeId && runtimeId !== "default") {
      refs.push({ runtimeId, path });
    }
  };

  for (const [providerId, providerConfig] of Object.entries(cfg.models?.providers ?? {})) {
    push(providerConfig?.agentRuntime?.id, `models.providers.${providerId}.agentRuntime.id`);
    providerConfig?.models?.forEach((modelConfig, index) => {
      push(
        modelConfig?.agentRuntime?.id,
        `models.providers.${providerId}.models[${index}].agentRuntime.id`,
      );
    });
  }

  for (const [modelRef, modelConfig] of Object.entries(cfg.agents?.defaults?.models ?? {})) {
    push(modelConfig?.agentRuntime?.id, `agents.defaults.models.${modelRef}.agentRuntime.id`);
  }

  for (const { entry: agent, source } of listAgentEntriesWithSource(cfg)) {
    const path =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`;
    for (const [modelRef, modelConfig] of Object.entries(agent.models ?? {})) {
      push(modelConfig?.agentRuntime?.id, `${path}.models.${modelRef}.agentRuntime.id`);
    }
  }

  return refs;
}

function collectSelectedModelRefs(
  cfg: OpenClawConfig,
): Array<{ modelRef: string; path: string; agentId?: string }> {
  const refs: Array<{ modelRef: string; path: string; agentId?: string }> = [];
  const pushModel = (value: unknown, path: string, agentId?: string) => {
    for (const modelRef of listModelRefs(value)) {
      refs.push({ modelRef, path, ...(agentId ? { agentId } : {}) });
    }
  };
  const pushModelMap = (models: unknown, path: string, agentId?: string) => {
    if (!isRecord(models)) {
      return;
    }
    for (const modelRef of Object.keys(models)) {
      refs.push({ modelRef, path: `${path}.${modelRef}`, ...(agentId ? { agentId } : {}) });
    }
  };

  if (cfg.agents?.defaults?.model !== undefined) {
    pushModel(cfg.agents.defaults.model, "agents.defaults.model");
  } else {
    refs.push({
      modelRef: `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`,
      path: "agents.defaults.model (default)",
    });
  }
  pushModelMap(cfg.agents?.defaults?.models, "agents.defaults.models");

  for (const { entry: agent, source } of listAgentEntriesWithSource(cfg)) {
    const agentId = agent.id;
    const path =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`;
    pushModel(agent.model ?? cfg.agents?.defaults?.model, `${path}.model`, agentId);
    pushModelMap(agent.models, `${path}.models`, agentId);
  }

  return refs;
}

function runtimeHostCandidate(params: {
  cfg: OpenClawConfig;
  runtimeId: string;
  paths: string[];
}): HostCandidate {
  const runtimeId = normalizeRuntimeId(params.runtimeId) ?? params.runtimeId;
  if (runtimeId === "openclaw" || runtimeId === "auto") {
    return { runtimeId, host: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST, paths: params.paths };
  }
  if (runtimeId === "codex") {
    return { runtimeId, host: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST, paths: params.paths };
  }

  const harness = getRegisteredAgentHarness(runtimeId)?.harness;
  if (harness) {
    return {
      runtimeId,
      host: {
        id: `harness:${harness.id}`,
        label: `${harness.label} harness`,
        capabilities: harness.contextEngineHostCapabilities ?? [],
      },
      paths: params.paths,
    };
  }

  const cliBackend = resolveCliBackendConfig(runtimeId, params.cfg);
  return {
    runtimeId,
    host: buildGenericCliContextEngineHostSupport({
      backendId: cliBackend?.id ?? runtimeId,
      capabilities: cliBackend?.contextEngineHostCapabilities,
    }),
    paths: params.paths,
  };
}

/** Collect effective agent-run host candidates from provider/model runtime policy. */
function collectConfiguredContextEngineAgentRunHosts(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): HostCandidate[] {
  const runtimePaths = new Map<string, string[]>();
  const push = (runtimeId: string | undefined, path: string) => {
    if (!runtimeId) {
      return;
    }
    const normalized = normalizeRuntimeId(runtimeId) ?? runtimeId;
    const paths = runtimePaths.get(normalized) ?? [];
    paths.push(path);
    runtimePaths.set(normalized, paths);
  };

  for (const ref of collectExplicitRuntimeRefs(params.cfg)) {
    push(ref.runtimeId, ref.path);
  }
  for (const model of collectSelectedModelRefs(params.cfg)) {
    const parsed = parseModelRef(model.modelRef);
    if (!parsed) {
      continue;
    }
    const policy = resolveAgentHarnessPolicy({
      config: params.cfg,
      provider: parsed.provider,
      modelId: parsed.modelId,
      agentId: model.agentId,
    });
    push(policy.runtime, model.path);
  }

  return [...runtimePaths.entries()].map(([runtimeId, paths]) =>
    runtimeHostCandidate({ cfg: params.cfg, runtimeId, paths }),
  );
}

function selectedContextEngineSlotId(cfg: OpenClawConfig): string {
  const slotValue = cfg.plugins?.slots?.contextEngine;
  return typeof slotValue === "string" && slotValue.trim()
    ? slotValue.trim()
    : defaultSlotIdForKey("contextEngine");
}

async function resolveSelectedContextEngineInfo(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<ContextEngineInfoResult> {
  const engineId = selectedContextEngineSlotId(params.cfg);
  const defaultEngineId = defaultSlotIdForKey("contextEngine");
  if (engineId === defaultEngineId || engineId === "none") {
    return { info: { id: engineId, name: engineId }, warnings: [] };
  }

  ensureContextEnginesInitialized();
  if (getContextEngineRegistration(engineId)?.lifecycle !== "runtime") {
    try {
      ensurePluginRegistryLoaded({
        scope: "all",
        config: params.cfg,
        env: params.env,
        onlyPluginIds: [engineId],
      });
    } catch (error) {
      if (getContextEngineRegistration(engineId)?.lifecycle !== "runtime") {
        const message = error instanceof Error ? error.message : String(error);
        return {
          warnings: [
            `- plugins.slots.contextEngine: could not inspect context engine "${engineId}" host requirements because its plugin failed to load: ${message}`,
          ],
        };
      }
    }
    if (getContextEngineRegistration(engineId)?.lifecycle !== "runtime") {
      return {
        warnings: [
          `- plugins.slots.contextEngine: could not inspect context engine "${engineId}" host requirements because it is not registered.`,
        ],
      };
    }
  }

  try {
    const engine = await resolveContextEngine(params.cfg, {
      agentDir: resolveDefaultAgentDir(params.cfg, params.env),
      workspaceDir: params.cfg.agents?.defaults?.workspace
        ? resolveUserPath(params.cfg.agents.defaults.workspace, params.env)
        : undefined,
    });
    return { info: engine.info, warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      warnings: [
        `- plugins.slots.contextEngine: could not inspect context engine "${engineId}" host requirements: ${message}`,
      ],
    };
  }
}

function collectHostCompatibilityIssues(params: {
  info: ContextEngineInfo;
  hosts: HostCandidate[];
}): HostCompatibilityIssue[] {
  return params.hosts.flatMap((candidate) => {
    const evaluation = evaluateContextEngineHostSupport({
      contextEngineInfo: params.info,
      operation: "agent-run",
      host: candidate.host,
    });
    if (evaluation.ok) {
      return [];
    }
    return [
      {
        candidate,
        missingCapabilities: evaluation.missingCapabilities,
        requiredCapabilities: evaluation.requirements.requiredCapabilities,
      },
    ];
  });
}

function formatPaths(paths: string[]): string {
  const unique = uniqueStrings(paths);
  if (unique.length <= 2) {
    return unique.join(", ");
  }
  return `${unique.slice(0, 2).join(", ")}, and ${unique.length - 2} more`;
}

function formatHostCapabilities(capabilities: readonly string[]): string {
  return capabilities.length > 0 ? capabilities.join(", ") : "(none)";
}

function formatCompatibilityWarnings(params: {
  info: ContextEngineInfo;
  issues: HostCompatibilityIssue[];
  hostCount: number;
  doctorFixCommand: string;
}): string[] {
  if (params.issues.length === 0) {
    return [];
  }
  const lines = params.issues.map((issue) => {
    const paths = formatPaths(issue.candidate.paths);
    return (
      `- plugins.slots.contextEngine: context engine "${params.info.id}" is incompatible with ` +
      `${issue.candidate.host.label} (${paths}). ` +
      `Missing host capabilities: ${issue.missingCapabilities.join(", ")}. ` +
      `Required capabilities: ${issue.requiredCapabilities.join(", ")}. ` +
      `Host capabilities: ${formatHostCapabilities(issue.candidate.host.capabilities)}.`
    );
  });
  const incompatibleAllHosts = params.issues.length === params.hostCount;
  lines.push(
    incompatibleAllHosts
      ? `- Run "${params.doctorFixCommand}" to switch plugins.slots.contextEngine to "legacy", or configure a compatible runtime/harness for agent runs.`
      : `- Some configured runtimes support context engine "${params.info.id}" and others do not; doctor will not rewrite the global contextEngine slot automatically. Configure unsupported models to use a compatible runtime/harness or set plugins.slots.contextEngine to "legacy".`,
  );
  return [lines.join("\n")];
}

/** Collect doctor warnings for context engines that cannot run under configured hosts. */
export async function collectContextEngineHostCompatibilityWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const resolved = await resolveSelectedContextEngineInfo(params);
  if (!resolved.info) {
    return resolved.warnings;
  }
  const hosts = collectConfiguredContextEngineAgentRunHosts(params);
  const issues = collectHostCompatibilityIssues({ info: resolved.info, hosts });
  return [
    ...resolved.warnings,
    ...formatCompatibilityWarnings({
      info: resolved.info,
      issues,
      hostCount: hosts.length,
      doctorFixCommand: params.doctorFixCommand,
    }),
  ];
}

/** Repair a globally incompatible context engine by falling back to legacy. */
export async function maybeRepairContextEngineHostCompatibility(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ config: OpenClawConfig; changes: string[]; warnings?: string[] }> {
  const resolved = await resolveSelectedContextEngineInfo(params);
  if (!resolved.info) {
    return { config: params.cfg, changes: [], warnings: resolved.warnings };
  }

  const hosts = collectConfiguredContextEngineAgentRunHosts(params);
  const issues = collectHostCompatibilityIssues({ info: resolved.info, hosts });
  if (issues.length === 0) {
    return { config: params.cfg, changes: [], warnings: resolved.warnings };
  }

  const warnings = formatCompatibilityWarnings({
    info: resolved.info,
    issues,
    hostCount: hosts.length,
    doctorFixCommand: params.doctorFixCommand,
  });
  if (issues.length !== hosts.length) {
    return { config: params.cfg, changes: [], warnings: [...resolved.warnings, ...warnings] };
  }

  const next = structuredClone(params.cfg);
  next.plugins ??= {};
  next.plugins.slots ??= {};
  next.plugins.slots.contextEngine = defaultSlotIdForKey("contextEngine");
  return {
    config: next,
    changes: [
      `Set plugins.slots.contextEngine to "legacy" because context engine "${resolved.info.id}" is incompatible with every configured agent-run host.`,
    ],
    warnings: resolved.warnings,
  };
}
