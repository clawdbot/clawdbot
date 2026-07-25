/**
 * Sandbox explanation command.
 *
 * It resolves the effective sandbox/tool/elevated policy for an agent session
 * and prints either JSON or a human-readable fix-it report.
 */
import {
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
  normalizeStringifiedEntries,
} from "@openclaw/normalization-core/string-coerce";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox.js";
import { getSandboxBackendWorkdirResolver } from "../agents/sandbox/backend.js";
import { buildSandboxFsMounts } from "../agents/sandbox/fs-paths.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { resolveSandboxWorkspaceLayoutPaths } from "../agents/sandbox/shared.js";
import { resolveSandboxToolPolicyForAgent } from "../agents/sandbox/tool-policy.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../agents/spawned-context.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  resolveAgentMainSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { sessionDeliveryChannel } from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";

type SandboxExplainOptions = {
  session?: string;
  agent?: string;
  json: boolean;
};

const SANDBOX_DOCS_URL = "https://docs.openclaw.ai/sandbox";

function normalizeExplainSessionKey(params: {
  cfg: OpenClawConfig;
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
  if (raw.includes(":")) {
    // Fully-qualified session keys are already scoped; only short names need
    // agent/main-key expansion.
    return raw;
  }
  if (raw === "global") {
    return "global";
  }
  return buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: normalizeMainKey(raw),
  });
}

function inferProviderFromSessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): string | undefined {
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed) {
    return undefined;
  }
  const rest = parsed.rest.trim();
  if (!rest) {
    return undefined;
  }
  const parts = rest.split(":").filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const configuredMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (parts[0] === configuredMainKey) {
    return undefined;
  }
  // Legacy session keys embedded provider/channel in the first segment after
  // agent id; use that as a fallback when the session store lacks channel data.
  const candidate = normalizeOptionalLowercaseString(parts[0]);
  if (!candidate) {
    return undefined;
  }
  if (candidate === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  return normalizeAnyChannelId(candidate) ?? undefined;
}

