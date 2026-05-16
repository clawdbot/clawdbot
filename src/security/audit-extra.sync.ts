import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { isDangerousNetworkMode, normalizeNetworkMode } from "../agents/sandbox/network-mode.js";
import { resolveSandboxToolPolicyForAgent } from "../agents/sandbox/tool-policy.js";
import type { SandboxToolPolicy } from "../agents/sandbox/types.js";
import { getBlockedBindReason } from "../agents/sandbox/validate-sandbox-security.js";
import { isToolAllowedByPolicies } from "../agents/tool-policy-match.js";
import { resolveToolProfilePolicy } from "../agents/tool-policy.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { resolveAllowedAgentIds } from "../gateway/hooks-policy.js";
import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  listDangerousPluginNodeCommands,
  resolveNodeCommandAllowlist,
} from "../gateway/node-command-policy.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { collectAuditModelRefs } from "./audit-model-refs.js";
import { pickSandboxToolPolicy } from "./audit-tool-policy.js";

/**
 * Synchronous security audit collector functions.
 *
 * These functions analyze config-based security properties without I/O.
 */

export type SecurityAuditFinding = {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

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

function looksLikeEnvRef(value: string): boolean {
  const v = value.trim();
  return v.startsWith("${") && v.endsWith("}");
}

function isGatewayRemotelyExposed(cfg: OpenClawConfig): boolean {
  const bind = typeof cfg.gateway?.bind === "string" ? cfg.gateway.bind : "loopback";
  if (bind !== "loopback") {
    return true;
  }
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  return tailscaleMode === "serve" || tailscaleMode === "funnel";
}

const LEGACY_MODEL_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "openai.gpt35", re: /\bgpt-3\.5\b/i, label: "GPT-3.5 family" },
  { id: "anthropic.claude2", re: /\bclaude-(instant|2)\b/i, label: "Claude 2/Instant family" },
  { id: "openai.gpt4_legacy", re: /\bgpt-4-(0314|0613)\b/i, label: "Legacy GPT-4 snapshots" },
];

const WEAK_TIER_MODEL_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "anthropic.haiku", re: /\bhaiku\b/i, label: "Haiku tier (smaller model)" },
];

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
  // Match claude-*-4-5+, claude-*-45+, claude-*4.5+, or future 5.x+ majors.
  return /\bclaude-[^\s/]*?(?:-4-?(?:[5-9]|[1-9]\d)\b|4\.(?:[5-9]|[1-9]\d)\b|-[5-9](?:\b|[.-]))/i.test(
    id,
  );
}

function hasConfiguredDockerConfig(
  docker: Record<string, unknown> | undefined | null,
): docker is Record<string, unknown> {
  if (!docker || typeof docker !== "object") {
    return false;
  }
  return Object.values(docker).some((value) => value !== undefined);
}

function normalizeNodeCommand(value: unknown): string {
  return normalizeOptionalString(value) ?? "";
}

function isWildcardEntry(value: unknown): boolean {
  return normalizeStringifiedOptionalString(value) === "*";
}

function listKnownNodeCommands(cfg: OpenClawConfig): Set<string> {
  const baseCfg: OpenClawConfig = {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      nodes: {
        ...cfg.gateway?.nodes,
        denyCommands: [],
      },
    },
  };
  const out = new Set<string>();
  const platformNodes = [
    { platform: "ios", deviceFamily: "iPhone" },
    { platform: "android", deviceFamily: "Android" },
    {
      platform: "macos",
      deviceFamily: "Mac",
      approvedCommands: [
        "system.run",
        "system.run.prepare",
        "system.which",
        "browser.proxy",
        "screen.snapshot",
      ],
    },
    {
      platform: "linux",
      deviceFamily: "Linux",
      approvedCommands: ["system.run", "system.run.prepare", "system.which", "browser.proxy"],
    },
    {
      platform: "windows",
      deviceFamily: "Windows",
      approvedCommands: [
        "system.run",
        "system.run.prepare",
        "system.which",
        "browser.proxy",
        "screen.snapshot",
      ],
    },
    { platform: "unknown" },
  ];
  for (const node of platformNodes) {
    const allow = resolveNodeCommandAllowlist(baseCfg, node);
    for (const cmd of allow) {
      const normalized = normalizeNodeCommand(cmd);
      if (normalized) {
        out.add(normalized);
      }
    }
  }
  for (const cmd of resolveNodeCommandAllowlist(baseCfg, { caps: ["talk"] })) {
    const normalized = normalizeNodeCommand(cmd);
    if (normalized) {
      out.add(normalized);
    }
  }
  for (const cmd of DEFAULT_DANGEROUS_NODE_COMMANDS) {
    const normalized = normalizeNodeCommand(cmd);
    if (normalized) {
      out.add(normalized);
    }
  }
  return out;
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

