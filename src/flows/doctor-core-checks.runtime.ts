// Doctor runtime checks inspect tool names, browser residue, and runtime state.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { TOOL_NAME_SEPARATOR } from "../agents/agent-bundle-mcp-names.js";
import {
  type McpToolCatalogDiagnostic,
  createBundleMcpToolRuntime,
} from "../agents/agent-bundle-mcp-tools.js";
import {
  listAgentEntries,
  listAgentIds,
  resolveAgentDir,
  resolveDefaultAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { applyFinalEffectiveToolPolicy } from "../agents/embedded-agent-runner/effective-tool-policy.js";
import { shouldCreateBundleMcpRuntimeForAttempt } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { findModelInCatalog, type ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { supportsModelTools } from "../agents/model-tool-support.js";
import { loadPreparedModelCatalog } from "../agents/prepared-model-catalog.js";
import { normalizeAgentRuntimeTools } from "../agents/runtime-plan/tools.js";
import { collectExplicitAllowlist, normalizeToolName } from "../agents/tool-policy.js";
import {
  inspectRuntimeToolInputSchemas,
  type RuntimeToolSchemaDiagnostic,
} from "../agents/tool-schema-projection.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { probeGatewayStatus } from "../cli/daemon-cli/probe.js";
import { collectUnavailableAgentSkills } from "../commands/doctor-skills-core.js";
import { gatewayProbeResultSawGateway } from "../commands/gateway-health-auth-diagnostic.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getSystemdCgroupHygieneSummary,
  type GatewayServiceRuntime,
} from "../daemon/service-runtime.js";
import { resolveGatewayService, readGatewayServiceState } from "../daemon/service.js";
import { buildGatewayProbeConnectionDetails } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  formatLocalAudioSelection,
  inspectLocalAudioSelection,
} from "../media-understanding/local-audio.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tools.js";
import type { ProviderCatalogOrder, ProviderPlugin } from "../plugins/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { buildWorkspaceSkillStatus, type SkillStatusEntry } from "../skills/discovery/status.js";
import type { HealthCheckContext, HealthFinding } from "./health-checks.js";

type BundleMcpToolRuntime = Awaited<ReturnType<typeof createBundleMcpToolRuntime>>;
const PROVIDER_CATALOG_ORDERS = ["simple", "profile", "paired", "late"] as const;
const PROVIDER_CATALOG_ORDER_SET = new Set<ProviderCatalogOrder>(PROVIDER_CATALOG_ORDERS);

function formatGatewayHealthTarget(url: string): string {
  return redactSensitiveUrlLikeString(url);
}

export function detectUnavailableSkills(cfg: OpenClawConfig): SkillStatusEntry[] {
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const report = buildWorkspaceSkillStatus(workspaceDir, {
    config: cfg,
    agentId,
  });
  return collectUnavailableAgentSkills(report);
}

export async function collectLocalAudioAccelerationFindings(): Promise<readonly HealthFinding[]> {
  const selection = await inspectLocalAudioSelection();
  const available = selection.candidates.filter((candidate) => candidate.available);
  if (available.length === 0) {
    return [];
  }
  const summary = formatLocalAudioSelection(selection);
  if (summary) {
    return [
      {
        checkId: "core/doctor/local-audio-acceleration",
        severity: "info",
        message: `Local STT auto-selection: ${summary}.`,
        path: "tools.media.models",
      },
    ];
  }
  const blockers = available
    .map((candidate) => `${candidate.command}: ${candidate.reason}`)
    .join("; ");
  return [
    {
      checkId: "core/doctor/local-audio-acceleration",
      severity: "info",
      message: `Local STT commands were found but none are ready for auto-selection: ${blockers}.`,
      path: "tools.media.models",
      fixHint:
        "Install the matching local model/runtime, or configure an audio-capable tools.media.models CLI entry.",
    },
  ];
}