function resolveActiveChannel(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  sessionKey: string;
}): string | undefined {
  const candidate = (sessionDeliveryChannel(params.entry) ?? "").trim();
  const normalizedCandidate = normalizeOptionalLowercaseString(candidate);
  if (!normalizedCandidate) {
    // Empty canonical delivery can still be recovered from the session key.
    return inferProviderFromSessionKey({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
    });
  }
  if (normalizedCandidate === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  const normalized = normalizeAnyChannelId(normalizedCandidate);
  if (normalized) {
    return normalized;
  }
  return inferProviderFromSessionKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
}

/** Prints the effective sandbox policy for a session or agent. */
export async function sandboxExplainCommand(
  opts: SandboxExplainOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = getRuntimeConfig();

  const defaultAgentId = resolveDefaultAgentId(cfg);
  const requestedSession = opts.session?.trim();
  const requestedAgentId = opts.agent?.trim() ? normalizeAgentId(opts.agent) : undefined;
  const sessionAgentId = requestedSession
    ? requestedSession === "global"
      ? defaultAgentId
      : requestedSession.includes(":")
        ? normalizeAgentId(resolveAgentIdFromSessionKey(requestedSession))
        : undefined
    : undefined;
  if (requestedAgentId && sessionAgentId && requestedAgentId !== sessionAgentId) {
    throw new Error(
      `Sandbox explain agent "${requestedAgentId}" does not match session agent "${sessionAgentId}".`,
    );
  }
  const resolvedAgentId = sessionAgentId ?? requestedAgentId ?? defaultAgentId;

  const sessionKey = normalizeExplainSessionKey({
    cfg,
    agentId: resolvedAgentId,
    session: opts.session,
  });

  const sandboxCfg = resolveSandboxConfigForAgent(cfg, resolvedAgentId);
  const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, resolvedAgentId);
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey,
  });
  const mainSessionKey = sandboxRuntime.mainSessionKey;
  const sessionIsSandboxed = sandboxRuntime.sandboxed;
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: resolvedAgentId,
  });
  // CLI reads must not join the Gateway's writable SQLite lifecycle (#101290).
  const sessionEntry = loadSessionEntryReadOnly({
    agentId: resolvedAgentId,
    sessionKey,
    storePath,
  });

  const agentConfig = resolveAgentConfig(cfg, resolvedAgentId);
  // Spawned sessions persist their inherited workspace and direct-mode cwd so
  // later turns keep running in the same location. Explain must mirror those
  // overrides or its effective paths point at a different runtime.
  const configuredWorkspaceDir = resolveAgentWorkspaceDir(cfg, resolvedAgentId);
  const sessionWorkspaceDir = resolveIngressWorkspaceOverrideForSessionRun({
    spawnedBy: sessionEntry?.spawnedBy,
    workspaceDir: sessionEntry?.spawnedWorkspaceDir,
    cwd: sessionEntry?.spawnedCwd,
  });
  const effectiveAgentWorkspaceDir = sessionWorkspaceDir ?? configuredWorkspaceDir;
  const directRuntimeCwd =
    normalizeOptionalString(sessionEntry?.spawnedCwd) ?? effectiveAgentWorkspaceDir;
  const workspaceLayout = resolveSandboxWorkspaceLayoutPaths({
    cfg: sandboxCfg,
    rawSessionKey:
      sessionKey === "global"
        ? buildAgentMainSessionKey({
            agentId: resolvedAgentId,
            mainKey: normalizeMainKey(cfg.session?.mainKey),
          })
        : sessionKey,
    workspaceDir: effectiveAgentWorkspaceDir,
  });
  const sandboxWorkdir = getSandboxBackendWorkdirResolver(sandboxCfg.backend)?.({
    sessionKey,
    scopeKey: workspaceLayout.scopeKey,
    workspaceDir: workspaceLayout.workspaceDir,
    agentWorkspaceDir: workspaceLayout.agentWorkspaceDir,
    skillsWorkspaceDir: workspaceLayout.skillsWorkspaceDir,
    cfg: sandboxCfg,
  });
  const effectiveHostWorkspaceRoot = sessionIsSandboxed
    ? workspaceLayout.workspaceDir
    : workspaceLayout.agentWorkspaceDir;
  const runtimeWorkdir = sessionIsSandboxed ? sandboxWorkdir : directRuntimeCwd;
  const workspaceSource = sessionIsSandboxed ? workspaceLayout.workspaceSource : "direct";
  const workspaceMounts =
    sessionIsSandboxed && sandboxCfg.backend === "docker" && sandboxWorkdir
      ? buildSandboxFsMounts({
          workspaceDir: workspaceLayout.workspaceDir,
          agentWorkspaceDir: workspaceLayout.agentWorkspaceDir,
          skillsWorkspaceDir: workspaceLayout.skillsWorkspaceDir,
          workspaceAccess: sandboxCfg.workspaceAccess,
          containerName: "",
          containerWorkdir: sandboxWorkdir,
          docker: sandboxCfg.docker,
        })
      : [];

  const channel = resolveActiveChannel({
    cfg,
    entry: sessionEntry,
    sessionKey,
  });

  const elevatedGlobal = cfg.tools?.elevated;
  const elevatedAgent = agentConfig?.tools?.elevated;
  const elevatedGlobalEnabled = elevatedGlobal?.enabled !== false;
  const elevatedAgentEnabled = elevatedAgent?.enabled !== false;
  const elevatedEnabled = elevatedGlobalEnabled && elevatedAgentEnabled;

  const globalAllow = channel ? elevatedGlobal?.allowFrom?.[channel] : undefined;
  const agentAllow = channel ? elevatedAgent?.allowFrom?.[channel] : undefined;

  const allowTokens = (values?: Array<string | number>) => normalizeStringifiedEntries(values);
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
  // Track each failed gate separately so the human report points at concrete
  // config keys instead of only saying elevated access is disabled.
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
  fixIt.push("tools.sandbox.tools.alsoAllow");
  fixIt.push("tools.sandbox.tools.deny");
  fixIt.push("agents.list[].tools.sandbox.tools.allow");
  fixIt.push("agents.list[].tools.sandbox.tools.alsoAllow");
  fixIt.push("agents.list[].tools.sandbox.tools.deny");
  fixIt.push("tools.elevated.enabled");
  if (channel) {
    fixIt.push(`tools.elevated.allowFrom.${channel}`);
  }

  const payload = {
    docsUrl: SANDBOX_DOCS_URL,
    agentId: resolvedAgentId,
    sessionKey,
    mainSessionKey,
    sandbox: {
      mode: sandboxCfg.mode,
      scope: sandboxCfg.scope,
      backend: sandboxCfg.backend,
      workspaceAccess: sandboxCfg.workspaceAccess,
      workspaceRoot: sandboxCfg.workspaceRoot,
      effectiveHostWorkspaceRoot,
      runtimeWorkdir,
      workspaceMounts,
      workspaceSource,
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
    writeRuntimeJson(runtime, payload);
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
    )}`,
  );
  lines.push(
    `  ${key("workspaceAccess:")} ${value(
      payload.sandbox.workspaceAccess,
    )} ${key("workspaceRoot:")} ${value(payload.sandbox.workspaceRoot)}`,
  );
  lines.push(
    `  ${key("effectiveHostWorkspaceRoot:")} ${value(payload.sandbox.effectiveHostWorkspaceRoot)}`,
  );
  lines.push(
    `  ${key("backend:")} ${value(payload.sandbox.backend)} ${key("runtimeWorkdir:")} ${value(
      payload.sandbox.runtimeWorkdir ?? "(direct host)",
    )} ${key("workspaceSource:")} ${value(payload.sandbox.workspaceSource)}`,
  );
  if (payload.sandbox.workspaceMounts.length > 0) {
    lines.push(`  ${key("workspaceMounts:")}`);
    for (const mount of payload.sandbox.workspaceMounts) {
      lines.push(
        `    - ${value(mount.hostRoot)} -> ${value(mount.containerRoot)} ${key(
          mount.writable ? "rw" : "ro",
        )} ${key(`(${mount.source})`)}`,
      );
    }
  }
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
  for (const keyLocal of payload.fixIt) {
    lines.push(`  - ${keyLocal}`);
  }
  lines.push("");
  lines.push(`${key("Docs:")} ${formatDocsLink("/sandbox", "docs.openclaw.ai/sandbox")}`);

  runtime.log(`${lines.join("\n")}\n`);
}
