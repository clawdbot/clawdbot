import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveSandboxToolPolicyForAgent } from "../agents/sandbox/tool-policy.js";
import type { SandboxToolPolicy } from "../agents/sandbox/types.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { resolveToolProfilePolicy } from "../agents/tool-policy.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { hasConfiguredWebSearchCredential } from "../plugins/web-search-credential-presence.js";
import { inferParamBFromIdOrName } from "../shared/model-param-b.js";
import { pickSandboxToolPolicy } from "./audit-tool-policy.js";

export type SecurityAuditFinding = {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

const SMALL_MODEL_PARAM_B_MAX = 300;

type ModelRef = { id: string; source: string };

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

function addModel(models: ModelRef[], raw: unknown, source: string) {
  if (typeof raw !== "string") {
    return;
  }
  const id = raw.trim();
  if (!id) {
    return;
  }
  models.push({ id, source });
}

function collectModels(cfg: OpenClawConfig): ModelRef[] {
  const out: ModelRef[] = [];
  addModel(
    out,
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model),
    "agents.defaults.model.primary",
  );
  for (const fallback of resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)) {
    addModel(out, fallback, "agents.defaults.model.fallbacks");
  }
  addModel(
    out,
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel),
    "agents.defaults.imageModel.primary",
  );
  for (const fallback of resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel)) {
    addModel(out, fallback, "agents.defaults.imageModel.fallbacks");
  }

  const list = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  for (const agent of list ?? []) {
    if (!agent || typeof agent !== "object") {
      continue;
    }
    const id =
      typeof (agent as { id?: unknown }).id === "string" ? (agent as { id: string }).id : "";
    const model = (agent as { model?: unknown }).model;
    if (typeof model === "string") {
      addModel(out, model, `agents.list.${id}.model`);
    } else if (model && typeof model === "object") {
      addModel(out, (model as { primary?: unknown }).primary, `agents.list.${id}.model.primary`);
      const fallbacks = (model as { fallbacks?: unknown }).fallbacks;
      if (Array.isArray(fallbacks)) {
        for (const fallback of fallbacks) {
          addModel(out, fallback, `agents.list.${id}.model.fallbacks`);
        }
      }
    }
  }
  return out;
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
}): SandboxToolPolicy[] {
  const policies: SandboxToolPolicy[] = [];
  const profile = params.agentTools?.profile ?? params.cfg.tools?.profile;
  const profilePolicy = resolveToolProfilePolicy(profile);
  if (profilePolicy) {
    policies.push(profilePolicy);
  }

  const globalPolicy = pickSandboxToolPolicy(params.cfg.tools ?? undefined);
  if (globalPolicy) {
    policies.push(globalPolicy);
  }

  const agentPolicy = pickSandboxToolPolicy(params.agentTools);
  if (agentPolicy) {
    policies.push(agentPolicy);
  }

  if (params.sandboxMode === "all") {
    policies.push(resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? undefined));
  }

  return policies;
}

function hasWebSearchKey(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  return hasConfiguredWebSearchCredential({
    config: cfg,
    env,
    origin: "bundled",
    bundledAllowlistCompat: true,
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
  return cfg.browser?.enabled !== false;
}

export function collectAttackSurfaceSummaryFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const group = summarizeGroupPolicy(cfg);
  const elevated = cfg.tools?.elevated?.enabled !== false;
  const webhooksEnabled = cfg.hooks?.enabled === true;
  const internalHooksEnabled = cfg.hooks?.internal?.enabled !== false;
  const browserEnabled = cfg.browser?.enabled ?? true;

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
    "trust model: personal assistant (one trusted operator boundary), not hostile multi-tenant on one shared gateway";

  return [
    {
      checkId: "summary.attack_surface",
      severity: "info",
      title: "Attack surface summary",
      detail,
    },
  ];
}

export function collectSmallModelRiskFindings(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const models = collectModels(params.cfg).filter((entry) => !entry.source.includes("imageModel"));
  if (models.length === 0) {
    return findings;
  }

  const smallModels = models
    .map((entry) => {
      const paramB = inferParamBFromIdOrName(entry.id);
      if (!paramB || paramB > SMALL_MODEL_PARAM_B_MAX) {
        return null;
      }
      return { ...entry, paramB };
    })
    .filter((entry): entry is { id: string; source: string; paramB: number } => Boolean(entry));

  if (smallModels.length === 0) {
    return findings;
  }

  let hasUnsafe = false;
  const modelLines: string[] = [];
  const exposureSet = new Set<string>();
  for (const entry of smallModels) {
    const agentId = extractAgentIdFromSource(entry.source);
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
    const safe = sandboxMode === "all" && exposed.length === 0;
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
      'If you must use small models, enable sandboxing for all sessions (agents.defaults.sandbox.mode="all") and disable web_search/web_fetch/browser (tools.deny=["group:web","browser"]).',
  });

  return findings;
}
