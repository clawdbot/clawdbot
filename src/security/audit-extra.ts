import fs from "node:fs/promises";
import path from "node:path";

import JSON5 from "json5";

import type { MoltbotConfig, ConfigFileSnapshot } from "../config/config.js";
import { createConfigIO } from "../config/config.js";
import { resolveNativeSkillsEnabled } from "../config/commands.js";
import { resolveOAuthDir } from "../config/paths.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { isToolAllowedByPolicies } from "../agents/pi-tools.policy.js";
import { resolveToolProfilePolicy } from "../agents/tool-policy.js";
import {
  resolveSandboxConfigForAgent,
  resolveSandboxToolPolicyForAgent,
} from "../agents/sandbox.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import type { SandboxToolPolicy } from "../agents/sandbox/types.js";
import { INCLUDE_KEY, MAX_INCLUDE_DEPTH } from "../config/includes.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
  safeStat,
} from "./audit-fs.js";
import type { ExecFn } from "./windows-acl.js";

export type SecurityAuditFinding = {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

const SMALL_MODEL_PARAM_B_MAX = 300;

function expandTilde(p: string, env: NodeJS.ProcessEnv): string | null {
  if (!p.startsWith("~")) return p;
  const home = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : null;
  if (!home) return null;
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return null;
}

function summarizeGroupPolicy(cfg: MoltbotConfig): {
  open: number;
  allowlist: number;
  other: number;
} {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels || typeof channels !== "object") return { open: 0, allowlist: 0, other: 0 };
  let open = 0;
  let allowlist = 0;
  let other = 0;
  for (const value of Object.values(channels)) {
    if (!value || typeof value !== "object") continue;
    const section = value as Record<string, unknown>;
    const policy = section.groupPolicy;
    if (policy === "open") open += 1;
    else if (policy === "allowlist") allowlist += 1;
    else other += 1;
  }
  return { open, allowlist, other };
}

export function collectAttackSurfaceSummaryFindings(cfg: MoltbotConfig): SecurityAuditFinding[] {
  const group = summarizeGroupPolicy(cfg);
  const elevated = cfg.tools?.elevated?.enabled !== false;
  const hooksEnabled = cfg.hooks?.enabled === true;
  const browserEnabled = cfg.browser?.enabled ?? true;

  const detail =
    `groups: open=${group.open}, allowlist=${group.allowlist}` +
    `\n` +
    `tools.elevated: ${elevated ? "enabled" : "disabled"}` +
    `\n` +
    `hooks: ${hooksEnabled ? "enabled" : "disabled"}` +
    `\n` +
    `browser control: ${browserEnabled ? "enabled" : "disabled"}`;

  return [
    {
      checkId: "summary.attack_surface",
      severity: "info",
      title: "Attack surface summary",
      detail,
    },
  ];
}

function isProbablySyncedPath(p: string): boolean {
  const s = p.toLowerCase();
  return (
    s.includes("icloud") ||
    s.includes("dropbox") ||
    s.includes("google drive") ||
    s.includes("googledrive") ||
    s.includes("onedrive")
  );
}

export function collectSyncedFolderFindings(params: {
  stateDir: string;
  configPath: string;
}): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  if (isProbablySyncedPath(params.stateDir) || isProbablySyncedPath(params.configPath)) {
    findings.push({
      checkId: "fs.synced_dir",
      severity: "warn",
      title: "State/config path looks like a synced folder",
      detail: `stateDir=${params.stateDir}, configPath=${params.configPath}. Synced folders (iCloud/Dropbox/OneDrive/Google Drive) can leak tokens and transcripts onto other devices.`,
      remediation: `Keep CLAWDBOT_STATE_DIR on a local-only volume and re-run "${formatCliCommand("moltbot security audit --fix")}".`,
    });
  }
  return findings;
}

function looksLikeEnvRef(value: string): boolean {
  const v = value.trim();
  return v.startsWith("${") && v.endsWith("}");
}

