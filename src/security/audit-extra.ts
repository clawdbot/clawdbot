import fs from "node:fs/promises";
import path from "node:path";

import JSON5 from "json5";

import type { ClawdbotConfig, ConfigFileSnapshot } from "../config/config.js";
import { createConfigIO } from "../config/config.js";
import { resolveOAuthDir } from "../config/paths.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { INCLUDE_KEY, MAX_INCLUDE_DEPTH } from "../config/includes.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  formatOctal,
  isGroupReadable,
  isGroupWritable,
  isWorldReadable,
  isWorldWritable,
  modeBits,
  safeStat,
} from "./audit-fs.js";

export type SecurityAuditFinding = {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

function expandTilde(p: string, env: NodeJS.ProcessEnv): string | null {
  if (!p.startsWith("~")) return p;
  const home = typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : null;
  if (!home) return null;
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return null;
}

function summarizeGroupPolicy(cfg: ClawdbotConfig): {
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

export function collectAttackSurfaceSummaryFindings(cfg: ClawdbotConfig): SecurityAuditFinding[] {
  const group = summarizeGroupPolicy(cfg);
  const elevated = cfg.tools?.elevated?.enabled !== false;
  const hooksEnabled = cfg.hooks?.enabled === true;
  const browserEnabled = Boolean(cfg.browser?.enabled ?? cfg.browser?.controlUrl);

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
      remediation: `Keep CLAWDBOT_STATE_DIR on a local-only volume and re-run "clawdbot security audit --fix".`,
    });
  }
  return findings;
}

function looksLikeEnvRef(value: string): boolean {
  const v = value.trim();
  return v.startsWith("${") && v.endsWith("}");
}

