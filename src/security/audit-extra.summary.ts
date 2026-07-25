import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
// Summarizes extra security audit findings for user-facing output.
import {
  resolveConfiguredToolPolicies,
  resolveProviderToolPolicy,
} from "../agents/agent-tools.policy.js";
import { parseModelRef } from "../agents/model-selection-normalize.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import type { SandboxToolPolicy } from "../agents/sandbox/types.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { hasConfiguredInternalHooks } from "../hooks/configured.js";
import { normalizePluginsConfigWithResolver } from "../plugins/config-normalization-shared.js";
import { passesManifestOwnerBasePolicy } from "../plugins/manifest-owner-policy.js";
import { hasConfiguredWebSearchCredential } from "../plugins/web-search-credential-presence.js";
import { inferParamBFromIdOrName } from "../shared/model-param-b.js";
import { collectAuditModelRefs } from "./audit-model-refs.js";

/** Lightweight audit finding shape used by summary-only audit helpers. */
type SecurityAuditFinding = {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

const SMALL_MODEL_PARAM_B_MAX = 300;

function summarizeGroupPolicy(cfg: OpenClawConfig): {
  open: number;
  allowlist: number;
  other: number;
} {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels || typeof channels !== "object") {
    return { open: 0, allowlist: 0, other: 0 };
  }
  let open = 0;
  let allowlist = 0;
  let other = 0;
  for (const value of Object.values(channels)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const section = value as Record<string, unknown>;
    const policy = section.groupPolicy;
    if (policy === "open") {
      open += 1;
    } else if (policy === "allowlist") {
      allowlist += 1;
    } else {
      other += 1;
    }
  }
  return { open, allowlist, other };
}

function extractAgentIdFromSource(source: string): string | null {
  const match = source.match(/^agents\.list\.([^.]*)\./);
  return match?.[1] ?? null;
}

