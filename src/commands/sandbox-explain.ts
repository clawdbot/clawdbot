import { resolveAgentConfig } from "../agents/agent-scope.js";
import {
  resolveSandboxConfigForAgent,
  resolveSandboxToolPolicyForAgent,
} from "../agents/sandbox.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";

type SandboxExplainOptions = {
  session?: string;
  agent?: string;
  json: boolean;
};

const SANDBOX_DOCS_URL = "https://docs.clawd.bot/sandbox";

function normalizeExplainSessionKey(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  session?: string;
}): string {
  const raw = (params.session ?? "").trim();
  if (!raw) {
    return resolveAgentMainSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
    });
  }
  if (raw.includes(":")) return raw;
  if (raw === "global") return "global";
  return buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: normalizeMainKey(raw),
  });
}

function inferProviderFromSessionKey(params: {
  cfg: ClawdbotConfig;
  sessionKey: string;
}): string | undefined {
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed) return undefined;
  const rest = parsed.rest.trim();
  if (!rest) return undefined;
  const parts = rest.split(":").filter(Boolean);
  if (parts.length === 0) return undefined;
  const configuredMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (parts[0] === configuredMainKey) return undefined;
  const candidate = parts[0]?.trim().toLowerCase();
  if (!candidate) return undefined;
  if (candidate === INTERNAL_MESSAGE_CHANNEL) return INTERNAL_MESSAGE_CHANNEL;
  return normalizeChannelId(candidate) ?? undefined;
}

function resolveActiveChannel(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  sessionKey: string;
}): string | undefined {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey] as
    | {
        lastChannel?: string;
        channel?: string;
        // Legacy keys (pre-rename).
        lastProvider?: string;
        provider?: string;
      }
    | undefined;
  const candidate = (
    entry?.lastChannel ??
    entry?.channel ??
    entry?.lastProvider ??
    entry?.provider ??
    ""
  )
    .trim()
    .toLowerCase();
  if (candidate === INTERNAL_MESSAGE_CHANNEL) return INTERNAL_MESSAGE_CHANNEL;
  const normalized = normalizeChannelId(candidate);
  if (normalized) return normalized;
  return inferProviderFromSessionKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
}