function looksLikeNodeCommandPattern(value: string): boolean {
  if (!value) {
    return false;
  }
  if (/[?*[\]{}(),|]/.test(value)) {
    return true;
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.startsWith("^") ||
    value.endsWith("$")
  ) {
    return true;
  }
  return /\s/.test(value) || value.includes("group:");
}

function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (!a) {
    return b.length;
  }
  if (!b) {
    return a.length;
  }

  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }

  return dp[b.length];
}

function suggestKnownNodeCommands(unknown: string, known: Set<string>): string[] {
  const needle = unknown.trim();
  if (!needle) {
    return [];
  }

  // Fast path: prefix-ish suggestions.
  const prefix = needle.includes(".") ? needle.split(".").slice(0, 2).join(".") : needle;
  const prefixHits = Array.from(known)
    .filter((cmd) => cmd.startsWith(prefix))
    .slice(0, 3);
  if (prefixHits.length > 0) {
    return prefixHits;
  }

  // Fuzzy: Levenshtein over a small-ish known set.
  const ranked = Array.from(known)
    .map((cmd) => ({ cmd, d: editDistance(needle, cmd) }))
    .toSorted((a, b) => a.d - b.d || a.cmd.localeCompare(b.cmd));

  const best = ranked[0]?.d ?? Infinity;
  const threshold = Math.max(2, Math.min(4, best));
  return ranked
    .filter((r) => r.d <= threshold)
    .slice(0, 3)
    .map((r) => r.cmd);
}

function listGroupPolicyOpen(cfg: OpenClawConfig): string[] {
  const out: string[] = [];
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels || typeof channels !== "object") {
    return out;
  }
  for (const [channelId, value] of Object.entries(channels)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const section = value as Record<string, unknown>;
    if (section.groupPolicy === "open") {
      out.push(`channels.${channelId}.groupPolicy`);
    }
    const accounts = section.accounts;
    if (accounts && typeof accounts === "object") {
      for (const [accountId, accountVal] of Object.entries(accounts)) {
        if (!accountVal || typeof accountVal !== "object") {
          continue;
        }
        const acc = accountVal as Record<string, unknown>;
        if (acc.groupPolicy === "open") {
          out.push(`channels.${channelId}.accounts.${accountId}.groupPolicy`);
        }
      }
    }
  }
  return out;
}

function hasConfiguredGroupTargets(section: Record<string, unknown>): boolean {
  const groupKeys = ["groups", "guilds", "channels", "rooms"];
  return groupKeys.some((key) => {
    const value = section[key];
    return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
  });
}