export async function collectGatewayHealthFindings(
  ctx: Pick<HealthCheckContext, "cfg" | "configPath">,
): Promise<readonly HealthFinding[]> {
  let probeDetails: Awaited<ReturnType<typeof buildGatewayProbeConnectionDetails>>;
  try {
    probeDetails = await buildGatewayProbeConnectionDetails({
      config: ctx.cfg,
      ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    });
  } catch (error) {
    return [
      {
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: `Gateway health probe could not be prepared: ${formatErrorMessage(error)}`,
        path: ctx.cfg.gateway?.mode === "remote" ? "gateway.remote.url" : "gateway",
        fixHint:
          "Fix Gateway connection configuration, then rerun `openclaw doctor --lint --only core/doctor/gateway-health`.",
      },
    ];
  }

  const probe = await probeGatewayStatus({
    url: probeDetails.url,
    timeoutMs: 3000,
    tlsFingerprint: probeDetails.tlsFingerprint,
    preauthHandshakeTimeoutMs: probeDetails.preauthHandshakeTimeoutMs,
    config: ctx.cfg,
    json: true,
  });
  if (gatewayProbeResultSawGateway(probe)) {
    return [];
  }
  const mode = ctx.cfg.gateway?.mode === "remote" ? "remote" : "local";
  return [
    {
      checkId: "core/doctor/gateway-health",
      severity: "warning",
      message: `Gateway is not reachable: ${probe.error ?? "status probe failed"}`,
      path: mode === "remote" ? "gateway.remote.url" : "gateway.mode",
      target: formatGatewayHealthTarget(probeDetails.url),
      fixHint:
        mode === "remote"
          ? "Verify the remote Gateway URL, network path, TLS settings, and credentials."
          : "Start the Gateway service or run `openclaw doctor --fix` for service repair prompts.",
    },
  ];
}

function gatewayRuntimeStatus(runtime: GatewayServiceRuntime | undefined): string | undefined {
  return runtime?.status ?? runtime?.state ?? runtime?.subState;
}

export async function collectGatewayDaemonFindings(
  ctx: Pick<HealthCheckContext, "cfg">,
): Promise<readonly HealthFinding[]> {
  if (ctx.cfg.gateway?.mode === "remote") {
    return [];
  }
  const service = resolveGatewayService();
  const state = await readGatewayServiceState(service, { env: process.env });
  const findings: HealthFinding[] = [];
  if (!state.installed) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service is not installed.",
      path: "gateway.mode",
      target: service.label,
      fixHint: "Run `openclaw doctor --fix` or `openclaw gateway install` to install it.",
    });
    return findings;
  }
  if (!state.loaded) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service is installed but not loaded.",
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: "Run `openclaw doctor --fix` or `openclaw gateway start` to load it.",
    });
  }
  const status = gatewayRuntimeStatus(state.runtime);
  if (state.loaded && !state.running) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: status
        ? `Gateway service runtime is ${status}, not running.`
        : "Gateway service is loaded but runtime status could not confirm it is running.",
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: "Run `openclaw gateway status --deep` or `openclaw doctor --fix` for repair hints.",
    });
  }
  if (state.runtime?.missingGuiSession) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service cannot attach to the user GUI session.",
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: state.runtime.detail ?? "Log into a GUI session, then rerun doctor.",
    });
  }
  if (state.runtime?.missingSupervision || state.runtime?.missingUnit) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: "Gateway service supervision metadata is missing.",
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: state.runtime.detail ?? "Reinstall or reload the Gateway service.",
    });
  }
  const hygiene = getSystemdCgroupHygieneSummary(state.runtime?.systemd);
  if (hygiene) {
    findings.push({
      checkId: "core/doctor/gateway-daemon",
      severity: "warning",
      message: `Gateway systemd service has risky ${hygiene}.`,
      path: state.command?.sourcePath,
      target: service.label,
      fixHint: "Repair the systemd unit so stale child processes are cleaned up reliably.",
    });
  }
  return findings;
}

function providerCatalogPath(pluginId: string | undefined): string | undefined {
  return pluginId ? `plugins.entries.${pluginId}` : undefined;
}

function providerCatalogProjectionFinding(params: {
  providerId: string;
  pluginId?: string;
  message: string;
  error: unknown;
}): HealthFinding {
  const path = providerCatalogPath(params.pluginId);
  return {
    checkId: "core/doctor/provider-catalog-projection",
    severity: "error",
    message: params.message,
    ...(path ? { path } : {}),
    target: params.providerId,
    requirement: formatErrorMessage(params.error),
    fixHint:
      "Fix the plugin provider catalog hook or disable the plugin, then rerun doctor before relying on model discovery.",
  };
}

function isReadableRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isTrimmedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function hasProviderCatalogKey(params: {
  value: Record<string, unknown>;
  key: string;
  providerId: string;
  pluginId?: string;
}): { ok: true; present: boolean } | { ok: false; finding: HealthFinding } {
  try {
    return { ok: true, present: params.key in params.value };
  } catch (error) {
    return {
      ok: false,
      finding: providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} result keys cannot be checked during doctor validation.`,
        error,
      }),
    };
  }
}

function readProviderCatalogValue(params: {
  value: unknown;
  key: string;
  providerId: string;
  pluginId?: string;
}): { ok: true; value: unknown } | { ok: false; finding: HealthFinding } {
  if (!isReadableRecord(params.value)) {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: params.value[params.key] };
  } catch (error) {
    return {
      ok: false,
      finding: providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} entry cannot be read during doctor validation.`,
        error,
      }),
    };
  }
}

function collectProviderCatalogModelFindings(params: {
  providerId: string;
  pluginId?: string;
  models: unknown;
}): HealthFinding[] {
  const findings: HealthFinding[] = [];
  let models: unknown[];
  try {
    if (!Array.isArray(params.models)) {
      return [
        providerCatalogProjectionFinding({
          providerId: params.providerId,
          pluginId: params.pluginId,
          message: `Provider catalog ${params.providerId} models value is invalid during doctor validation.`,
          error: new Error("models must be an array"),
        }),
      ];
    }
    models = params.models;
  } catch (error) {
    return [
      providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} models value cannot be checked during doctor validation.`,
        error,
      }),
    ];
  }
  let modelEntries: Array<[number, unknown]>;
  try {
    modelEntries = [];
    let index = 0;
    for (const model of models) {
      modelEntries.push([index, model]);
      index += 1;
    }
  } catch (error) {
    return [
      providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} model rows cannot be enumerated during doctor validation.`,
        error,
      }),
    ];
  }
  for (const [index, model] of modelEntries) {
    const modelId = readProviderCatalogValue({
      value: model,
      key: "id",
      providerId: params.providerId,
      pluginId: params.pluginId,
    });
    if (!modelId.ok) {
      findings.push(modelId.finding);
      continue;
    }
    if (!isTrimmedNonEmptyString(modelId.value)) {
      findings.push(
        providerCatalogProjectionFinding({
          providerId: params.providerId,
          pluginId: params.pluginId,
          message: `Provider catalog ${params.providerId} model row ${index} has an invalid model id.`,
          error: new Error("model id must be a non-empty trimmed string"),
        }),
      );
    }
    const modelName = readProviderCatalogValue({
      value: model,
      key: "name",
      providerId: params.providerId,
      pluginId: params.pluginId,
    });
    if (!modelName.ok) {
      findings.push(modelName.finding);
      continue;
    }
    if (modelName.value !== undefined && typeof modelName.value !== "string") {
      findings.push(
        providerCatalogProjectionFinding({
          providerId: params.providerId,
          pluginId: params.pluginId,
          message: `Provider catalog ${params.providerId} model row ${index} has an invalid model name.`,
          error: new Error("model name must be a string when present"),
        }),
      );
    }
  }
  return findings;
}