function resolveToolPolicies(params: {
  cfg: OpenClawConfig;
  agentTools?: AgentToolsConfig;
  sandboxMode?: "off" | "non-main" | "all";
  agentId?: string | null;
  modelProvider?: string;
  modelId?: string;
}): SandboxToolPolicy[] {
  const globalProviderPolicy = resolveProviderToolPolicy({
    byProvider: params.cfg.tools?.byProvider,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const agentProviderPolicy = resolveProviderToolPolicy({
    byProvider: params.agentTools?.byProvider,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  return resolveConfiguredToolPolicies({
    cfg: params.cfg,
    agentTools: params.agentTools,
    sandboxMode: params.sandboxMode,
    agentId: params.agentId,
    extraPolicies: [globalProviderPolicy, agentProviderPolicy],
  });
}

function hasWebSearchKey(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  return hasConfiguredWebSearchCredential({
    config: cfg,
    env,
    origin: "bundled",
  });
}

function isWebSearchEnabled(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  const enabled = cfg.tools?.web?.search?.enabled;
  if (enabled === false) {
    return false;
  }
  if (enabled === true) {
    return true;
  }
  return hasWebSearchKey(cfg, env);
}

function isWebFetchEnabled(cfg: OpenClawConfig): boolean {
  const enabled = cfg.tools?.web?.fetch?.enabled;
  if (enabled === false) {
    return false;
  }
  return true;
}

function isBrowserEnabled(cfg: OpenClawConfig): boolean {
  if (cfg.browser?.enabled === false) {
    return false;
  }
  return passesManifestOwnerBasePolicy({
    plugin: { id: "browser" },
    normalizedConfig: normalizePluginsConfigWithResolver(
      cfg.plugins,
      (pluginId) => normalizeOptionalLowercaseString(pluginId) ?? "",
    ),
    // Browser config selects behavior; it must not weaken global plugin policy.
  });
}

/** Produce a concise inventory of major security-relevant surfaces. */
export function collectAttackSurfaceSummaryFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const group = summarizeGroupPolicy(cfg);
  const elevated = cfg.tools?.elevated?.enabled !== false;
  const webhooksEnabled = cfg.hooks?.enabled === true;
  const internalHooksEnabled = hasConfiguredInternalHooks(cfg);
  const browserEnabled = isBrowserEnabled(cfg);

  const detail =
    `groups: open=${group.open}, allowlist=${group.allowlist}` +
    `\n` +
    `tools.elevated: ${elevated ? "enabled" : "disabled"}` +
    `\n` +
    `hooks.webhooks: ${webhooksEnabled ? "enabled" : "disabled"}` +
    `\n` +
    `hooks.internal: ${internalHooksEnabled ? "enabled" : "disabled"}` +
    `\n` +
    `browser control: ${browserEnabled ? "enabled" : "disabled"}` +
    `\n` +
    "trust model: personal assistant (one trusted operator boundary), not hostile multi-tenant on one shared gateway. For multiple users or organizations, run one isolated Gateway cell per tenant: https://docs.openclaw.ai/gateway/multi-tenant-hosting";

  return [
    {
      checkId: "summary.attack_surface",
      severity: "info",
      title: "Attack surface summary",
      detail,
    },
  ];
}

/** Flag small-parameter models when they retain web/browser tool exposure. */
export function collectSmallModelRiskFindings(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const models = collectAuditModelRefs(params.cfg).filter(
    (entry) => !entry.source.includes("imageModel"),
  );
  if (models.length === 0) {
    return findings;
  }

  const smallModels: Array<{ id: string; source: string; paramB: number }> = [];
  for (const entry of models) {
    const paramB = inferParamBFromIdOrName(entry.id);
    if (paramB && paramB <= SMALL_MODEL_PARAM_B_MAX) {
      smallModels.push({ id: entry.id, source: entry.source, paramB });
    }
  }

  if (smallModels.length === 0) {
    return findings;
  }

  let hasUnsafe = false;
  const modelLines: string[] = [];
  const exposureSet = new Set<string>();
  for (const entry of smallModels) {
    const agentId = extractAgentIdFromSource(entry.source);
    // Evaluate each model in its agent context because sandbox/tool policy can
    // differ per agent and provider override.
    const modelRef = parseModelRef(entry.id, "openai", {
      allowPluginNormalization: false,
    });
    const sandboxMode = resolveSandboxConfigForAgent(params.cfg, agentId ?? undefined).mode;
    const agentTools =
      agentId && params.cfg.agents?.list
        ? params.cfg.agents.list.find((agent) => agent?.id === agentId)?.tools
        : undefined;
    const policies = resolveToolPolicies({
      cfg: params.cfg,
      agentTools,
      sandboxMode,
      agentId,
      modelProvider: modelRef?.provider,
      modelId: modelRef?.model,
    });
    const exposed: string[] = [];
    if (
      isWebSearchEnabled(params.cfg, params.env) &&
      isToolAllowedByPolicies("web_search", policies)
    ) {
      exposed.push("web_search");
    }
    if (isWebFetchEnabled(params.cfg) && isToolAllowedByPolicies("web_fetch", policies)) {
      exposed.push("web_fetch");
    }
    if (isBrowserEnabled(params.cfg) && isToolAllowedByPolicies("browser", policies)) {
      exposed.push("browser");
    }
    for (const tool of exposed) {
      exposureSet.add(tool);
    }
    const sandboxLabel = sandboxMode === "all" ? "sandbox=all" : `sandbox=${sandboxMode}`;
    const exposureLabel = exposed.length > 0 ? ` web=[${exposed.join(", ")}]` : " web=[off]";
    const safe = exposed.length === 0;
    if (!safe) {
      hasUnsafe = true;
    }
    const statusLabel = safe ? "ok" : "unsafe";
    modelLines.push(
      `- ${entry.id} (${entry.paramB}B) @ ${entry.source} (${statusLabel}; ${sandboxLabel};${exposureLabel})`,
    );
  }

  const exposureList = Array.from(exposureSet);
  const exposureDetail =
    exposureList.length > 0
      ? `Uncontrolled input tools allowed: ${exposureList.join(", ")}.`
      : "No web/browser tools detected for these models.";

  findings.push({
    checkId: "models.small_params",
    severity: hasUnsafe ? "critical" : "info",
    title: "Small models require sandboxing and web tools disabled",
    detail:
      `Small models (<=${SMALL_MODEL_PARAM_B_MAX}B params) detected:\n` +
      modelLines.join("\n") +
      `\n` +
      exposureDetail +
      `\n` +
      "Small models are not recommended for untrusted inputs.",
    remediation:
      'If you must use small models, disable web_search/web_fetch/browser globally or for each small model with tools.byProvider["provider/model"].deny=["group:web","browser"]; use agents.defaults.sandbox.mode="all" for defense in depth.',
  });

  return findings;
}