function listPotentialMultiUserSignals(cfg: OpenClawConfig): string[] {
  const out = new Set<string>();
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels || typeof channels !== "object") {
    return [];
  }

  const inspectSection = (section: Record<string, unknown>, basePath: string) => {
    const groupPolicy = typeof section.groupPolicy === "string" ? section.groupPolicy : null;
    if (groupPolicy === "open") {
      out.add(`${basePath}.groupPolicy="open"`);
    } else if (groupPolicy === "allowlist" && hasConfiguredGroupTargets(section)) {
      out.add(`${basePath}.groupPolicy="allowlist" with configured group targets`);
    }

    const dmPolicy = typeof section.dmPolicy === "string" ? section.dmPolicy : null;
    if (dmPolicy === "open") {
      out.add(`${basePath}.dmPolicy="open"`);
    }

    const allowFrom = Array.isArray(section.allowFrom) ? section.allowFrom : [];
    if (allowFrom.some((entry) => isWildcardEntry(entry))) {
      out.add(`${basePath}.allowFrom includes "*"`);
    }

    const groupAllowFrom = Array.isArray(section.groupAllowFrom) ? section.groupAllowFrom : [];
    if (groupAllowFrom.some((entry) => isWildcardEntry(entry))) {
      out.add(`${basePath}.groupAllowFrom includes "*"`);
    }

    const dm = section.dm;
    if (dm && typeof dm === "object") {
      const dmSection = dm as Record<string, unknown>;
      const dmLegacyPolicy = typeof dmSection.policy === "string" ? dmSection.policy : null;
      if (dmLegacyPolicy === "open") {
        out.add(`${basePath}.dm.policy="open"`);
      }
      const dmAllowFrom = Array.isArray(dmSection.allowFrom) ? dmSection.allowFrom : [];
      if (dmAllowFrom.some((entry) => isWildcardEntry(entry))) {
        out.add(`${basePath}.dm.allowFrom includes "*"`);
      }
    }
  };

  for (const [channelId, value] of Object.entries(channels)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const section = value as Record<string, unknown>;
    inspectSection(section, `channels.${channelId}`);
    const accounts = section.accounts;
    if (!accounts || typeof accounts !== "object") {
      continue;
    }
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      if (!accountValue || typeof accountValue !== "object") {
        continue;
      }
      inspectSection(
        accountValue as Record<string, unknown>,
        `channels.${channelId}.accounts.${accountId}`,
      );
    }
  }

  return Array.from(out);
}

function collectRiskyToolExposureContexts(cfg: OpenClawConfig): {
  riskyContexts: string[];
  hasRuntimeRisk: boolean;
} {
  const contexts: Array<{
    label: string;
    agentId?: string;
    tools?: AgentToolsConfig;
  }> = [{ label: "agents.defaults" }];
  for (const agent of cfg.agents?.list ?? []) {
    if (!agent || typeof agent !== "object" || typeof agent.id !== "string") {
      continue;
    }
    contexts.push({
      label: `agents.list.${agent.id}`,
      agentId: agent.id,
      tools: agent.tools,
    });
  }

  const riskyContexts: string[] = [];
  let hasRuntimeRisk = false;
  for (const context of contexts) {
    const sandboxMode = resolveSandboxConfigForAgent(cfg, context.agentId).mode;
    const policies = resolveToolPolicies({
      cfg,
      agentTools: context.tools,
      sandboxMode,
      agentId: context.agentId ?? null,
    });
    const runtimeTools = ["exec", "process"].filter((tool) =>
      isToolAllowedByPolicies(tool, policies),
    );
    const fsTools = ["read", "write", "edit", "apply_patch"].filter((tool) =>
      isToolAllowedByPolicies(tool, policies),
    );
    const fsWorkspaceOnly = context.tools?.fs?.workspaceOnly ?? cfg.tools?.fs?.workspaceOnly;
    const runtimeUnguarded = runtimeTools.length > 0 && sandboxMode !== "all";
    const fsUnguarded = fsTools.length > 0 && sandboxMode !== "all" && fsWorkspaceOnly !== true;
    if (!runtimeUnguarded && !fsUnguarded) {
      continue;
    }
    if (runtimeUnguarded) {
      hasRuntimeRisk = true;
    }
    riskyContexts.push(
      `${context.label} (sandbox=${sandboxMode}; runtime=[${runtimeTools.join(", ") || "off"}]; fs=[${fsTools.join(", ") || "off"}]; fs.workspaceOnly=${
        fsWorkspaceOnly === true ? "true" : "false"
      })`,
    );
  }

  return { riskyContexts, hasRuntimeRisk };
}

// --------------------------------------------------------------------------
// Exported collectors
// --------------------------------------------------------------------------

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
      remediation: `Keep OPENCLAW_STATE_DIR on a local-only volume and re-run "${formatCliCommand("openclaw security audit --fix")}".`,
    });
  }
  return findings;
}

export function collectSecretsInConfigFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const password = normalizeOptionalString(cfg.gateway?.auth?.password) ?? "";
  if (password && !looksLikeEnvRef(password)) {
    findings.push({
      checkId: "config.secrets.gateway_password_in_config",
      severity: "warn",
      title: "Gateway password is stored in config",
      detail:
        "gateway.auth.password is set in the config file; prefer environment variables for secrets when possible.",
      remediation:
        "Prefer OPENCLAW_GATEWAY_PASSWORD (env) and remove gateway.auth.password from disk.",
    });
  }

  const hooksToken = normalizeOptionalString(cfg.hooks?.token) ?? "";
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