export function collectSecretsInConfigFindings(cfg: MoltbotConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const password =
    typeof cfg.gateway?.auth?.password === "string" ? cfg.gateway.auth.password.trim() : "";
  if (password && !looksLikeEnvRef(password)) {
    findings.push({
      checkId: "config.secrets.gateway_password_in_config",
      severity: "warn",
      title: "Gateway password is stored in config",
      detail:
        "gateway.auth.password is set in the config file; prefer environment variables for secrets when possible.",
      remediation:
        "Prefer CLAWDBOT_GATEWAY_PASSWORD (env) and remove gateway.auth.password from disk.",
    });
  }

  const hooksToken = typeof cfg.hooks?.token === "string" ? cfg.hooks.token.trim() : "";
  if (cfg.hooks?.enabled === true && hooksToken && !looksLikeEnvRef(hooksToken)) {
    findings.push({
      checkId: "config.secrets.hooks_token_in_config",
      severity: "info",
      title: "Hooks token is stored in config",
      detail:
        "hooks.token is set in the config file; keep config perms tight and treat it like an API secret.",
    });
  }

  return findings;
}

export function collectHooksHardeningFindings(cfg: MoltbotConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  if (cfg.hooks?.enabled !== true) return findings;

  const token = typeof cfg.hooks?.token === "string" ? cfg.hooks.token.trim() : "";
  if (token && token.length < 24) {
    findings.push({
      checkId: "hooks.token_too_short",
      severity: "warn",
      title: "Hooks token looks short",
      detail: `hooks.token is ${token.length} chars; prefer a long random token.`,
    });
  }

  const gatewayAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
  });
  const gatewayToken =
    gatewayAuth.mode === "token" &&
    typeof gatewayAuth.token === "string" &&
    gatewayAuth.token.trim()
      ? gatewayAuth.token.trim()
      : null;
  if (token && gatewayToken && token === gatewayToken) {
    findings.push({
      checkId: "hooks.token_reuse_gateway_token",
      severity: "warn",
      title: "Hooks token reuses the Gateway token",
      detail:
        "hooks.token matches gateway.auth token; compromise of hooks expands blast radius to the Gateway API.",
      remediation: "Use a separate hooks.token dedicated to hook ingress.",
    });
  }

  const rawPath = typeof cfg.hooks?.path === "string" ? cfg.hooks.path.trim() : "";
  if (rawPath === "/") {
    findings.push({
      checkId: "hooks.path_root",
      severity: "critical",
      title: "Hooks base path is '/'",
      detail: "hooks.path='/' would shadow other HTTP endpoints and is unsafe.",
      remediation: "Use a dedicated path like '/hooks'.",
    });
  }

  return findings;
}

type ModelRef = { id: string; source: string };

function addModel(models: ModelRef[], raw: unknown, source: string) {
  if (typeof raw !== "string") return;
  const id = raw.trim();
  if (!id) return;
  models.push({ id, source });
}

function collectModels(cfg: MoltbotConfig): ModelRef[] {
  const out: ModelRef[] = [];
  addModel(out, cfg.agents?.defaults?.model?.primary, "agents.defaults.model.primary");
  for (const f of cfg.agents?.defaults?.model?.fallbacks ?? [])
    addModel(out, f, "agents.defaults.model.fallbacks");
  addModel(out, cfg.agents?.defaults?.imageModel?.primary, "agents.defaults.imageModel.primary");
  for (const f of cfg.agents?.defaults?.imageModel?.fallbacks ?? [])
    addModel(out, f, "agents.defaults.imageModel.fallbacks");

  const list = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  for (const agent of list ?? []) {
    if (!agent || typeof agent !== "object") continue;
    const id =
      typeof (agent as { id?: unknown }).id === "string" ? (agent as { id: string }).id : "";
    const model = (agent as { model?: unknown }).model;
    if (typeof model === "string") {
      addModel(out, model, `agents.list.${id}.model`);
    } else if (model && typeof model === "object") {
      addModel(out, (model as { primary?: unknown }).primary, `agents.list.${id}.model.primary`);
      const fallbacks = (model as { fallbacks?: unknown }).fallbacks;
      if (Array.isArray(fallbacks)) {
        for (const f of fallbacks) addModel(out, f, `agents.list.${id}.model.fallbacks`);
      }
    }
  }
  return out;
}

const LEGACY_MODEL_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "openai.gpt35", re: /\bgpt-3\.5\b/i, label: "GPT-3.5 family" },
  { id: "anthropic.claude2", re: /\bclaude-(instant|2)\b/i, label: "Claude 2/Instant family" },
  { id: "openai.gpt4_legacy", re: /\bgpt-4-(0314|0613)\b/i, label: "Legacy GPT-4 snapshots" },
];

const WEAK_TIER_MODEL_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "anthropic.haiku", re: /\bhaiku\b/i, label: "Haiku tier (smaller model)" },
];