function collectProviderCatalogResultFindings(params: {
  providerId: string;
  pluginId?: string;
  result: unknown;
}): HealthFinding[] {
  if (params.result == null) {
    return [];
  }
  if (!isReadableRecord(params.result)) {
    return [
      providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} result is invalid during doctor validation.`,
        error: new Error("result must be an object"),
      }),
    ];
  }
  const hasProvider = hasProviderCatalogKey({
    value: params.result,
    key: "provider",
    providerId: params.providerId,
    pluginId: params.pluginId,
  });
  if (!hasProvider.ok) {
    return [hasProvider.finding];
  }
  const provider = readProviderCatalogValue({
    value: params.result,
    key: "provider",
    providerId: params.providerId,
    pluginId: params.pluginId,
  });
  if (!provider.ok) {
    return [provider.finding];
  }
  if (hasProvider.present && !isReadableRecord(provider.value)) {
    return [
      providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} provider value is invalid during doctor validation.`,
        error: new Error("provider must be an object"),
      }),
    ];
  }
  if (isReadableRecord(provider.value)) {
    const models = readProviderCatalogValue({
      value: provider.value,
      key: "models",
      providerId: params.providerId,
      pluginId: params.pluginId,
    });
    return models.ok
      ? collectProviderCatalogModelFindings({ ...params, models: models.value })
      : [models.finding];
  }

  const providers = readProviderCatalogValue({
    value: params.result,
    key: "providers",
    providerId: params.providerId,
    pluginId: params.pluginId,
  });
  if (!providers.ok) {
    return [providers.finding];
  }
  if (!isReadableRecord(providers.value)) {
    return [
      providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} result is invalid during doctor validation.`,
        error: new Error("result must include provider or providers object"),
      }),
    ];
  }
  let providerIds: string[];
  try {
    providerIds = Object.keys(providers.value);
  } catch (error) {
    return [
      providerCatalogProjectionFinding({
        providerId: params.providerId,
        pluginId: params.pluginId,
        message: `Provider catalog ${params.providerId} provider entries cannot be enumerated during doctor validation.`,
        error,
      }),
    ];
  }
  const findings: HealthFinding[] = [];
  for (const providerId of providerIds) {
    if (!isTrimmedNonEmptyString(providerId)) {
      findings.push(
        providerCatalogProjectionFinding({
          providerId: params.providerId,
          pluginId: params.pluginId,
          message: `Provider catalog ${params.providerId} provider key is invalid during doctor validation.`,
          error: new Error("provider key must be a non-empty trimmed string"),
        }),
      );
      continue;
    }
    const providerConfig = readProviderCatalogValue({
      value: providers.value,
      key: providerId,
      providerId,
      pluginId: params.pluginId,
    });
    if (!providerConfig.ok) {
      findings.push(providerConfig.finding);
      continue;
    }
    if (!isReadableRecord(providerConfig.value)) {
      findings.push(
        providerCatalogProjectionFinding({
          providerId,
          pluginId: params.pluginId,
          message: `Provider catalog ${providerId} provider entry is invalid during doctor validation.`,
          error: new Error("provider entry must be an object"),
        }),
      );
      continue;
    }
    const models = readProviderCatalogValue({
      value: providerConfig.value,
      key: "models",
      providerId,
      pluginId: params.pluginId,
    });
    findings.push(
      ...(models.ok
        ? collectProviderCatalogModelFindings({
            providerId,
            pluginId: params.pluginId,
            models: models.value,
          })
        : [models.finding]),
    );
  }
  return findings;
}

function readProviderCatalogOrder(
  provider: ProviderPlugin,
): { ok: true; order: ProviderCatalogOrder } | { ok: false; finding: HealthFinding } {
  let order: unknown;
  try {
    order = provider.staticCatalog?.order ?? "late";
  } catch (error) {
    return {
      ok: false,
      finding: providerCatalogProjectionFinding({
        providerId: provider.id,
        pluginId: provider.pluginId,
        message: `Provider catalog ${provider.id} order cannot be read during doctor validation.`,
        error,
      }),
    };
  }
  if (PROVIDER_CATALOG_ORDER_SET.has(order as ProviderCatalogOrder)) {
    return { ok: true, order: order as ProviderCatalogOrder };
  }
  return {
    ok: false,
    finding: providerCatalogProjectionFinding({
      providerId: provider.id,
      pluginId: provider.pluginId,
      message: `Provider catalog ${provider.id} order is invalid during doctor validation.`,
      error: new Error("order must be simple, profile, paired, or late"),
    }),
  };
}

function groupProviderCatalogsForDoctor(providers: readonly ProviderPlugin[]): {
  findings: HealthFinding[];
  byOrder: Record<ProviderCatalogOrder, ProviderPlugin[]>;
} {
  const findings: HealthFinding[] = [];
  const byOrder: Record<ProviderCatalogOrder, ProviderPlugin[]> = {
    simple: [],
    profile: [],
    paired: [],
    late: [],
  };
  for (const provider of providers) {
    const order = readProviderCatalogOrder(provider);
    if (!order.ok) {
      findings.push(order.finding);
      byOrder.late.push(provider);
      continue;
    }
    byOrder[order.order].push(provider);
  }
  for (const order of PROVIDER_CATALOG_ORDERS) {
    byOrder[order].sort((a, b) => a.label.localeCompare(b.label));
  }
  return { findings, byOrder };
}

export async function collectProviderCatalogProjectionFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const { runProviderStaticCatalog } = await import("../plugins/provider-discovery.js");
  const { resolvePluginProviders } = await import("../plugins/providers.runtime.js");
  const env = process.env;
  const agentDir = resolveDefaultAgentDir(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  let providers: Awaited<ReturnType<typeof resolvePluginProviders>>;
  try {
    providers = resolvePluginProviders({
      config: cfg,
      workspaceDir,
      env,
      includeUntrustedWorkspacePlugins: false,
    });
  } catch (error) {
    return [
      {
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        message: "Provider catalog hooks could not be loaded for doctor validation.",
        requirement: formatErrorMessage(error),
        fixHint: "Fix plugin provider discovery loading, then rerun doctor.",
      },
    ];
  }

  const findings: HealthFinding[] = [];
  const grouped = groupProviderCatalogsForDoctor(providers);
  findings.push(...grouped.findings);
  for (const order of PROVIDER_CATALOG_ORDERS) {
    for (const provider of grouped.byOrder[order]) {
      let staticCatalog: unknown;
      let staticCatalogRun: unknown;
      try {
        staticCatalog = provider.staticCatalog;
        staticCatalogRun = isReadableRecord(staticCatalog) ? staticCatalog.run : undefined;
      } catch (error) {
        findings.push(
          providerCatalogProjectionFinding({
            providerId: provider.id,
            pluginId: provider.pluginId,
            message: `Provider catalog ${provider.id} static catalog hook cannot be read during doctor validation.`,
            error,
          }),
        );
        continue;
      }
      if (staticCatalog === undefined) {
        continue;
      }
      if (typeof staticCatalogRun !== "function") {
        findings.push(
          providerCatalogProjectionFinding({
            providerId: provider.id,
            pluginId: provider.pluginId,
            message: `Provider catalog ${provider.id} static catalog hook is invalid during doctor validation.`,
            error: new Error("static catalog run must be a function"),
          }),
        );
        continue;
      }
      let result: Awaited<ReturnType<typeof runProviderStaticCatalog>>;
      try {
        result = await runProviderStaticCatalog({
          provider,
          config: cfg,
          agentDir,
          workspaceDir,
          env,
        });
      } catch (error) {
        findings.push(
          providerCatalogProjectionFinding({
            providerId: provider.id,
            pluginId: provider.pluginId,
            message: `Provider catalog ${provider.id} failed during doctor validation.`,
            error,
          }),
        );
        continue;
      }
      findings.push(
        ...collectProviderCatalogResultFindings({
          providerId: provider.id,
          pluginId: provider.pluginId,
          result,
        }),
      );
    }
  }
  return findings;
}

function buildDoctorRuntimeModel(params: {
  entry?: ModelCatalogEntry;
  provider: string;
  modelId: string;
}): ProviderRuntimeModel {
  const provider = params.provider || DEFAULT_PROVIDER;
  const id = params.modelId || DEFAULT_MODEL;
  const api = params.entry?.api ?? (provider === "openai" ? "openai-responses" : undefined);
  const entryBaseUrl = (params.entry as { baseUrl?: string } | undefined)?.baseUrl;
  const baseUrl =
    entryBaseUrl ??
    (api === "openai-chatgpt-responses"
      ? "https://chatgpt.com/backend-api"
      : provider === "openai"
        ? "https://api.openai.com/v1"
        : undefined);
  return {
    ...params.entry,
    provider,
    id,
    name: params.entry?.name ?? id,
    ...(api ? { api } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  } as ProviderRuntimeModel;
}

function toolSchemaDiagnosticToFinding(params: {
  agentId: string;
  tools: readonly AnyAgentTool[];
  diagnostic: RuntimeToolSchemaDiagnostic;
}): HealthFinding {
  let tool: AnyAgentTool | undefined;
  try {
    tool = params.tools[params.diagnostic.toolIndex];
  } catch {
    tool = undefined;
  }
  const pluginId = tool ? getPluginToolMeta(tool)?.pluginId : undefined;
  const owner = pluginId ? ` from plugin ${pluginId}` : "";
  const agent = `Agent ${params.agentId} `;
  const path =
    pluginId === "bundle-mcp"
      ? "mcp.servers"
      : pluginId
        ? `plugins.entries.${pluginId}`
        : `tools.${params.diagnostic.toolName}`;
  const fixHint =
    pluginId === "bundle-mcp"
      ? "Disable or update the offending MCP server/tool so its parameters are a JSON object schema, then rerun doctor."
      : "Disable or update the offending plugin/tool so its parameters are a JSON object schema, then rerun doctor.";
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "error",
    message: `${agent}tool ${params.diagnostic.toolName}${owner} has an unsupported input schema for runtime projection.`,
    path,
    target: params.diagnostic.toolName,
    requirement: params.diagnostic.violations.join(", "),
    fixHint,
  };
}

function collectToolSchemaFindings(params: {
  agentId: string;
  tools: readonly AnyAgentTool[];
}): HealthFinding[] {
  return inspectRuntimeToolInputSchemas(params.tools).map((diagnostic) =>
    toolSchemaDiagnosticToFinding({
      agentId: params.agentId,
      tools: params.tools,
      diagnostic,
    }),
  );
}

function collectNormalizedToolSchemaFindings(params: {
  agentId: string;
  tools: AnyAgentTool[];
  cfg: OpenClawConfig;
  workspaceDir: string;
  modelRef: { provider: string; model: string };
  model: ProviderRuntimeModel;
  normalizationFailureFinding: (error: unknown) => HealthFinding;
}): readonly HealthFinding[] {
  const preNormalizationFindings: HealthFinding[] = [];

  let normalizedTools: AnyAgentTool[];
  try {
    normalizedTools = normalizeAgentRuntimeTools({
      tools: params.tools,
      provider: params.modelRef.provider,
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      env: process.env,
      modelId: params.modelRef.model,
      modelApi: params.model.api,
      model: params.model,
      onPreNormalizationSchemaDiagnostics: (diagnostics, sourceTools) => {
        preNormalizationFindings.push(
          ...diagnostics.map((diagnostic) =>
            toolSchemaDiagnosticToFinding({
              agentId: params.agentId,
              tools: sourceTools,
              diagnostic,
            }),
          ),
        );
      },
    });
  } catch (error) {
    return [...preNormalizationFindings, params.normalizationFailureFinding(error)];
  }

  return [
    ...preNormalizationFindings,
    ...collectToolSchemaFindings({
      agentId: params.agentId,
      tools: normalizedTools,
    }),
  ];
}

function collectBundleMcpRuntimeToolSchemaFindings(params: {
  bundleRuntime: BundleMcpToolRuntime;
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  modelRef: { provider: string; model: string };
  model: ProviderRuntimeModel;
}): readonly HealthFinding[] {
  const activeBundleTools = applyFinalEffectiveToolPolicy({
    bundledTools: params.bundleRuntime.tools,
    config: params.cfg,
    conversationCapabilityProfile: resolveConversationCapabilityProfile({
      config: params.cfg,
      agentId: params.agentId,
      modelProvider: params.modelRef.provider,
      modelId: params.modelRef.model,
    }),
    warn: () => {},
    toolPolicyAuditLogLevel: "debug",
  });
  return collectNormalizedToolSchemaFindings({
    agentId: params.agentId,
    tools: activeBundleTools,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    modelRef: params.modelRef,
    model: params.model,
    normalizationFailureFinding: bundleMcpRuntimeNormalizationFailureFinding,
  });
}

function agentRuntimeToolLoadFailureFinding(params: {
  agentId: string;
  error: unknown;
}): HealthFinding {
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "error",
    message: `Agent ${params.agentId} runtime tool schema validation could not load the runtime tool set.`,
    path: `agents.${params.agentId}.tools`,
    requirement: formatErrorMessage(params.error),
    fixHint:
      "Fix provider/plugin tool loading errors, then rerun doctor before relying on assistant tool startup.",
  };
}

function agentRuntimeToolNormalizationFailureFinding(params: {
  agentId: string;
  error: unknown;
}): HealthFinding {
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "error",
    message: `Agent ${params.agentId} runtime tool schema validation could not normalize the runtime tool set.`,
    path: `agents.${params.agentId}.tools`,
    requirement: formatErrorMessage(params.error),
    fixHint:
      "Fix provider/plugin schema normalization errors, then rerun doctor before relying on assistant tool startup.",
  };
}

function collectAgentRuntimeToolSchemaFindings(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  modelRef: { provider: string; model: string };
  model: ProviderRuntimeModel;
}): readonly HealthFinding[] {
  let tools: AnyAgentTool[];
  try {
    tools = createOpenClawCodingTools({
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      modelProvider: params.modelRef.provider,
      modelId: params.modelRef.model,
      modelApi: params.model.api,
      modelCompat: params.model.compat,
      modelContextWindowTokens: params.model.contextWindow,
      allowGatewaySubagentBinding: true,
      emitBeforeToolCallDiagnostics: false,
      toolPolicyAuditLogLevel: "debug",
    });
  } catch (error) {
    return [agentRuntimeToolLoadFailureFinding({ agentId: params.agentId, error })];
  }

  return collectNormalizedToolSchemaFindings({
    agentId: params.agentId,
    tools,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    modelRef: params.modelRef,
    model: params.model,
    normalizationFailureFinding: (error) =>
      agentRuntimeToolNormalizationFailureFinding({
        agentId: params.agentId,
        error,
      }),
  });
}

function bundleMcpRuntimeNormalizationFailureFinding(error: unknown): HealthFinding {
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "error",
    message: "Configured MCP tool schema validation could not normalize the runtime tool set.",
    path: "mcp.servers",
    requirement: formatErrorMessage(error),
    fixHint:
      "Fix provider/plugin schema normalization errors, then rerun doctor before relying on assistant tool startup.",
  };
}

function bundleMcpRuntimeLoadFailureFinding(error: unknown): HealthFinding {
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "error",
    message: "Configured MCP tool schema validation could not load the runtime tool set.",
    path: "mcp.servers",
    requirement: formatErrorMessage(error),
    fixHint:
      "Fix or disable the offending MCP server, then rerun doctor before relying on assistant tool startup.",
  };
}

function bundleMcpRuntimeDiagnosticFinding(diagnostic: McpToolCatalogDiagnostic): HealthFinding {
  return {
    checkId: "core/doctor/runtime-tool-schemas",
    severity: "error",
    message: `Configured MCP server "${diagnostic.serverName}" could not expose runtime tools for schema validation.`,
    path: `mcp.servers.${diagnostic.serverName}`,
    requirement: diagnostic.message,
    fixHint:
      "Fix or disable the offending MCP server, then rerun doctor before relying on assistant tool startup.",
  };
}

function makeBundleMcpDiagnosticSentinel(name: string): AnyAgentTool {
  const sentinel: AnyAgentTool = {
    name,
    label: "Bundle MCP diagnostic",
    description: "Internal doctor sentinel for bundle MCP schema diagnostics.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  } as AnyAgentTool;
  setPluginToolMeta(sentinel, { pluginId: "bundle-mcp", optional: false });
  return sentinel;
}

function synthesizeBundleMcpAllowlistSentinelName(params: {
  safeServerName: string;
  allowlistEntry: string;
}): string | undefined {
  const normalized = normalizeToolName(params.allowlistEntry);
  const serverPrefix = normalizeToolName(`${params.safeServerName}${TOOL_NAME_SEPARATOR}`);
  if (normalized.startsWith(serverPrefix)) {
    return normalized;
  }
  const separatorIndex = normalized.lastIndexOf(TOOL_NAME_SEPARATOR);
  if (separatorIndex < 0) {
    return undefined;
  }
  const toolPattern = normalized.slice(separatorIndex + TOOL_NAME_SEPARATOR.length);
  if (!toolPattern) {
    return undefined;
  }
  const concreteToolName = toolPattern.replace(/\*/g, "diagnostic").replace(/\?/g, "x");
  return `${params.safeServerName}${TOOL_NAME_SEPARATOR}${concreteToolName}`;
}

function collectBundleMcpDiagnosticSentinels(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef: { provider: string; model: string };
  diagnostic: McpToolCatalogDiagnostic;
}): AnyAgentTool[] {
  const sentinels = [
    makeBundleMcpDiagnosticSentinel(
      `${params.diagnostic.safeServerName}${TOOL_NAME_SEPARATOR}runtime_schema`,
    ),
  ];
  const effectivePolicy = resolveEffectiveToolPolicy({
    config: params.cfg,
    agentId: params.agentId,
    modelProvider: params.modelRef.provider,
    modelId: params.modelRef.model,
  });
  const explicitAllowlist = collectExplicitAllowlist([
    effectivePolicy.globalPolicy,
    effectivePolicy.globalProviderPolicy,
    effectivePolicy.agentPolicy,
    effectivePolicy.agentProviderPolicy,
    effectivePolicy.profileAlsoAllow ? { allow: effectivePolicy.profileAlsoAllow } : undefined,
    effectivePolicy.providerProfileAlsoAllow
      ? { allow: effectivePolicy.providerProfileAlsoAllow }
      : undefined,
  ]);
  if (explicitAllowlist.length === 0) {
    return sentinels;
  }

  for (const entry of explicitAllowlist) {
    const sentinelName = synthesizeBundleMcpAllowlistSentinelName({
      safeServerName: params.diagnostic.safeServerName,
      allowlistEntry: entry,
    });
    if (sentinelName) {
      sentinels.push(makeBundleMcpDiagnosticSentinel(sentinelName));
    }
  }
  return sentinels;
}

function shouldReportBundleMcpRuntimeDiagnostic(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef: { provider: string; model: string };
  diagnostic: McpToolCatalogDiagnostic;
}): boolean {
  return (
    applyFinalEffectiveToolPolicy({
      bundledTools: collectBundleMcpDiagnosticSentinels(params),
      config: params.cfg,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({
        config: params.cfg,
        agentId: params.agentId,
        modelProvider: params.modelRef.provider,
        modelId: params.modelRef.model,
      }),
      warn: () => {},
      toolPolicyAuditLogLevel: "debug",
    }).length > 0
  );
}

function filterPolicyActiveBundleMcpDiagnostics(params: {
  diagnostics: readonly McpToolCatalogDiagnostic[];
  cfg: OpenClawConfig;
  agentId: string;
  modelRef: { provider: string; model: string };
}): readonly McpToolCatalogDiagnostic[] {
  return params.diagnostics.filter((diagnostic) =>
    shouldReportBundleMcpRuntimeDiagnostic({
      cfg: params.cfg,
      agentId: params.agentId,
      modelRef: params.modelRef,
      diagnostic,
    }),
  );
}

function isAcpRuntimeAgent(cfg: OpenClawConfig, agentId: string): boolean {
  const entry = listAgentEntries(cfg).find(
    (candidate) => normalizeAgentId(candidate.id) === agentId,
  );
  return entry?.runtime?.type === "acp";
}

export async function collectRuntimeToolSchemaFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  const bundleRuntimeByWorkspace = new Map<string, BundleMcpToolRuntime>();
  const bundleRuntimeLoadErrorsByWorkspace = new Map<string, HealthFinding>();
  const reportedBundleRuntimeLoadErrors = new Set<string>();
  try {
    for (const agentId of listAgentIds(cfg)) {
      if (isAcpRuntimeAgent(cfg, agentId)) {
        continue;
      }
      const catalog = await loadPreparedModelCatalog({
        config: cfg,
        agentId,
        agentDir: resolveAgentDir(cfg, agentId),
      });
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const modelRef = resolveDefaultModelForAgent({
        cfg,
        agentId,
        allowPluginNormalization: true,
      });
      const model = buildDoctorRuntimeModel({
        entry: findModelInCatalog(catalog, modelRef.provider, modelRef.model),
        provider: modelRef.provider,
        modelId: modelRef.model,
      });
      if (!supportsModelTools(model)) {
        continue;
      }
      findings.push(
        ...collectAgentRuntimeToolSchemaFindings({
          cfg,
          agentId,
          workspaceDir,
          modelRef,
          model,
        }),
      );
      if (!shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: true })) {
        continue;
      }
      if (
        !bundleRuntimeByWorkspace.has(workspaceDir) &&
        !bundleRuntimeLoadErrorsByWorkspace.has(workspaceDir)
      ) {
        try {
          bundleRuntimeByWorkspace.set(
            workspaceDir,
            await createBundleMcpToolRuntime({
              workspaceDir,
              cfg,
            }),
          );
        } catch (error) {
          bundleRuntimeLoadErrorsByWorkspace.set(
            workspaceDir,
            bundleMcpRuntimeLoadFailureFinding(error),
          );
        }
      }
      const bundleRuntimeLoadError = bundleRuntimeLoadErrorsByWorkspace.get(workspaceDir);
      if (bundleRuntimeLoadError) {
        if (!reportedBundleRuntimeLoadErrors.has(workspaceDir)) {
          findings.push(bundleRuntimeLoadError);
          reportedBundleRuntimeLoadErrors.add(workspaceDir);
        }
        continue;
      }
      const bundleRuntime = bundleRuntimeByWorkspace.get(workspaceDir);
      if (bundleRuntime) {
        if (bundleRuntime.diagnostics && bundleRuntime.diagnostics.length > 0) {
          const policyActiveDiagnostics = filterPolicyActiveBundleMcpDiagnostics({
            diagnostics: bundleRuntime.diagnostics,
            cfg,
            agentId,
            modelRef,
          });
          findings.push(...policyActiveDiagnostics.map(bundleMcpRuntimeDiagnosticFinding));
        }
        findings.push(
          ...collectBundleMcpRuntimeToolSchemaFindings({
            bundleRuntime,
            cfg,
            agentId,
            workspaceDir,
            modelRef,
            model,
          }),
        );
      }
    }
  } finally {
    await Promise.all([...bundleRuntimeByWorkspace.values()].map((runtime) => runtime.dispose()));
  }
  return findings;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