export async function sandboxExplainCommand(
  opts: SandboxExplainOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = loadConfig();

  const defaultAgentId = resolveAgentIdFromSessionKey(resolveMainSessionKey(cfg));
  const resolvedAgentId = normalizeAgentId(
    opts.agent?.trim()
      ? opts.agent
      : opts.session?.trim()
        ? resolveAgentIdFromSessionKey(opts.session)
        : defaultAgentId,
  );

  const sessionKey = normalizeExplainSessionKey({
    cfg,
    agentId: resolvedAgentId,
    session: opts.session,
  });

  const sandboxCfg = resolveSandboxConfigForAgent(cfg, resolvedAgentId);
  const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, resolvedAgentId);
  const mainSessionKey = resolveAgentMainSessionKey({
    cfg,
    agentId: resolvedAgentId,
  });
  const sessionIsSandboxed =
    sandboxCfg.mode === "all"
      ? true
      : sandboxCfg.mode === "off"
        ? false
        : sessionKey.trim() !== mainSessionKey.trim();

  const channel = resolveActiveChannel({
    cfg,
    agentId: resolvedAgentId,
    sessionKey,
  });

  const agentConfig = resolveAgentConfig(cfg, resolvedAgentId);
  const elevatedGlobal = cfg.tools?.elevated;
  const elevatedAgent = agentConfig?.tools?.elevated;
  const elevatedGlobalEnabled = elevatedGlobal?.enabled !== false;
  const elevatedAgentEnabled = elevatedAgent?.enabled !== false;
  const elevatedEnabled = elevatedGlobalEnabled && elevatedAgentEnabled;

  const globalAllow = channel ? elevatedGlobal?.allowFrom?.[channel] : undefined;
  const agentAllow = channel ? elevatedAgent?.allowFrom?.[channel] : undefined;

  const allowTokens = (values?: Array<string | number>) =>
    (values ?? []).map((v) => String(v).trim()).filter(Boolean);
  const globalAllowTokens = allowTokens(globalAllow);
  const agentAllowTokens = allowTokens(agentAllow);

  const elevatedAllowedByConfig =
    elevatedEnabled &&
    Boolean(channel) &&
    globalAllowTokens.length > 0 &&
    (elevatedAgent?.allowFrom ? agentAllowTokens.length > 0 : true);

  const elevatedAlwaysAllowedByConfig =
    elevatedAllowedByConfig &&
    globalAllowTokens.includes("*") &&
    (elevatedAgent?.allowFrom ? agentAllowTokens.includes("*") : true);

  const elevatedFailures: Array<{ gate: string; key: string }> = [];
  if (!elevatedGlobalEnabled) {
    elevatedFailures.push({ gate: "enabled", key: "tools.elevated.enabled" });
  }
  if (!elevatedAgentEnabled) {
    elevatedFailures.push({
      gate: "enabled",
      key: "agents.list[].tools.elevated.enabled",
    });
  }
  if (channel && globalAllowTokens.length === 0) {
    elevatedFailures.push({
      gate: "allowFrom",
      key: `tools.elevated.allowFrom.${channel}`,
    });
  }
  if (channel && elevatedAgent?.allowFrom && agentAllowTokens.length === 0) {
    elevatedFailures.push({
      gate: "allowFrom",
      key: `agents.list[].tools.elevated.allowFrom.${channel}`,
    });
  }

  const fixIt: string[] = [];
  if (sandboxCfg.mode !== "off") {
    fixIt.push("agents.defaults.sandbox.mode=off");
    fixIt.push("agents.list[].sandbox.mode=off");
  }
  fixIt.push("tools.sandbox.tools.allow");
  fixIt.push("tools.sandbox.tools.deny");
  fixIt.push("agents.list[].tools.sandbox.tools.allow");
  fixIt.push("agents.list[].tools.sandbox.tools.deny");
  fixIt.push("tools.elevated.enabled");
  if (channel) fixIt.push(`tools.elevated.allowFrom.${channel}`);

  const payload = {
    docsUrl: SANDBOX_DOCS_URL,
    agentId: resolvedAgentId,
    sessionKey,
    mainSessionKey,
    sandbox: {
      mode: sandboxCfg.mode,
      scope: sandboxCfg.scope,
      perSession: sandboxCfg.scope === "session",
      workspaceAccess: sandboxCfg.workspaceAccess,
      workspaceRoot: sandboxCfg.workspaceRoot,
      sessionIsSandboxed,
      tools: {
        allow: toolPolicy.allow,
        deny: toolPolicy.deny,
        sources: toolPolicy.sources,
      },
    },
    elevated: {
      enabled: elevatedEnabled,
      channel,
      allowedByConfig: elevatedAllowedByConfig,
      alwaysAllowedByConfig: elevatedAlwaysAllowedByConfig,
      allowFrom: {
        global: channel ? globalAllowTokens : undefined,
        agent: elevatedAgent?.allowFrom && channel ? agentAllowTokens : undefined,
      },
      failures: elevatedFailures,
    },
    fixIt,
  } as const;

  if (opts.json) {
    runtime.log(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const rich = isRich();
  const heading = (value: string) => colorize(rich, theme.heading, value);
  const key = (value: string) => colorize(rich, theme.muted, value);
  const value = (val: string) => colorize(rich, theme.info, val);
  const ok = (val: string) => colorize(rich, theme.success, val);
  const warn = (val: string) => colorize(rich, theme.warn, val);
  const err = (val: string) => colorize(rich, theme.error, val);
  const bool = (flag: boolean) => (flag ? ok("true") : err("false"));

  const lines: string[] = [];
  lines.push(heading("Effective sandbox:"));
  lines.push(`  ${key("agentId:")} ${value(payload.agentId)}`);
  lines.push(`  ${key("sessionKey:")} ${value(payload.sessionKey)}`);
  lines.push(`  ${key("mainSessionKey:")} ${value(payload.mainSessionKey)}`);
  lines.push(
    `  ${key("runtime:")} ${payload.sandbox.sessionIsSandboxed ? warn("sandboxed") : ok("direct")}`,
  );
  lines.push(
    `  ${key("mode:")} ${value(payload.sandbox.mode)} ${key("scope:")} ${value(
      payload.sandbox.scope,
    )} ${key("perSession:")} ${bool(payload.sandbox.perSession)}`,
  );
  lines.push(
    `  ${key("workspaceAccess:")} ${value(
      payload.sandbox.workspaceAccess,
    )} ${key("workspaceRoot:")} ${value(payload.sandbox.workspaceRoot)}`,
  );
  lines.push("");
  lines.push(heading("Sandbox tool policy:"));
  lines.push(
    `  ${key(`allow (${payload.sandbox.tools.sources.allow.source}):`)} ${value(
      payload.sandbox.tools.allow.join(", ") || "(empty)",
    )}`,
  );
  lines.push(
    `  ${key(`deny  (${payload.sandbox.tools.sources.deny.source}):`)} ${value(
      payload.sandbox.tools.deny.join(", ") || "(empty)",
    )}`,
  );
  lines.push("");
  lines.push(heading("Elevated:"));
  lines.push(`  ${key("enabled:")} ${bool(payload.elevated.enabled)}`);
  lines.push(`  ${key("channel:")} ${value(payload.elevated.channel ?? "(unknown)")}`);
  lines.push(`  ${key("allowedByConfig:")} ${bool(payload.elevated.allowedByConfig)}`);
  if (payload.elevated.failures.length > 0) {
    lines.push(
      `  ${key("failing gates:")} ${warn(
        payload.elevated.failures.map((f) => `${f.gate} (${f.key})`).join(", "),
      )}`,
    );
  }
  if (payload.sandbox.mode === "non-main" && payload.sandbox.sessionIsSandboxed) {
    lines.push("");
    lines.push(
      `${warn("Hint:")} sandbox mode is non-main; use main session key to run direct: ${value(
        payload.mainSessionKey,
      )}`,
    );
  }
  lines.push("");
  lines.push(heading("Fix-it:"));
  for (const key of payload.fixIt) lines.push(`  - ${key}`);
  lines.push("");
  lines.push(`${key("Docs:")} ${formatDocsLink("/sandbox", "docs.clawd.bot/sandbox")}`);

  runtime.log(`${lines.join("\n")}\n`);
}