function inferParamBFromIdOrName(text: string): number | null {
  const raw = text.toLowerCase();
  const matches = raw.matchAll(/(?:^|[^a-z0-9])[a-z]?(\d+(?:\.\d+)?)b(?:[^a-z0-9]|$)/g);
  let best: number | null = null;
  for (const match of matches) {
    const numRaw = match[1];
    if (!numRaw) continue;
    const value = Number(numRaw);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

function isGptModel(id: string): boolean {
  return /\bgpt-/i.test(id);
}

function isGpt5OrHigher(id: string): boolean {
  return /\bgpt-5(?:\b|[.-])/i.test(id);
}

function isClaudeModel(id: string): boolean {
  return /\bclaude-/i.test(id);
}

function isClaude45OrHigher(id: string): boolean {
  // Match claude-*-4-5, claude-*-45, claude-*4.5, or opus-4-5/opus-45 variants
  // Examples that should match:
  //   claude-opus-4-5, claude-opus-45, claude-4.5, venice/claude-opus-45
  return /\bclaude-[^\s/]*?(?:-4-?5\b|4\.5\b)/i.test(id);
}

export function collectModelHygieneFindings(cfg: MoltbotConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const models = collectModels(cfg);
  if (models.length === 0) return findings;

  const weakMatches = new Map<string, { model: string; source: string; reasons: string[] }>();
  const addWeakMatch = (model: string, source: string, reason: string) => {
    const key = `${model}@@${source}`;
    const existing = weakMatches.get(key);
    if (!existing) {
      weakMatches.set(key, { model, source, reasons: [reason] });
      return;
    }
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
  };

  for (const entry of models) {
    for (const pat of WEAK_TIER_MODEL_PATTERNS) {
      if (pat.re.test(entry.id)) {
        addWeakMatch(entry.id, entry.source, pat.label);
        break;
      }
    }
    if (isGptModel(entry.id) && !isGpt5OrHigher(entry.id)) {
      addWeakMatch(entry.id, entry.source, "Below GPT-5 family");
    }
    if (isClaudeModel(entry.id) && !isClaude45OrHigher(entry.id)) {
      addWeakMatch(entry.id, entry.source, "Below Claude 4.5");
    }
  }

  const matches: Array<{ model: string; source: string; reason: string }> = [];
  for (const entry of models) {
    for (const pat of LEGACY_MODEL_PATTERNS) {
      if (pat.re.test(entry.id)) {
        matches.push({ model: entry.id, source: entry.source, reason: pat.label });
        break;
      }
    }
  }

  if (matches.length > 0) {
    const lines = matches
      .slice(0, 12)
      .map((m) => `- ${m.model} (${m.reason}) @ ${m.source}`)
      .join("\n");
    const more = matches.length > 12 ? `\n…${matches.length - 12} more` : "";
    findings.push({
      checkId: "models.legacy",
      severity: "warn",
      title: "Some configured models look legacy",
      detail:
        "Older/legacy models can be less robust against prompt injection and tool misuse.\n" +
        lines +
        more,
      remediation: "Prefer modern, instruction-hardened models for any bot that can run tools.",
    });
  }

  if (weakMatches.size > 0) {
    const lines = Array.from(weakMatches.values())
      .slice(0, 12)
      .map((m) => `- ${m.model} (${m.reasons.join("; ")}) @ ${m.source}`)
      .join("\n");
    const more = weakMatches.size > 12 ? `\n…${weakMatches.size - 12} more` : "";
    findings.push({
      checkId: "models.weak_tier",
      severity: "warn",
      title: "Some configured models are below recommended tiers",
      detail:
        "Smaller/older models are generally more susceptible to prompt injection and tool misuse.\n" +
        lines +
        more,
      remediation:
        "Use the latest, top-tier model for any bot with tools or untrusted inboxes. Avoid Haiku tiers; prefer GPT-5+ and Claude 4.5+.",
    });
  }

  return findings;
}

function extractAgentIdFromSource(source: string): string | null {
  const match = source.match(/^agents\.list\.([^.]*)\./);
  return match?.[1] ?? null;
}

function pickToolPolicy(config?: { allow?: string[]; deny?: string[] }): SandboxToolPolicy | null {
  if (!config) return null;
  const allow = Array.isArray(config.allow) ? config.allow : undefined;
  const deny = Array.isArray(config.deny) ? config.deny : undefined;
  if (!allow && !deny) return null;
  return { allow, deny };
}

function resolveToolPolicies(params: {
  cfg: MoltbotConfig;
  agentTools?: AgentToolsConfig;
  sandboxMode?: "off" | "non-main" | "all";
  agentId?: string | null;
}): SandboxToolPolicy[] {
  const policies: SandboxToolPolicy[] = [];
  const profile = params.agentTools?.profile ?? params.cfg.tools?.profile;
  const profilePolicy = resolveToolProfilePolicy(profile);
  if (profilePolicy) policies.push(profilePolicy);

  const globalPolicy = pickToolPolicy(params.cfg.tools ?? undefined);
  if (globalPolicy) policies.push(globalPolicy);

  const agentPolicy = pickToolPolicy(params.agentTools);
  if (agentPolicy) policies.push(agentPolicy);

  if (params.sandboxMode === "all") {
    const sandboxPolicy = resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? undefined);
    policies.push(sandboxPolicy);
  }

  return policies;
}

function hasWebSearchKey(cfg: MoltbotConfig, env: NodeJS.ProcessEnv): boolean {
  const search = cfg.tools?.web?.search;
  return Boolean(
    search?.apiKey ||
    search?.perplexity?.apiKey ||
    env.BRAVE_API_KEY ||
    env.PERPLEXITY_API_KEY ||
    env.OPENROUTER_API_KEY,
  );
}

function isWebSearchEnabled(cfg: MoltbotConfig, env: NodeJS.ProcessEnv): boolean {
  const enabled = cfg.tools?.web?.search?.enabled;
  if (enabled === false) return false;
  if (enabled === true) return true;
  return hasWebSearchKey(cfg, env);
}

function isWebFetchEnabled(cfg: MoltbotConfig): boolean {
  const enabled = cfg.tools?.web?.fetch?.enabled;
  if (enabled === false) return false;
  return true;
}

function isBrowserEnabled(cfg: MoltbotConfig): boolean {
  try {
    return resolveBrowserConfig(cfg.browser, cfg).enabled;
  } catch {
    return true;
  }
}

export function collectSmallModelRiskFindings(params: {
  cfg: MoltbotConfig;
  env: NodeJS.ProcessEnv;
}): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const models = collectModels(params.cfg).filter((entry) => !entry.source.includes("imageModel"));
  if (models.length === 0) return findings;

  const smallModels = models
    .map((entry) => {
      const paramB = inferParamBFromIdOrName(entry.id);
      if (!paramB || paramB > SMALL_MODEL_PARAM_B_MAX) return null;
      return { ...entry, paramB };
    })
    .filter((entry): entry is { id: string; source: string; paramB: number } => Boolean(entry));

  if (smallModels.length === 0) return findings;

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
    if (isWebSearchEnabled(params.cfg, params.env)) {
      if (isToolAllowedByPolicies("web_search", policies)) exposed.push("web_search");
    }
    if (isWebFetchEnabled(params.cfg)) {
      if (isToolAllowedByPolicies("web_fetch", policies)) exposed.push("web_fetch");
    }
    if (isBrowserEnabled(params.cfg)) {
      if (isToolAllowedByPolicies("browser", policies)) exposed.push("browser");
    }
    for (const tool of exposed) exposureSet.add(tool);
    const sandboxLabel = sandboxMode === "all" ? "sandbox=all" : `sandbox=${sandboxMode}`;
    const exposureLabel = exposed.length > 0 ? ` web=[${exposed.join(", ")}]` : " web=[off]";
    const safe = sandboxMode === "all" && exposed.length === 0;
    if (!safe) hasUnsafe = true;
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

export async function collectPluginsTrustFindings(params: {
  cfg: MoltbotConfig;
  stateDir: string;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const extensionsDir = path.join(params.stateDir, "extensions");
  const st = await safeStat(extensionsDir);
  if (!st.ok || !st.isDir) return findings;

  const entries = await fs.readdir(extensionsDir, { withFileTypes: true }).catch(() => []);
  const pluginDirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter(Boolean);
  if (pluginDirs.length === 0) return findings;

  const allow = params.cfg.plugins?.allow;
  const allowConfigured = Array.isArray(allow) && allow.length > 0;
  if (!allowConfigured) {
    const hasString = (value: unknown) => typeof value === "string" && value.trim().length > 0;
    const hasAccountStringKey = (account: unknown, key: string) =>
      Boolean(
        account &&
        typeof account === "object" &&
        hasString((account as Record<string, unknown>)[key]),
      );

    const discordConfigured =
      hasString(params.cfg.channels?.discord?.token) ||
      Boolean(
        params.cfg.channels?.discord?.accounts &&
        Object.values(params.cfg.channels.discord.accounts).some((a) =>
          hasAccountStringKey(a, "token"),
        ),
      ) ||
      hasString(process.env.DISCORD_BOT_TOKEN);

    const telegramConfigured =
      hasString(params.cfg.channels?.telegram?.botToken) ||
      hasString(params.cfg.channels?.telegram?.tokenFile) ||
      Boolean(
        params.cfg.channels?.telegram?.accounts &&
        Object.values(params.cfg.channels.telegram.accounts).some(
          (a) => hasAccountStringKey(a, "botToken") || hasAccountStringKey(a, "tokenFile"),
        ),
      ) ||
      hasString(process.env.TELEGRAM_BOT_TOKEN);

    const slackConfigured =
      hasString(params.cfg.channels?.slack?.botToken) ||
      hasString(params.cfg.channels?.slack?.appToken) ||
      Boolean(
        params.cfg.channels?.slack?.accounts &&
        Object.values(params.cfg.channels.slack.accounts).some(
          (a) => hasAccountStringKey(a, "botToken") || hasAccountStringKey(a, "appToken"),
        ),
      ) ||
      hasString(process.env.SLACK_BOT_TOKEN) ||
      hasString(process.env.SLACK_APP_TOKEN);

    const skillCommandsLikelyExposed =
      (discordConfigured &&
        resolveNativeSkillsEnabled({
          providerId: "discord",
          providerSetting: params.cfg.channels?.discord?.commands?.nativeSkills,
          globalSetting: params.cfg.commands?.nativeSkills,
        })) ||
      (telegramConfigured &&
        resolveNativeSkillsEnabled({
          providerId: "telegram",
          providerSetting: params.cfg.channels?.telegram?.commands?.nativeSkills,
          globalSetting: params.cfg.commands?.nativeSkills,
        })) ||
      (slackConfigured &&
        resolveNativeSkillsEnabled({
          providerId: "slack",
          providerSetting: params.cfg.channels?.slack?.commands?.nativeSkills,
          globalSetting: params.cfg.commands?.nativeSkills,
        }));

    findings.push({
      checkId: "plugins.extensions_no_allowlist",
      severity: skillCommandsLikelyExposed ? "critical" : "warn",
      title: "Extensions exist but plugins.allow is not set",
      detail:
        `Found ${pluginDirs.length} extension(s) under ${extensionsDir}. Without plugins.allow, any discovered plugin id may load (depending on config and plugin behavior).` +
        (skillCommandsLikelyExposed
          ? "\nNative skill commands are enabled on at least one configured chat surface; treat unpinned/unallowlisted extensions as high risk."
          : ""),
      remediation: "Set plugins.allow to an explicit list of plugin ids you trust.",
    });
  }

  return findings;
}

function resolveIncludePath(baseConfigPath: string, includePath: string): string {
  return path.normalize(
    path.isAbsolute(includePath)
      ? includePath
      : path.resolve(path.dirname(baseConfigPath), includePath),
  );
}

function listDirectIncludes(parsed: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object") return;
    const rec = value as Record<string, unknown>;
    const includeVal = rec[INCLUDE_KEY];
    if (typeof includeVal === "string") out.push(includeVal);
    else if (Array.isArray(includeVal)) {
      for (const item of includeVal) {
        if (typeof item === "string") out.push(item);
      }
    }
    for (const v of Object.values(rec)) visit(v);
  };
  visit(parsed);
  return out;
}

async function collectIncludePathsRecursive(params: {
  configPath: string;
  parsed: unknown;
}): Promise<string[]> {
  const visited = new Set<string>();
  const result: string[] = [];

  const walk = async (basePath: string, parsed: unknown, depth: number): Promise<void> => {
    if (depth > MAX_INCLUDE_DEPTH) return;
    for (const raw of listDirectIncludes(parsed)) {
      const resolved = resolveIncludePath(basePath, raw);
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      result.push(resolved);
      const rawText = await fs.readFile(resolved, "utf-8").catch(() => null);
      if (!rawText) continue;
      const nestedParsed = (() => {
        try {
          return JSON5.parse(rawText) as unknown;
        } catch {
          return null;
        }
      })();
      if (nestedParsed) {
        // eslint-disable-next-line no-await-in-loop
        await walk(resolved, nestedParsed, depth + 1);
      }
    }
  };

  await walk(params.configPath, params.parsed, 0);
  return result;
}

export async function collectIncludeFilePermFindings(params: {
  configSnapshot: ConfigFileSnapshot;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  if (!params.configSnapshot.exists) return findings;

  const configPath = params.configSnapshot.path;
  const includePaths = await collectIncludePathsRecursive({
    configPath,
    parsed: params.configSnapshot.parsed,
  });
  if (includePaths.length === 0) return findings;

  for (const p of includePaths) {
    // eslint-disable-next-line no-await-in-loop
    const perms = await inspectPathPermissions(p, {
      env: params.env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (!perms.ok) continue;
    if (perms.worldWritable || perms.groupWritable) {
      findings.push({
        checkId: "fs.config_include.perms_writable",
        severity: "critical",
        title: "Config include file is writable by others",
        detail: `${formatPermissionDetail(p, perms)}; another user could influence your effective config.`,
        remediation: formatPermissionRemediation({
          targetPath: p,
          perms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    } else if (perms.worldReadable) {
      findings.push({
        checkId: "fs.config_include.perms_world_readable",
        severity: "critical",
        title: "Config include file is world-readable",
        detail: `${formatPermissionDetail(p, perms)}; include files can contain tokens and private settings.`,
        remediation: formatPermissionRemediation({
          targetPath: p,
          perms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    } else if (perms.groupReadable) {
      findings.push({
        checkId: "fs.config_include.perms_group_readable",
        severity: "warn",
        title: "Config include file is group-readable",
        detail: `${formatPermissionDetail(p, perms)}; include files can contain tokens and private settings.`,
        remediation: formatPermissionRemediation({
          targetPath: p,
          perms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    }
  }

  return findings;
}

export async function collectStateDeepFilesystemFindings(params: {
  cfg: MoltbotConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const oauthDir = resolveOAuthDir(params.env, params.stateDir);

  const oauthPerms = await inspectPathPermissions(oauthDir, {
    env: params.env,
    platform: params.platform,
    exec: params.execIcacls,
  });
  if (oauthPerms.ok && oauthPerms.isDir) {
    if (oauthPerms.worldWritable || oauthPerms.groupWritable) {
      findings.push({
        checkId: "fs.credentials_dir.perms_writable",
        severity: "critical",
        title: "Credentials dir is writable by others",
        detail: `${formatPermissionDetail(oauthDir, oauthPerms)}; another user could drop/modify credential files.`,
        remediation: formatPermissionRemediation({
          targetPath: oauthDir,
          perms: oauthPerms,
          isDir: true,
          posixMode: 0o700,
          env: params.env,
        }),
      });
    } else if (oauthPerms.groupReadable || oauthPerms.worldReadable) {
      findings.push({
        checkId: "fs.credentials_dir.perms_readable",
        severity: "warn",
        title: "Credentials dir is readable by others",
        detail: `${formatPermissionDetail(oauthDir, oauthPerms)}; credentials and allowlists can be sensitive.`,
        remediation: formatPermissionRemediation({
          targetPath: oauthDir,
          perms: oauthPerms,
          isDir: true,
          posixMode: 0o700,
          env: params.env,
        }),
      });
    }
  }

  const agentIds = Array.isArray(params.cfg.agents?.list)
    ? params.cfg.agents?.list
        .map((a) => (a && typeof a === "object" && typeof a.id === "string" ? a.id.trim() : ""))
        .filter(Boolean)
    : [];
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const ids = Array.from(new Set([defaultAgentId, ...agentIds])).map((id) => normalizeAgentId(id));

  for (const agentId of ids) {
    const agentDir = path.join(params.stateDir, "agents", agentId, "agent");
    const authPath = path.join(agentDir, "auth-profiles.json");
    // eslint-disable-next-line no-await-in-loop
    const authPerms = await inspectPathPermissions(authPath, {
      env: params.env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (authPerms.ok) {
      if (authPerms.worldWritable || authPerms.groupWritable) {
        findings.push({
          checkId: "fs.auth_profiles.perms_writable",
          severity: "critical",
          title: "auth-profiles.json is writable by others",
          detail: `${formatPermissionDetail(authPath, authPerms)}; another user could inject credentials.`,
          remediation: formatPermissionRemediation({
            targetPath: authPath,
            perms: authPerms,
            isDir: false,
            posixMode: 0o600,
            env: params.env,
          }),
        });
      } else if (authPerms.worldReadable || authPerms.groupReadable) {
        findings.push({
          checkId: "fs.auth_profiles.perms_readable",
          severity: "warn",
          title: "auth-profiles.json is readable by others",
          detail: `${formatPermissionDetail(authPath, authPerms)}; auth-profiles.json contains API keys and OAuth tokens.`,
          remediation: formatPermissionRemediation({
            targetPath: authPath,
            perms: authPerms,
            isDir: false,
            posixMode: 0o600,
            env: params.env,
          }),
        });
      }
    }

    const storePath = path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
    // eslint-disable-next-line no-await-in-loop
    const storePerms = await inspectPathPermissions(storePath, {
      env: params.env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (storePerms.ok) {
      if (storePerms.worldReadable || storePerms.groupReadable) {
        findings.push({
          checkId: "fs.sessions_store.perms_readable",
          severity: "warn",
          title: "sessions.json is readable by others",
          detail: `${formatPermissionDetail(storePath, storePerms)}; routing and transcript metadata can be sensitive.`,
          remediation: formatPermissionRemediation({
            targetPath: storePath,
            perms: storePerms,
            isDir: false,
            posixMode: 0o600,
            env: params.env,
          }),
        });
      }
    }
  }

  const logFile =
    typeof params.cfg.logging?.file === "string" ? params.cfg.logging.file.trim() : "";
  if (logFile) {
    const expanded = logFile.startsWith("~") ? expandTilde(logFile, params.env) : logFile;
    if (expanded) {
      const logPath = path.resolve(expanded);
      const logPerms = await inspectPathPermissions(logPath, {
        env: params.env,
        platform: params.platform,
        exec: params.execIcacls,
      });
      if (logPerms.ok) {
        if (logPerms.worldReadable || logPerms.groupReadable) {
          findings.push({
            checkId: "fs.log_file.perms_readable",
            severity: "warn",
            title: "Log file is readable by others",
            detail: `${formatPermissionDetail(logPath, logPerms)}; logs can contain private messages and tool output.`,
            remediation: formatPermissionRemediation({
              targetPath: logPath,
              perms: logPerms,
              isDir: false,
              posixMode: 0o600,
              env: params.env,
            }),
          });
        }
      }
    }
  }

  return findings;
}

function listGroupPolicyOpen(cfg: MoltbotConfig): string[] {
  const out: string[] = [];
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels || typeof channels !== "object") return out;
  for (const [channelId, value] of Object.entries(channels)) {
    if (!value || typeof value !== "object") continue;
    const section = value as Record<string, unknown>;
    if (section.groupPolicy === "open") out.push(`channels.${channelId}.groupPolicy`);
    const accounts = section.accounts;
    if (accounts && typeof accounts === "object") {
      for (const [accountId, accountVal] of Object.entries(accounts)) {
        if (!accountVal || typeof accountVal !== "object") continue;
        const acc = accountVal as Record<string, unknown>;
        if (acc.groupPolicy === "open")
          out.push(`channels.${channelId}.accounts.${accountId}.groupPolicy`);
      }
    }
  }
  return out;
}

export function collectExposureMatrixFindings(cfg: MoltbotConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const openGroups = listGroupPolicyOpen(cfg);
  if (openGroups.length === 0) return findings;

  const elevatedEnabled = cfg.tools?.elevated?.enabled !== false;
  if (elevatedEnabled) {
    findings.push({
      checkId: "security.exposure.open_groups_with_elevated",
      severity: "critical",
      title: "Open groupPolicy with elevated tools enabled",
      detail:
        `Found groupPolicy="open" at:\n${openGroups.map((p) => `- ${p}`).join("\n")}\n` +
        "With tools.elevated enabled, a prompt injection in those rooms can become a high-impact incident.",
      remediation: `Set groupPolicy="allowlist" and keep elevated allowlists extremely tight.`,
    });
  }

  return findings;
}

export async function readConfigSnapshotForAudit(params: {
  env: NodeJS.ProcessEnv;
  configPath: string;
}): Promise<ConfigFileSnapshot> {
  return await createConfigIO({
    env: params.env,
    configPath: params.configPath,
  }).readConfigFileSnapshot();
}
