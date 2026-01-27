import { listChannelPlugins } from "../channels/plugins/index.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { MoltbotConfig } from "../config/config.js";
import { resolveBrowserConfig, resolveProfile } from "../browser/config.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { formatCliCommand } from "../cli/command-format.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { probeGateway } from "../gateway/probe.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectExposureMatrixFindings,
  collectHooksHardeningFindings,
  collectIncludeFilePermFindings,
  collectModelHygieneFindings,
  collectSmallModelRiskFindings,
  collectPluginsTrustFindings,
  collectSecretsInConfigFindings,
  collectStateDeepFilesystemFindings,
  collectSyncedFolderFindings,
  readConfigSnapshotForAudit,
} from "./audit-extra.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import { resolveNativeCommandsEnabled, resolveNativeSkillsEnabled } from "../config/commands.js";
import {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
} from "./audit-fs.js";
import type { ExecFn } from "./windows-acl.js";

export type SecurityAuditSeverity = "info" | "warn" | "critical";

export type SecurityAuditFinding = {
  checkId: string;
  severity: SecurityAuditSeverity;
  title: string;
  detail: string;
  remediation?: string;
};

export type SecurityAuditSummary = {
  critical: number;
  warn: number;
  info: number;
};

export type SecurityAuditReport = {
  ts: number;
  summary: SecurityAuditSummary;
  findings: SecurityAuditFinding[];
  deep?: {
    gateway?: {
      attempted: boolean;
      url: string | null;
      ok: boolean;
      error: string | null;
      close?: { code: number; reason: string } | null;
    };
  };
};

export type SecurityAuditOptions = {
  config: MoltbotConfig;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  deep?: boolean;
  includeFilesystem?: boolean;
  includeChannelSecurity?: boolean;
  /** Override where to check state (default: resolveStateDir()). */
  stateDir?: string;
  /** Override config path check (default: resolveConfigPath()). */
  configPath?: string;
  /** Time limit for deep gateway probe. */
  deepTimeoutMs?: number;
  /** Dependency injection for tests. */
  plugins?: ReturnType<typeof listChannelPlugins>;
  /** Dependency injection for tests. */
  probeGatewayFn?: typeof probeGateway;
  /** Dependency injection for tests (Windows ACL checks). */
  execIcacls?: ExecFn;
};

function countBySeverity(findings: SecurityAuditFinding[]): SecurityAuditSummary {
  let critical = 0;
  let warn = 0;
  let info = 0;
  for (const f of findings) {
    if (f.severity === "critical") critical += 1;
    else if (f.severity === "warn") warn += 1;
    else info += 1;
  }
  return { critical, warn, info };
}

function normalizeAllowFromList(list: Array<string | number> | undefined | null): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((v) => String(v).trim()).filter(Boolean);
}

function classifyChannelWarningSeverity(message: string): SecurityAuditSeverity {
  const s = message.toLowerCase();
  if (
    s.includes("dms: open") ||
    s.includes('grouppolicy="open"') ||
    s.includes('dmpolicy="open"')
  ) {
    return "critical";
  }
  if (s.includes("allows any") || s.includes("anyone can dm") || s.includes("public")) {
    return "critical";
  }
  if (s.includes("locked") || s.includes("disabled")) {
    return "info";
  }
  return "warn";
}