export function collectSecretsInConfigFindings(cfg: ClawdbotConfig): SecurityAuditFinding[] {
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

  const browserToken =
    typeof cfg.browser?.controlToken === "string" ? cfg.browser.controlToken.trim() : "";
  if (browserToken && !looksLikeEnvRef(browserToken)) {
    findings.push({
      checkId: "config.secrets.browser_control_token_in_config",
      severity: "warn",
      title: "Browser control token is stored in config",
      detail:
        "browser.controlToken is set in the config file; prefer environment variables for secrets when possible.",
      remediation:
        "Prefer CLAWDBOT_BROWSER_CONTROL_TOKEN (env) and remove browser.controlToken from disk.",
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

export function collectHooksHardeningFindings(cfg: ClawdbotConfig): SecurityAuditFinding[] {
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

  const gatewayToken =
    typeof cfg.gateway?.auth?.token === "string" && cfg.gateway.auth.token.trim()
      ? cfg.gateway.auth.token.trim()
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

  const browserToken =
    typeof cfg.browser?.controlToken === "string" && cfg.browser.controlToken.trim()
      ? cfg.browser.controlToken.trim()
      : process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN?.trim() || null;
  if (token && browserToken && token === browserToken) {
    findings.push({
      checkId: "hooks.token_reuse_browser_token",
      severity: "warn",
      title: "Hooks token reuses the browser control token",
      detail:
        "hooks.token matches browser control token; compromise of hooks may enable browser control endpoints.",
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

function collectModels(cfg: ClawdbotConfig): ModelRef[] {
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

export function collectModelHygieneFindings(cfg: ClawdbotConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const models = collectModels(cfg);
  if (models.length === 0) return findings;

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

  return findings;
}

export async function collectPluginsTrustFindings(params: {
  cfg: ClawdbotConfig;
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
    findings.push({
      checkId: "plugins.extensions_no_allowlist",
      severity: "warn",
      title: "Extensions exist but plugins.allow is not set",
      detail: `Found ${pluginDirs.length} extension(s) under ${extensionsDir}. Without plugins.allow, any discovered plugin id may load (depending on config and plugin behavior).`,
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
    const st = await safeStat(p);
    if (!st.ok) continue;
    const bits = modeBits(st.mode);
    if (isWorldWritable(bits) || isGroupWritable(bits)) {
      findings.push({
        checkId: "fs.config_include.perms_writable",
        severity: "critical",
        title: "Config include file is writable by others",
        detail: `${p} mode=${formatOctal(bits)}; another user could influence your effective config.`,
        remediation: `chmod 600 ${p}`,
      });
    } else if (isWorldReadable(bits)) {
      findings.push({
        checkId: "fs.config_include.perms_world_readable",
        severity: "critical",
        title: "Config include file is world-readable",
        detail: `${p} mode=${formatOctal(bits)}; include files can contain tokens and private settings.`,
        remediation: `chmod 600 ${p}`,
      });
    } else if (isGroupReadable(bits)) {
      findings.push({
        checkId: "fs.config_include.perms_group_readable",
        severity: "warn",
        title: "Config include file is group-readable",
        detail: `${p} mode=${formatOctal(bits)}; include files can contain tokens and private settings.`,
        remediation: `chmod 600 ${p}`,
      });
    }
  }

  return findings;
}

export async function collectStateDeepFilesystemFindings(params: {
  cfg: ClawdbotConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const oauthDir = resolveOAuthDir(params.env, params.stateDir);

  const oauthStat = await safeStat(oauthDir);
  if (oauthStat.ok && oauthStat.isDir) {
    const bits = modeBits(oauthStat.mode);
    if (isWorldWritable(bits) || isGroupWritable(bits)) {
      findings.push({
        checkId: "fs.credentials_dir.perms_writable",
        severity: "critical",
        title: "Credentials dir is writable by others",
        detail: `${oauthDir} mode=${formatOctal(bits)}; another user could drop/modify credential files.`,
        remediation: `chmod 700 ${oauthDir}`,
      });
    } else if (isGroupReadable(bits) || isWorldReadable(bits)) {
      findings.push({
        checkId: "fs.credentials_dir.perms_readable",
        severity: "warn",
        title: "Credentials dir is readable by others",
        detail: `${oauthDir} mode=${formatOctal(bits)}; credentials and allowlists can be sensitive.`,
        remediation: `chmod 700 ${oauthDir}`,
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
    const authStat = await safeStat(authPath);
    if (authStat.ok) {
      const bits = modeBits(authStat.mode);
      if (isWorldWritable(bits) || isGroupWritable(bits)) {
        findings.push({
          checkId: "fs.auth_profiles.perms_writable",
          severity: "critical",
          title: "auth-profiles.json is writable by others",
          detail: `${authPath} mode=${formatOctal(bits)}; another user could inject credentials.`,
          remediation: `chmod 600 ${authPath}`,
        });
      } else if (isWorldReadable(bits) || isGroupReadable(bits)) {
        findings.push({
          checkId: "fs.auth_profiles.perms_readable",
          severity: "warn",
          title: "auth-profiles.json is readable by others",
          detail: `${authPath} mode=${formatOctal(bits)}; auth-profiles.json contains API keys and OAuth tokens.`,
          remediation: `chmod 600 ${authPath}`,
        });
      }
    }

    const storePath = path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
    // eslint-disable-next-line no-await-in-loop
    const storeStat = await safeStat(storePath);
    if (storeStat.ok) {
      const bits = modeBits(storeStat.mode);
      if (isWorldReadable(bits) || isGroupReadable(bits)) {
        findings.push({
          checkId: "fs.sessions_store.perms_readable",
          severity: "warn",
          title: "sessions.json is readable by others",
          detail: `${storePath} mode=${formatOctal(bits)}; routing and transcript metadata can be sensitive.`,
          remediation: `chmod 600 ${storePath}`,
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
      const st = await safeStat(logPath);
      if (st.ok) {
        const bits = modeBits(st.mode);
        if (isWorldReadable(bits) || isGroupReadable(bits)) {
          findings.push({
            checkId: "fs.log_file.perms_readable",
            severity: "warn",
            title: "Log file is readable by others",
            detail: `${logPath} mode=${formatOctal(bits)}; logs can contain private messages and tool output.`,
            remediation: `chmod 600 ${logPath}`,
          });
        }
      }
    }
  }

  return findings;
}

function listGroupPolicyOpen(cfg: ClawdbotConfig): string[] {
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

export function collectExposureMatrixFindings(cfg: ClawdbotConfig): SecurityAuditFinding[] {
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