export function collectHooksHardeningFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  if (cfg.hooks?.enabled !== true) {
    return findings;
  }

  const token = normalizeOptionalString(cfg.hooks?.token) ?? "";
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
    env,
  });
  const openclawGatewayToken =
    typeof env.OPENCLAW_GATEWAY_TOKEN === "string" && env.OPENCLAW_GATEWAY_TOKEN.trim()
      ? env.OPENCLAW_GATEWAY_TOKEN.trim()
      : null;
  const gatewayToken =
    gatewayAuth.mode === "token" &&
    typeof gatewayAuth.token === "string" &&
    gatewayAuth.token.trim()
      ? gatewayAuth.token.trim()
      : openclawGatewayToken
        ? openclawGatewayToken
        : null;
  if (token && gatewayToken && token === gatewayToken) {
    findings.push({
      checkId: "hooks.token_reuse_gateway_token",
      severity: "critical",
      title: "Hooks token reuses the Gateway token",
      detail:
        "hooks.token matches gateway.auth token; compromise of hooks expands blast radius to the Gateway API.",
      remediation: "Use a separate hooks.token dedicated to hook ingress.",
    });
  }

  const rawPath = normalizeOptionalString(cfg.hooks?.path) ?? "";
  if (rawPath === "/") {
    findings.push({
      checkId: "hooks.path_root",
      severity: "critical",
      title: "Hooks base path is '/'",
      detail: "hooks.path='/' would shadow other HTTP endpoints and is unsafe.",
      remediation: "Use a dedicated path like '/hooks'.",
    });
  }

  const allowRequestSessionKey = cfg.hooks?.allowRequestSessionKey === true;
  const defaultSessionKey = normalizeOptionalString(cfg.hooks?.defaultSessionKey) ?? "";
  const allowedAgentIds = resolveAllowedAgentIds(cfg.hooks?.allowedAgentIds);
  const allowedPrefixes = Array.isArray(cfg.hooks?.allowedSessionKeyPrefixes)
    ? cfg.hooks.allowedSessionKeyPrefixes
        .map((prefix) => prefix.trim())
        .filter((prefix) => prefix.length > 0)
    : [];
  const remoteExposure = isGatewayRemotelyExposed(cfg);

  if (!defaultSessionKey) {
    findings.push({
      checkId: "hooks.default_session_key_unset",
      severity: "warn",
      title: "hooks.defaultSessionKey is not configured",
      detail:
        "Hook agent runs without explicit sessionKey use generated per-request keys. Set hooks.defaultSessionKey to keep hook ingress scoped to a known session.",
      remediation: 'Set hooks.defaultSessionKey (for example, "hook:ingress").',
    });
  }

  if (allowedAgentIds === undefined) {
    findings.push({
      checkId: "hooks.allowed_agent_ids_unrestricted",
      severity: remoteExposure ? "critical" : "warn",
      title: "Hook agent routing allows any configured agent",
      detail:
        "hooks.allowedAgentIds is unset or includes '*', so authenticated hook callers may route to any configured agent id.",
      remediation:
        'Set hooks.allowedAgentIds to an explicit allowlist (for example, ["hooks", "main"]) or [] to deny explicit agent routing.',
    });
  }

  if (allowRequestSessionKey) {
    findings.push({
      checkId: "hooks.request_session_key_enabled",
      severity: remoteExposure ? "critical" : "warn",
      title: "External hook payloads may override sessionKey",
      detail:
        "hooks.allowRequestSessionKey=true allows `/hooks/agent` callers to choose the session key. Treat hook token holders as full-trust unless you also restrict prefixes.",
      remediation:
        "Set hooks.allowRequestSessionKey=false (recommended) or constrain hooks.allowedSessionKeyPrefixes.",
    });
  }

  if (allowRequestSessionKey && allowedPrefixes.length === 0) {
    findings.push({
      checkId: "hooks.request_session_key_prefixes_missing",
      severity: remoteExposure ? "critical" : "warn",
      title: "Request sessionKey override is enabled without prefix restrictions",
      detail:
        "hooks.allowRequestSessionKey=true and hooks.allowedSessionKeyPrefixes is unset/empty, so request payloads can target arbitrary session key shapes.",
      remediation:
        'Set hooks.allowedSessionKeyPrefixes (for example, ["hook:"]) or disable request overrides.',
    });
  }

  return findings;
}