async function collectFilesystemFindings(params: {
  stateDir: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];

  const stateDirPerms = await inspectPathPermissions(params.stateDir, {
    env: params.env,
    platform: params.platform,
    exec: params.execIcacls,
  });
  if (stateDirPerms.ok) {
    if (stateDirPerms.isSymlink) {
      findings.push({
        checkId: "fs.state_dir.symlink",
        severity: "warn",
        title: "State dir is a symlink",
        detail: `${params.stateDir} is a symlink; treat this as an extra trust boundary.`,
      });
    }
    if (stateDirPerms.worldWritable) {
      findings.push({
        checkId: "fs.state_dir.perms_world_writable",
        severity: "critical",
        title: "State dir is world-writable",
        detail: `${formatPermissionDetail(params.stateDir, stateDirPerms)}; other users can write into your Moltbot state.`,
        remediation: formatPermissionRemediation({
          targetPath: params.stateDir,
          perms: stateDirPerms,
          isDir: true,
          posixMode: 0o700,
          env: params.env,
        }),
      });
    } else if (stateDirPerms.groupWritable) {
      findings.push({
        checkId: "fs.state_dir.perms_group_writable",
        severity: "warn",
        title: "State dir is group-writable",
        detail: `${formatPermissionDetail(params.stateDir, stateDirPerms)}; group users can write into your Moltbot state.`,
        remediation: formatPermissionRemediation({
          targetPath: params.stateDir,
          perms: stateDirPerms,
          isDir: true,
          posixMode: 0o700,
          env: params.env,
        }),
      });
    } else if (stateDirPerms.groupReadable || stateDirPerms.worldReadable) {
      findings.push({
        checkId: "fs.state_dir.perms_readable",
        severity: "warn",
        title: "State dir is readable by others",
        detail: `${formatPermissionDetail(params.stateDir, stateDirPerms)}; consider restricting to 700.`,
        remediation: formatPermissionRemediation({
          targetPath: params.stateDir,
          perms: stateDirPerms,
          isDir: true,
          posixMode: 0o700,
          env: params.env,
        }),
      });
    }
  }

  const configPerms = await inspectPathPermissions(params.configPath, {
    env: params.env,
    platform: params.platform,
    exec: params.execIcacls,
  });
  if (configPerms.ok) {
    if (configPerms.isSymlink) {
      findings.push({
        checkId: "fs.config.symlink",
        severity: "warn",
        title: "Config file is a symlink",
        detail: `${params.configPath} is a symlink; make sure you trust its target.`,
      });
    }
    if (configPerms.worldWritable || configPerms.groupWritable) {
      findings.push({
        checkId: "fs.config.perms_writable",
        severity: "critical",
        title: "Config file is writable by others",
        detail: `${formatPermissionDetail(params.configPath, configPerms)}; another user could change gateway/auth/tool policies.`,
        remediation: formatPermissionRemediation({
          targetPath: params.configPath,
          perms: configPerms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    } else if (configPerms.worldReadable) {
      findings.push({
        checkId: "fs.config.perms_world_readable",
        severity: "critical",
        title: "Config file is world-readable",
        detail: `${formatPermissionDetail(params.configPath, configPerms)}; config can contain tokens and private settings.`,
        remediation: formatPermissionRemediation({
          targetPath: params.configPath,
          perms: configPerms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    } else if (configPerms.groupReadable) {
      findings.push({
        checkId: "fs.config.perms_group_readable",
        severity: "warn",
        title: "Config file is group-readable",
        detail: `${formatPermissionDetail(params.configPath, configPerms)}; config can contain tokens and private settings.`,
        remediation: formatPermissionRemediation({
          targetPath: params.configPath,
          perms: configPerms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    }
  }

  return findings;
}

function collectGatewayConfigFindings(
  cfg: MoltbotConfig,
  env: NodeJS.ProcessEnv,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  const bind = typeof cfg.gateway?.bind === "string" ? cfg.gateway.bind : "loopback";
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, tailscaleMode, env });
  const controlUiEnabled = cfg.gateway?.controlUi?.enabled !== false;
  const trustedProxies = Array.isArray(cfg.gateway?.trustedProxies)
    ? cfg.gateway.trustedProxies
    : [];
  const hasToken = typeof auth.token === "string" && auth.token.trim().length > 0;
  const hasPassword = typeof auth.password === "string" && auth.password.trim().length > 0;
  const hasSharedSecret =
    (auth.mode === "token" && hasToken) || (auth.mode === "password" && hasPassword);
  const hasTailscaleAuth = auth.allowTailscale === true && tailscaleMode === "serve";
  const hasGatewayAuth = hasSharedSecret || hasTailscaleAuth;

  if (bind !== "loopback" && !hasSharedSecret) {
    findings.push({
      checkId: "gateway.bind_no_auth",
      severity: "critical",
      title: "Gateway binds beyond loopback without auth",
      detail: `gateway.bind="${bind}" but no gateway.auth token/password is configured.`,
      remediation: `Set gateway.auth (token recommended) or bind to loopback.`,
    });
  }

  if (bind === "loopback" && controlUiEnabled && trustedProxies.length === 0) {
    findings.push({
      checkId: "gateway.trusted_proxies_missing",
      severity: "warn",
      title: "Reverse proxy headers are not trusted",
      detail:
        "gateway.bind is loopback and gateway.trustedProxies is empty. " +
        "If you expose the Control UI through a reverse proxy, configure trusted proxies " +
        "so local-client checks cannot be spoofed.",
      remediation:
        "Set gateway.trustedProxies to your proxy IPs or keep the Control UI local-only.",
    });
  }

  if (bind === "loopback" && controlUiEnabled && !hasGatewayAuth) {
    findings.push({
      checkId: "gateway.loopback_no_auth",
      severity: "critical",
      title: "Gateway auth missing on loopback",
      detail:
        "gateway.bind is loopback but no gateway auth secret is configured. " +
        "If the Control UI is exposed through a reverse proxy, unauthenticated access is possible.",
      remediation: "Set gateway.auth (token recommended) or keep the Control UI local-only.",
    });
  }

  if (tailscaleMode === "funnel") {
    findings.push({
      checkId: "gateway.tailscale_funnel",
      severity: "critical",
      title: "Tailscale Funnel exposure enabled",
      detail: `gateway.tailscale.mode="funnel" exposes the Gateway publicly; keep auth strict and treat it as internet-facing.`,
      remediation: `Prefer tailscale.mode="serve" (tailnet-only) or set tailscale.mode="off".`,
    });
  } else if (tailscaleMode === "serve") {
    findings.push({
      checkId: "gateway.tailscale_serve",
      severity: "info",
      title: "Tailscale Serve exposure enabled",
      detail: `gateway.tailscale.mode="serve" exposes the Gateway to your tailnet (loopback behind Tailscale).`,
    });
  }

  if (cfg.gateway?.controlUi?.allowInsecureAuth === true) {
    findings.push({
      checkId: "gateway.control_ui.insecure_auth",
      severity: "critical",
      title: "Control UI allows insecure HTTP auth",
      detail:
        "gateway.controlUi.allowInsecureAuth=true allows token-only auth over HTTP and skips device identity.",
      remediation: "Disable it or switch to HTTPS (Tailscale Serve) or localhost.",
    });
  }

  if (cfg.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true) {
    findings.push({
      checkId: "gateway.control_ui.device_auth_disabled",
      severity: "critical",
      title: "DANGEROUS: Control UI device auth disabled",
      detail:
        "gateway.controlUi.dangerouslyDisableDeviceAuth=true disables device identity checks for the Control UI.",
      remediation: "Disable it unless you are in a short-lived break-glass scenario.",
    });
  }

  const token =
    typeof auth.token === "string" && auth.token.trim().length > 0 ? auth.token.trim() : null;
  if (auth.mode === "token" && token && token.length < 24) {
    findings.push({
      checkId: "gateway.token_too_short",
      severity: "warn",
      title: "Gateway token looks short",
      detail: `gateway auth token is ${token.length} chars; prefer a long random token.`,
    });
  }

  return findings;
}

function collectBrowserControlFindings(cfg: MoltbotConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  let resolved: ReturnType<typeof resolveBrowserConfig>;
  try {
    resolved = resolveBrowserConfig(cfg.browser, cfg);
  } catch (err) {
    findings.push({
      checkId: "browser.control_invalid_config",
      severity: "warn",
      title: "Browser control config looks invalid",
      detail: String(err),
      remediation: `Fix browser.cdpUrl in ${resolveConfigPath()} and re-run "${formatCliCommand("moltbot security audit --deep")}".`,
    });
    return findings;
  }

  if (!resolved.enabled) return findings;

  for (const name of Object.keys(resolved.profiles)) {
    const profile = resolveProfile(resolved, name);
    if (!profile || profile.cdpIsLoopback) continue;
    let url: URL;
    try {
      url = new URL(profile.cdpUrl);
    } catch {
      continue;
    }
    if (url.protocol === "http:") {
      findings.push({
        checkId: "browser.remote_cdp_http",
        severity: "warn",
        title: "Remote CDP uses HTTP",
        detail: `browser profile "${name}" uses http CDP (${profile.cdpUrl}); this is OK only if it's tailnet-only or behind an encrypted tunnel.`,
        remediation: `Prefer HTTPS/TLS or a tailnet-only endpoint for remote CDP.`,
      });
    }
  }

  return findings;
}

function collectLoggingFindings(cfg: MoltbotConfig): SecurityAuditFinding[] {
  const redact = cfg.logging?.redactSensitive;
  if (redact !== "off") return [];
  return [
    {
      checkId: "logging.redact_off",
      severity: "warn",
      title: "Tool summary redaction is disabled",
      detail: `logging.redactSensitive="off" can leak secrets into logs and status output.`,
      remediation: `Set logging.redactSensitive="tools".`,
    },
  ];
}

function collectElevatedFindings(cfg: MoltbotConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const enabled = cfg.tools?.elevated?.enabled;
  const allowFrom = cfg.tools?.elevated?.allowFrom ?? {};
  const anyAllowFromKeys = Object.keys(allowFrom).length > 0;

  if (enabled === false) return findings;
  if (!anyAllowFromKeys) return findings;

  for (const [provider, list] of Object.entries(allowFrom)) {
    const normalized = normalizeAllowFromList(list);
    if (normalized.includes("*")) {
      findings.push({
        checkId: `tools.elevated.allowFrom.${provider}.wildcard`,
        severity: "critical",
        title: "Elevated exec allowlist contains wildcard",
        detail: `tools.elevated.allowFrom.${provider} includes "*" which effectively approves everyone on that channel for elevated mode.`,
      });
    } else if (normalized.length > 25) {
      findings.push({
        checkId: `tools.elevated.allowFrom.${provider}.large`,
        severity: "warn",
        title: "Elevated exec allowlist is large",
        detail: `tools.elevated.allowFrom.${provider} has ${normalized.length} entries; consider tightening elevated access.`,
      });
    }
  }

  return findings;
}

async function collectChannelSecurityFindings(params: {
  cfg: MoltbotConfig;
  plugins: ReturnType<typeof listChannelPlugins>;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];

  const coerceNativeSetting = (value: unknown): boolean | "auto" | undefined => {
    if (value === true) return true;
    if (value === false) return false;
    if (value === "auto") return "auto";
    return undefined;
  };

  const warnDmPolicy = async (input: {
    label: string;
    provider: ChannelId;
    dmPolicy: string;
    allowFrom?: Array<string | number> | null;
    policyPath?: string;
    allowFromPath: string;
    normalizeEntry?: (raw: string) => string;
  }) => {
    const policyPath = input.policyPath ?? `${input.allowFromPath}policy`;
    const configAllowFrom = normalizeAllowFromList(input.allowFrom);
    const hasWildcard = configAllowFrom.includes("*");
    const dmScope = params.cfg.session?.dmScope ?? "main";
    const storeAllowFrom = await readChannelAllowFromStore(input.provider).catch(() => []);
    const normalizeEntry = input.normalizeEntry ?? ((value: string) => value);
    const normalizedCfg = configAllowFrom
      .filter((value) => value !== "*")
      .map((value) => normalizeEntry(value))
      .map((value) => value.trim())
      .filter(Boolean);
    const normalizedStore = storeAllowFrom
      .map((value) => normalizeEntry(value))
      .map((value) => value.trim())
      .filter(Boolean);
    const allowCount = Array.from(new Set([...normalizedCfg, ...normalizedStore])).length;
    const isMultiUserDm = hasWildcard || allowCount > 1;

    if (input.dmPolicy === "open") {
      const allowFromKey = `${input.allowFromPath}allowFrom`;
      findings.push({
        checkId: `channels.${input.provider}.dm.open`,
        severity: "critical",
        title: `${input.label} DMs are open`,
        detail: `${policyPath}="open" allows anyone to DM the bot.`,
        remediation: `Use pairing/allowlist; if you really need open DMs, ensure ${allowFromKey} includes "*".`,
      });
      if (!hasWildcard) {
        findings.push({
          checkId: `channels.${input.provider}.dm.open_invalid`,
          severity: "warn",
          title: `${input.label} DM config looks inconsistent`,
          detail: `"open" requires ${allowFromKey} to include "*".`,
        });
      }
    }

    if (input.dmPolicy === "disabled") {
      findings.push({
        checkId: `channels.${input.provider}.dm.disabled`,
        severity: "info",
        title: `${input.label} DMs are disabled`,
        detail: `${policyPath}="disabled" ignores inbound DMs.`,
      });
      return;
    }

    if (dmScope === "main" && isMultiUserDm) {
      findings.push({
        checkId: `channels.${input.provider}.dm.scope_main_multiuser`,
        severity: "warn",
        title: `${input.label} DMs share the main session`,
        detail:
          "Multiple DM senders currently share the main session, which can leak context across users.",
        remediation: 'Set session.dmScope="per-channel-peer" to isolate DM sessions per sender.',
      });
    }
  };

  for (const plugin of params.plugins) {
    if (!plugin.security) continue;
    const accountIds = plugin.config.listAccountIds(params.cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg: params.cfg,
      accountIds,
    });
    const account = plugin.config.resolveAccount(params.cfg, defaultAccountId);
    const enabled = plugin.config.isEnabled ? plugin.config.isEnabled(account, params.cfg) : true;
    if (!enabled) continue;
    const configured = plugin.config.isConfigured
      ? await plugin.config.isConfigured(account, params.cfg)
      : true;
    if (!configured) continue;

    if (plugin.id === "discord") {
      const discordCfg =
        (account as { config?: Record<string, unknown> } | null)?.config ??
        ({} as Record<string, unknown>);
      const nativeEnabled = resolveNativeCommandsEnabled({
        providerId: "discord",
        providerSetting: coerceNativeSetting(
          (discordCfg.commands as { native?: unknown } | undefined)?.native,
        ),
        globalSetting: params.cfg.commands?.native,
      });
      const nativeSkillsEnabled = resolveNativeSkillsEnabled({
        providerId: "discord",
        providerSetting: coerceNativeSetting(
          (discordCfg.commands as { nativeSkills?: unknown } | undefined)?.nativeSkills,
        ),
        globalSetting: params.cfg.commands?.nativeSkills,
      });
      const slashEnabled = nativeEnabled || nativeSkillsEnabled;
      if (slashEnabled) {
        const defaultGroupPolicy = params.cfg.channels?.defaults?.groupPolicy;
        const groupPolicy =
          (discordCfg.groupPolicy as string | undefined) ?? defaultGroupPolicy ?? "allowlist";
        const guildEntries = (discordCfg.guilds as Record<string, unknown> | undefined) ?? {};
        const guildsConfigured = Object.keys(guildEntries).length > 0;
        const hasAnyUserAllowlist = Object.values(guildEntries).some((guild) => {
          if (!guild || typeof guild !== "object") return false;
          const g = guild as Record<string, unknown>;
          if (Array.isArray(g.users) && g.users.length > 0) return true;
          const channels = g.channels;
          if (!channels || typeof channels !== "object") return false;
          return Object.values(channels as Record<string, unknown>).some((channel) => {
            if (!channel || typeof channel !== "object") return false;
            const c = channel as Record<string, unknown>;
            return Array.isArray(c.users) && c.users.length > 0;
          });
        });
        const dmAllowFromRaw = (discordCfg.dm as { allowFrom?: unknown } | undefined)?.allowFrom;
        const dmAllowFrom = Array.isArray(dmAllowFromRaw) ? dmAllowFromRaw : [];
        const storeAllowFrom = await readChannelAllowFromStore("discord").catch(() => []);
        const ownerAllowFromConfigured =
          normalizeAllowFromList([...dmAllowFrom, ...storeAllowFrom]).length > 0;

        const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
        if (
          !useAccessGroups &&
          groupPolicy !== "disabled" &&
          guildsConfigured &&
          !hasAnyUserAllowlist
        ) {
          findings.push({
            checkId: "channels.discord.commands.native.unrestricted",
            severity: "critical",
            title: "Discord slash commands are unrestricted",
            detail:
              "commands.useAccessGroups=false disables sender allowlists for Discord slash commands unless a per-guild/channel users allowlist is configured; with no users allowlist, any user in allowed guild channels can invoke /… commands.",
            remediation:
              "Set commands.useAccessGroups=true (recommended), or configure channels.discord.guilds.<id>.users (or channels.discord.guilds.<id>.channels.<channel>.users).",
          });
        } else if (
          useAccessGroups &&
          groupPolicy !== "disabled" &&
          guildsConfigured &&
          !ownerAllowFromConfigured &&
          !hasAnyUserAllowlist
        ) {
          findings.push({
            checkId: "channels.discord.commands.native.no_allowlists",
            severity: "warn",
            title: "Discord slash commands have no allowlists",
            detail:
              "Discord slash commands are enabled, but neither an owner allowFrom list nor any per-guild/channel users allowlist is configured; /… commands will be rejected for everyone.",
            remediation:
              "Add your user id to channels.discord.dm.allowFrom (or approve yourself via pairing), or configure channels.discord.guilds.<id>.users.",
          });
        }
      }
    }

    if (plugin.id === "slack") {
      const slackCfg =
        (account as { config?: Record<string, unknown>; dm?: Record<string, unknown> } | null)
          ?.config ?? ({} as Record<string, unknown>);
      const nativeEnabled = resolveNativeCommandsEnabled({
        providerId: "slack",
        providerSetting: coerceNativeSetting(
          (slackCfg.commands as { native?: unknown } | undefined)?.native,
        ),
        globalSetting: params.cfg.commands?.native,
      });
      const nativeSkillsEnabled = resolveNativeSkillsEnabled({
        providerId: "slack",
        providerSetting: coerceNativeSetting(
          (slackCfg.commands as { nativeSkills?: unknown } | undefined)?.nativeSkills,
        ),
        globalSetting: params.cfg.commands?.nativeSkills,
      });
      const slashCommandEnabled =
        nativeEnabled ||
        nativeSkillsEnabled ||
        (slackCfg.slashCommand as { enabled?: unknown } | undefined)?.enabled === true;
      if (slashCommandEnabled) {
        const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
        if (!useAccessGroups) {
          findings.push({
            checkId: "channels.slack.commands.slash.useAccessGroups_off",
            severity: "critical",
            title: "Slack slash commands bypass access groups",
            detail:
              "Slack slash/native commands are enabled while commands.useAccessGroups=false; this can allow unrestricted /… command execution from channels/users you didn't explicitly authorize.",
            remediation: "Set commands.useAccessGroups=true (recommended).",
          });
        } else {
          const dmAllowFromRaw = (account as { dm?: { allowFrom?: unknown } } | null)?.dm
            ?.allowFrom;
          const dmAllowFrom = Array.isArray(dmAllowFromRaw) ? dmAllowFromRaw : [];
          const storeAllowFrom = await readChannelAllowFromStore("slack").catch(() => []);
          const ownerAllowFromConfigured =
            normalizeAllowFromList([...dmAllowFrom, ...storeAllowFrom]).length > 0;
          const channels = (slackCfg.channels as Record<string, unknown> | undefined) ?? {};
          const hasAnyChannelUsersAllowlist = Object.values(channels).some((value) => {
            if (!value || typeof value !== "object") return false;
            const channel = value as Record<string, unknown>;
            return Array.isArray(channel.users) && channel.users.length > 0;
          });
          if (!ownerAllowFromConfigured && !hasAnyChannelUsersAllowlist) {
            findings.push({
              checkId: "channels.slack.commands.slash.no_allowlists",
              severity: "warn",
              title: "Slack slash commands have no allowlists",
              detail:
                "Slack slash/native commands are enabled, but neither an owner allowFrom list nor any channels.<id>.users allowlist is configured; /… commands will be rejected for everyone.",
              remediation:
                "Approve yourself via pairing (recommended), or set channels.slack.dm.allowFrom and/or channels.slack.channels.<id>.users.",
            });
          }
        }
      }
    }

    const dmPolicy = plugin.security.resolveDmPolicy?.({
      cfg: params.cfg,
      accountId: defaultAccountId,
      account,
    });
    if (dmPolicy) {
      await warnDmPolicy({
        label: plugin.meta.label ?? plugin.id,
        provider: plugin.id,
        dmPolicy: dmPolicy.policy,
        allowFrom: dmPolicy.allowFrom,
        policyPath: dmPolicy.policyPath,
        allowFromPath: dmPolicy.allowFromPath,
        normalizeEntry: dmPolicy.normalizeEntry,
      });
    }

    if (plugin.security.collectWarnings) {
      const warnings = await plugin.security.collectWarnings({
        cfg: params.cfg,
        accountId: defaultAccountId,
        account,
      });
      for (const message of warnings ?? []) {
        const trimmed = String(message).trim();
        if (!trimmed) continue;
        findings.push({
          checkId: `channels.${plugin.id}.warning.${findings.length + 1}`,
          severity: classifyChannelWarningSeverity(trimmed),
          title: `${plugin.meta.label ?? plugin.id} security warning`,
          detail: trimmed.replace(/^-\s*/, ""),
        });
      }
    }

    if (plugin.id === "telegram") {
      const allowTextCommands = params.cfg.commands?.text !== false;
      if (!allowTextCommands) continue;

      const telegramCfg =
        (account as { config?: Record<string, unknown> } | null)?.config ??
        ({} as Record<string, unknown>);
      const defaultGroupPolicy = params.cfg.channels?.defaults?.groupPolicy;
      const groupPolicy =
        (telegramCfg.groupPolicy as string | undefined) ?? defaultGroupPolicy ?? "allowlist";
      const groups = telegramCfg.groups as Record<string, unknown> | undefined;
      const groupsConfigured = Boolean(groups) && Object.keys(groups ?? {}).length > 0;
      const groupAccessPossible =
        groupPolicy === "open" || (groupPolicy === "allowlist" && groupsConfigured);
      if (!groupAccessPossible) continue;

      const storeAllowFrom = await readChannelAllowFromStore("telegram").catch(() => []);
      const storeHasWildcard = storeAllowFrom.some((v) => String(v).trim() === "*");
      const groupAllowFrom = Array.isArray(telegramCfg.groupAllowFrom)
        ? telegramCfg.groupAllowFrom
        : [];
      const groupAllowFromHasWildcard = groupAllowFrom.some((v) => String(v).trim() === "*");
      const anyGroupOverride = Boolean(
        groups &&
        Object.values(groups).some((value) => {
          if (!value || typeof value !== "object") return false;
          const group = value as Record<string, unknown>;
          const allowFrom = Array.isArray(group.allowFrom) ? group.allowFrom : [];
          if (allowFrom.length > 0) return true;
          const topics = group.topics;
          if (!topics || typeof topics !== "object") return false;
          return Object.values(topics as Record<string, unknown>).some((topicValue) => {
            if (!topicValue || typeof topicValue !== "object") return false;
            const topic = topicValue as Record<string, unknown>;
            const topicAllow = Array.isArray(topic.allowFrom) ? topic.allowFrom : [];
            return topicAllow.length > 0;
          });
        }),
      );

      const hasAnySenderAllowlist =
        storeAllowFrom.length > 0 || groupAllowFrom.length > 0 || anyGroupOverride;

      if (storeHasWildcard || groupAllowFromHasWildcard) {
        findings.push({
          checkId: "channels.telegram.groups.allowFrom.wildcard",
          severity: "critical",
          title: "Telegram group allowlist contains wildcard",
          detail:
            'Telegram group sender allowlist contains "*", which allows any group member to run /… commands and control directives.',
          remediation:
            'Remove "*" from channels.telegram.groupAllowFrom and pairing store; prefer explicit user ids/usernames.',
        });
        continue;
      }

      if (!hasAnySenderAllowlist) {
        const providerSetting = (telegramCfg.commands as { nativeSkills?: unknown } | undefined)
          ?.nativeSkills as any;
        const skillsEnabled = resolveNativeSkillsEnabled({
          providerId: "telegram",
          providerSetting,
          globalSetting: params.cfg.commands?.nativeSkills,
        });
        findings.push({
          checkId: "channels.telegram.groups.allowFrom.missing",
          severity: "critical",
          title: "Telegram group commands have no sender allowlist",
          detail:
            `Telegram group access is enabled but no sender allowlist is configured; this allows any group member to invoke /… commands` +
            (skillsEnabled ? " (including skill commands)." : "."),
          remediation:
            "Approve yourself via pairing (recommended), or set channels.telegram.groupAllowFrom (or per-group groups.<id>.allowFrom).",
        });
      }
    }
  }

  return findings;
}

async function maybeProbeGateway(params: {
  cfg: MoltbotConfig;
  timeoutMs: number;
  probe: typeof probeGateway;
}): Promise<SecurityAuditReport["deep"]> {
  const connection = buildGatewayConnectionDetails({ config: params.cfg });
  const url = connection.url;
  const isRemoteMode = params.cfg.gateway?.mode === "remote";
  const remoteUrlRaw =
    typeof params.cfg.gateway?.remote?.url === "string" ? params.cfg.gateway.remote.url.trim() : "";
  const remoteUrlMissing = isRemoteMode && !remoteUrlRaw;

  const resolveAuth = (mode: "local" | "remote") => {
    const authToken = params.cfg.gateway?.auth?.token;
    const authPassword = params.cfg.gateway?.auth?.password;
    const remote = params.cfg.gateway?.remote;
    const token =
      mode === "remote"
        ? typeof remote?.token === "string" && remote.token.trim()
          ? remote.token.trim()
          : undefined
        : process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
          (typeof authToken === "string" && authToken.trim() ? authToken.trim() : undefined);
    const password =
      process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
      (mode === "remote"
        ? typeof remote?.password === "string" && remote.password.trim()
          ? remote.password.trim()
          : undefined
        : typeof authPassword === "string" && authPassword.trim()
          ? authPassword.trim()
          : undefined);
    return { token, password };
  };

  const auth = !isRemoteMode || remoteUrlMissing ? resolveAuth("local") : resolveAuth("remote");
  const res = await params.probe({ url, auth, timeoutMs: params.timeoutMs }).catch((err) => ({
    ok: false,
    url,
    connectLatencyMs: null,
    error: String(err),
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  }));

  return {
    gateway: {
      attempted: true,
      url,
      ok: res.ok,
      error: res.ok ? null : res.error,
      close: res.close ? { code: res.close.code, reason: res.close.reason } : null,
    },
  };
}

export async function runSecurityAudit(opts: SecurityAuditOptions): Promise<SecurityAuditReport> {
  const findings: SecurityAuditFinding[] = [];
  const cfg = opts.config;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const execIcacls = opts.execIcacls;
  const stateDir = opts.stateDir ?? resolveStateDir(env);
  const configPath = opts.configPath ?? resolveConfigPath(env, stateDir);

  findings.push(...collectAttackSurfaceSummaryFindings(cfg));
  findings.push(...collectSyncedFolderFindings({ stateDir, configPath }));

  findings.push(...collectGatewayConfigFindings(cfg, env));
  findings.push(...collectBrowserControlFindings(cfg));
  findings.push(...collectLoggingFindings(cfg));
  findings.push(...collectElevatedFindings(cfg));
  findings.push(...collectHooksHardeningFindings(cfg));
  findings.push(...collectSecretsInConfigFindings(cfg));
  findings.push(...collectModelHygieneFindings(cfg));
  findings.push(...collectSmallModelRiskFindings({ cfg, env }));
  findings.push(...collectExposureMatrixFindings(cfg));

  const configSnapshot =
    opts.includeFilesystem !== false
      ? await readConfigSnapshotForAudit({ env, configPath }).catch(() => null)
      : null;

  if (opts.includeFilesystem !== false) {
    findings.push(
      ...(await collectFilesystemFindings({
        stateDir,
        configPath,
        env,
        platform,
        execIcacls,
      })),
    );
    if (configSnapshot) {
      findings.push(
        ...(await collectIncludeFilePermFindings({ configSnapshot, env, platform, execIcacls })),
      );
    }
    findings.push(
      ...(await collectStateDeepFilesystemFindings({ cfg, env, stateDir, platform, execIcacls })),
    );
    findings.push(...(await collectPluginsTrustFindings({ cfg, stateDir })));
  }

  if (opts.includeChannelSecurity !== false) {
    const plugins = opts.plugins ?? listChannelPlugins();
    findings.push(...(await collectChannelSecurityFindings({ cfg, plugins })));
  }

  const deep =
    opts.deep === true
      ? await maybeProbeGateway({
          cfg,
          timeoutMs: Math.max(250, opts.deepTimeoutMs ?? 5000),
          probe: opts.probeGatewayFn ?? probeGateway,
        })
      : undefined;

  if (deep?.gateway?.attempted && deep.gateway.ok === false) {
    findings.push({
      checkId: "gateway.probe_failed",
      severity: "warn",
      title: "Gateway probe failed (deep)",
      detail: deep.gateway.error ?? "gateway unreachable",
      remediation: `Run "${formatCliCommand("moltbot status --all")}" to debug connectivity/auth, then re-run "${formatCliCommand("moltbot security audit --deep")}".`,
    });
  }

  const summary = countBySeverity(findings);
  return { ts: Date.now(), summary, findings, deep };
}