export function collectGatewayHttpSessionKeyOverrideFindings(
  cfg: OpenClawConfig,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const chatCompletionsEnabled = cfg.gateway?.http?.endpoints?.chatCompletions?.enabled === true;
  const responsesEnabled = cfg.gateway?.http?.endpoints?.responses?.enabled === true;
  if (!chatCompletionsEnabled && !responsesEnabled) {
    return findings;
  }

  const enabledEndpoints = [
    chatCompletionsEnabled ? "/v1/chat/completions" : null,
    responsesEnabled ? "/v1/responses" : null,
  ].filter((entry): entry is string => Boolean(entry));

  findings.push({
    checkId: "gateway.http.session_key_override_enabled",
    severity: "info",
    title: "HTTP API session-key override is enabled",
    detail:
      `${enabledEndpoints.join(", ")} accept x-openclaw-session-key for per-request session routing. ` +
      "Treat API credential holders as trusted principals.",
  });

  return findings;
}

export function collectGatewayHttpNoAuthFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, tailscaleMode, env });
  if (auth.mode !== "none") {
    return findings;
  }

  const chatCompletionsEnabled = cfg.gateway?.http?.endpoints?.chatCompletions?.enabled === true;
  const responsesEnabled = cfg.gateway?.http?.endpoints?.responses?.enabled === true;
  const adminHttpRpcEnabled = cfg.plugins?.entries?.["admin-http-rpc"]?.enabled === true;
  const enabledEndpoints = [
    "/tools/invoke",
    chatCompletionsEnabled ? "/v1/chat/completions" : null,
    responsesEnabled ? "/v1/responses" : null,
    adminHttpRpcEnabled ? "/api/v1/admin/rpc" : null,
  ].filter((entry): entry is string => Boolean(entry));

  const remoteExposure = isGatewayRemotelyExposed(cfg);
  findings.push({
    checkId: "gateway.http.no_auth",
    severity: remoteExposure ? "critical" : "warn",
    title: "Gateway HTTP APIs are reachable without auth",
    detail:
      `gateway.auth.mode="none" leaves ${enabledEndpoints.join(", ")} callable without a shared secret. ` +
      "Treat this as trusted-local only and avoid exposing the gateway beyond loopback.",
    remediation:
      "Set gateway.auth.mode to token/password (recommended). If you intentionally keep mode=none, keep gateway.bind=loopback and disable optional HTTP endpoints/plugins.",
  });

  return findings;
}

export function collectSandboxDockerNoopFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const configuredPaths: string[] = [];
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];

  const defaultsSandbox = cfg.agents?.defaults?.sandbox;
  const hasDefaultDocker = hasConfiguredDockerConfig(
    defaultsSandbox?.docker as Record<string, unknown> | undefined,
  );
  const defaultMode = defaultsSandbox?.mode ?? "off";
  const hasAnySandboxEnabledAgent = agents.some((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      return false;
    }
    return resolveSandboxConfigForAgent(cfg, entry.id).mode !== "off";
  });
  if (hasDefaultDocker && defaultMode === "off" && !hasAnySandboxEnabledAgent) {
    configuredPaths.push("agents.defaults.sandbox.docker");
  }

  for (const entry of agents) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    if (!hasConfiguredDockerConfig(entry.sandbox?.docker as Record<string, unknown> | undefined)) {
      continue;
    }
    if (resolveSandboxConfigForAgent(cfg, entry.id).mode === "off") {
      configuredPaths.push(`agents.list.${entry.id}.sandbox.docker`);
    }
  }

  if (configuredPaths.length === 0) {
    return findings;
  }

  findings.push({
    checkId: "sandbox.docker_config_mode_off",
    severity: "warn",
    title: "Sandbox docker settings configured while sandbox mode is off",
    detail:
      "These docker settings will not take effect until sandbox mode is enabled:\n" +
      configuredPaths.map((entry) => `- ${entry}`).join("\n"),
    remediation:
      'Enable sandbox mode (`agents.defaults.sandbox.mode="non-main"` or `"all"`) where needed, or remove unused docker settings.',
  });

  return findings;
}

export function collectSandboxDangerousConfigFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];

  const configs: Array<{ source: string; docker: Record<string, unknown> }> = [];
  const defaultDocker = cfg.agents?.defaults?.sandbox?.docker;
  if (defaultDocker && typeof defaultDocker === "object") {
    configs.push({
      source: "agents.defaults.sandbox.docker",
      docker: defaultDocker as Record<string, unknown>,
    });
  }
  for (const entry of agents) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    const agentDocker = entry.sandbox?.docker;
    if (agentDocker && typeof agentDocker === "object") {
      configs.push({
        source: `agents.list.${entry.id}.sandbox.docker`,
        docker: agentDocker as Record<string, unknown>,
      });
    }
  }

  for (const { source, docker } of configs) {
    const binds = Array.isArray(docker.binds) ? docker.binds : [];
    for (const bind of binds) {
      if (typeof bind !== "string") {
        continue;
      }
      const blocked = getBlockedBindReason(bind);
      if (!blocked) {
        continue;
      }
      if (blocked.kind === "non_absolute") {
        findings.push({
          checkId: "sandbox.bind_mount_non_absolute",
          severity: "warn",
          title: "Sandbox bind mount uses a non-absolute source path",
          detail:
            `${source}.binds contains "${bind}" which uses source path "${blocked.sourcePath}". ` +
            "Non-absolute bind sources are hard to validate safely and may resolve unexpectedly.",
          remediation: `Rewrite "${bind}" to use an absolute host path (for example: /home/user/project:/project:ro).`,
        });
        continue;
      }
      if (blocked.kind !== "covers" && blocked.kind !== "targets") {
        continue;
      }
      const verb = blocked.kind === "covers" ? "covers" : "targets";
      findings.push({
        checkId: "sandbox.dangerous_bind_mount",
        severity: "critical",
        title: "Dangerous bind mount in sandbox config",
        detail:
          `${source}.binds contains "${bind}" which ${verb} blocked path "${blocked.blockedPath}". ` +
          "This can expose host system directories or the Docker socket to sandbox containers.",
        remediation: `Remove "${bind}" from ${source}.binds. Use project-specific paths instead.`,
      });
    }

    const network = typeof docker.network === "string" ? docker.network : undefined;
    const normalizedNetwork = normalizeNetworkMode(network);
    if (isDangerousNetworkMode(network)) {
      const modeLabel = normalizedNetwork === "host" ? '"host"' : `"${network}"`;
      const detail =
        normalizedNetwork === "host"
          ? `${source}.network is "host" which bypasses container network isolation entirely.`
          : `${source}.network is ${modeLabel} which joins another container namespace and can bypass sandbox network isolation.`;
      findings.push({
        checkId: "sandbox.dangerous_network_mode",
        severity: "critical",
        title: "Dangerous network mode in sandbox config",
        detail,
        remediation:
          `Set ${source}.network to "bridge", "none", or a custom bridge network name.` +
          ` Use ${source}.dangerouslyAllowContainerNamespaceJoin=true only as a break-glass override when you fully trust this runtime.`,
      });
    }

    const seccompProfile =
      typeof docker.seccompProfile === "string" ? docker.seccompProfile : undefined;
    if (normalizeOptionalLowercaseString(seccompProfile) === "unconfined") {
      findings.push({
        checkId: "sandbox.dangerous_seccomp_profile",
        severity: "critical",
        title: "Seccomp unconfined in sandbox config",
        detail: `${source}.seccompProfile is "unconfined" which disables syscall filtering.`,
        remediation: `Remove ${source}.seccompProfile or use a custom seccomp profile file.`,
      });
    }

    const apparmorProfile =
      typeof docker.apparmorProfile === "string" ? docker.apparmorProfile : undefined;
    if (normalizeOptionalLowercaseString(apparmorProfile) === "unconfined") {
      findings.push({
        checkId: "sandbox.dangerous_apparmor_profile",
        severity: "critical",
        title: "AppArmor unconfined in sandbox config",
        detail: `${source}.apparmorProfile is "unconfined" which disables AppArmor enforcement.`,
        remediation: `Remove ${source}.apparmorProfile or use a named AppArmor profile.`,
      });
    }
  }

  // CDP source range is now auto-derived at runtime from the Docker network gateway
  // for all bridge-like networks, so an unset cdpSourceRange is no longer a security gap.

  return findings;
}

export function collectNodeDenyCommandPatternFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const denyListRaw = cfg.gateway?.nodes?.denyCommands;
  if (!Array.isArray(denyListRaw) || denyListRaw.length === 0) {
    return findings;
  }

  const denyList = denyListRaw.map(normalizeNodeCommand).filter(Boolean);
  if (denyList.length === 0) {
    return findings;
  }

  const knownCommands = listKnownNodeCommands(cfg);
  const patternLike = denyList.filter((entry) => looksLikeNodeCommandPattern(entry));
  const unknownExact = denyList.filter(
    (entry) => !looksLikeNodeCommandPattern(entry) && !knownCommands.has(entry),
  );
  if (patternLike.length === 0 && unknownExact.length === 0) {
    return findings;
  }

  const detailParts: string[] = [];
  if (patternLike.length > 0) {
    detailParts.push(
      `Pattern-like entries (not supported by exact matching): ${patternLike.join(", ")}`,
    );
  }
  if (unknownExact.length > 0) {
    const unknownDetails = unknownExact
      .map((entry) => {
        const suggestions = suggestKnownNodeCommands(entry, knownCommands);
        if (suggestions.length === 0) {
          return entry;
        }
        return `${entry} (did you mean: ${suggestions.join(", ")})`;
      })
      .join(", ");

    detailParts.push(`Unknown command names (not in defaults/allowCommands): ${unknownDetails}`);
  }
  const examples = Array.from(knownCommands).slice(0, 8);

  findings.push({
    checkId: "gateway.nodes.deny_commands_ineffective",
    severity: "warn",
    title: "Some gateway.nodes.denyCommands entries are ineffective",
    detail:
      "gateway.nodes.denyCommands uses exact node command-name matching only (for example `system.run`), not shell-text filtering inside a command payload.\n" +
      detailParts.map((entry) => `- ${entry}`).join("\n"),
    remediation:
      `Use exact command names (for example: ${examples.join(", ")}). ` +
      "If you need broader restrictions, remove risky command IDs from allowCommands/default workflows and tighten tools.exec policy.",
  });

  return findings;
}

export function collectNodeDangerousAllowCommandFindings(
  cfg: OpenClawConfig,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const allowRaw = cfg.gateway?.nodes?.allowCommands;
  if (!Array.isArray(allowRaw) || allowRaw.length === 0) {
    return findings;
  }

  const allow = new Set(allowRaw.map(normalizeNodeCommand).filter(Boolean));
  if (allow.size === 0) {
    return findings;
  }

  const deny = new Set((cfg.gateway?.nodes?.denyCommands ?? []).map(normalizeNodeCommand));
  const dangerousAllowed = [
    ...DEFAULT_DANGEROUS_NODE_COMMANDS,
    ...listDangerousPluginNodeCommands(),
  ].filter((cmd) => allow.has(cmd) && !deny.has(cmd));
  if (dangerousAllowed.length === 0) {
    return findings;
  }

  findings.push({
    checkId: "gateway.nodes.allow_commands_dangerous",
    severity: isGatewayRemotelyExposed(cfg) ? "critical" : "warn",
    title: "Dangerous node commands explicitly enabled",
    detail:
      `gateway.nodes.allowCommands includes: ${dangerousAllowed.join(", ")}. ` +
      "These commands can trigger high-impact device actions or read node files (camera/screen/contacts/calendar/reminders/SMS/file).",
    remediation:
      "Remove these entries from gateway.nodes.allowCommands (recommended). " +
      "If you keep them, treat gateway auth as full operator access and keep gateway exposure local/tailnet-only.",
  });

  return findings;
}

export function collectMinimalProfileOverrideFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  if (cfg.tools?.profile !== "minimal") {
    return findings;
  }

  const overrides = (cfg.agents?.list ?? [])
    .filter((entry): entry is { id: string; tools?: AgentToolsConfig } => {
      return Boolean(
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        entry.tools?.profile &&
        entry.tools.profile !== "minimal",
      );
    })
    .map((entry) => `${entry.id}=${entry.tools?.profile}`);

  if (overrides.length === 0) {
    return findings;
  }

  findings.push({
    checkId: "tools.profile_minimal_overridden",
    severity: "warn",
    title: "Global tools.profile=minimal is overridden by agent profiles",
    detail:
      "Global minimal profile is set, but these agent profiles take precedence:\n" +
      overrides.map((entry) => `- agents.list.${entry}`).join("\n"),
    remediation:
      'Set those agents to `tools.profile="minimal"` (or remove the agent override) if you want minimal tools enforced globally.',
  });

  return findings;
}

export function collectModelHygieneFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const models = collectAuditModelRefs(cfg);
  if (models.length === 0) {
    return findings;
  }

  const weakMatches = new Map<string, { model: string; source: string; reasons: string[] }>();
  const addWeakMatch = (model: string, source: string, reason: string) => {
    const key = `${model}@@${source}`;
    const existing = weakMatches.get(key);
    if (!existing) {
      weakMatches.set(key, { model, source, reasons: [reason] });
      return;
    }
    if (!existing.reasons.includes(reason)) {
      existing.reasons.push(reason);
    }
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

export function collectExposureMatrixFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const openGroups = listGroupPolicyOpen(cfg);
  if (openGroups.length === 0) {
    return findings;
  }

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

  const { riskyContexts, hasRuntimeRisk } = collectRiskyToolExposureContexts(cfg);

  if (riskyContexts.length > 0) {
    findings.push({
      checkId: "security.exposure.open_groups_with_runtime_or_fs",
      severity: hasRuntimeRisk ? "critical" : "warn",
      title: "Open groupPolicy with runtime/filesystem tools exposed",
      detail:
        `Found groupPolicy="open" at:\n${openGroups.map((p) => `- ${p}`).join("\n")}\n` +
        `Risky tool exposure contexts:\n${riskyContexts.map((line) => `- ${line}`).join("\n")}\n` +
        "Prompt injection in open groups can trigger command/file actions in these contexts.",
      remediation:
        'For open groups, prefer tools.profile="messaging" (or deny group:runtime/group:fs), set tools.fs.workspaceOnly=true, and use agents.defaults.sandbox.mode="all" for exposed agents.',
    });
  }

  return findings;
}

export function collectLikelyMultiUserSetupFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const signals = listPotentialMultiUserSignals(cfg);
  if (signals.length === 0) {
    return findings;
  }

  const { riskyContexts, hasRuntimeRisk } = collectRiskyToolExposureContexts(cfg);
  const impactLine = hasRuntimeRisk
    ? "Runtime/process tools are exposed without full sandboxing in at least one context."
    : "No unguarded runtime/process tools were detected by this heuristic.";
  const riskyContextsDetail =
    riskyContexts.length > 0
      ? `Potential high-impact tool exposure contexts:\n${riskyContexts.map((line) => `- ${line}`).join("\n")}`
      : "No unguarded runtime/filesystem contexts detected.";

  findings.push({
    checkId: "security.trust_model.multi_user_heuristic",
    severity: "warn",
    title: "Potential multi-user setup detected (personal-assistant model warning)",
    detail:
      "Heuristic signals indicate this gateway may be reachable by multiple users:\n" +
      signals.map((signal) => `- ${signal}`).join("\n") +
      `\n${impactLine}\n${riskyContextsDetail}\n` +
      "OpenClaw's default security model is personal-assistant (one trusted operator boundary), not hostile multi-tenant isolation on one shared gateway.",
    remediation:
      'If users may be mutually untrusted, split trust boundaries (separate gateways + credentials, ideally separate OS users/hosts). If you intentionally run shared-user access, set agents.defaults.sandbox.mode="all", keep tools.fs.workspaceOnly=true, deny runtime/fs/web tools unless required, and keep personal/private identities + credentials off that runtime.',
  });

  return findings;
}
