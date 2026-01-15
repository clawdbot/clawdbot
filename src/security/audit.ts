import { listChannelPlugins } from "../channels/plugins/index.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { ClawdbotConfig } from "../config/config.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { probeGateway } from "../gateway/probe.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectExposureMatrixFindings,
  collectHooksHardeningFindings,
  collectIncludeFilePermFindings,
  collectModelHygieneFindings,
  collectPluginsTrustFindings,
  collectSecretsInConfigFindings,
  collectStateDeepFilesystemFindings,
  collectSyncedFolderFindings,
  readConfigSnapshotForAudit,
} from "./audit-extra.js";
import {
  formatOctal,
  isGroupReadable,
  isGroupWritable,
  isWorldReadable,
  isWorldWritable,
  modeBits,
  safeStat,
} from "./audit-fs.js";

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
  config: ClawdbotConfig;
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
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];

  const stateDirStat = await safeStat(params.stateDir);
  if (stateDirStat.ok) {
    const bits = modeBits(stateDirStat.mode);
    if (stateDirStat.isSymlink) {
      findings.push({
        checkId: "fs.state_dir.symlink",
        severity: "warn",
        title: "State dir is a symlink",
        detail: `${params.stateDir} is a symlink; treat this as an extra trust boundary.`,
      });
    }
    if (isWorldWritable(bits)) {
      findings.push({
        checkId: "fs.state_dir.perms_world_writable",
        severity: "critical",
        title: "State dir is world-writable",
        detail: `${params.stateDir} mode=${formatOctal(bits)}; other users can write into your Clawdbot state.`,
        remediation: `chmod 700 ${params.stateDir}`,
      });
    } else if (isGroupWritable(bits)) {
      findings.push({
        checkId: "fs.state_dir.perms_group_writable",
        severity: "warn",
        title: "State dir is group-writable",
        detail: `${params.stateDir} mode=${formatOctal(bits)}; group users can write into your Clawdbot state.`,
        remediation: `chmod 700 ${params.stateDir}`,
      });
    } else if (isGroupReadable(bits) || isWorldReadable(bits)) {
      findings.push({
        checkId: "fs.state_dir.perms_readable",
        severity: "warn",
        title: "State dir is readable by others",
        detail: `${params.stateDir} mode=${formatOctal(bits)}; consider restricting to 700.`,
        remediation: `chmod 700 ${params.stateDir}`,
      });
    }
  }

  const configStat = await safeStat(params.configPath);
  if (configStat.ok) {
    const bits = modeBits(configStat.mode);
    if (configStat.isSymlink) {
      findings.push({
        checkId: "fs.config.symlink",
        severity: "warn",
        title: "Config file is a symlink",
        detail: `${params.configPath} is a symlink; make sure you trust its target.`,
      });
    }
    if (isWorldWritable(bits) || isGroupWritable(bits)) {
      findings.push({
        checkId: "fs.config.perms_writable",
        severity: "critical",
        title: "Config file is writable by others",
        detail: `${params.configPath} mode=${formatOctal(bits)}; another user could change gateway/auth/tool policies.`,
        remediation: `chmod 600 ${params.configPath}`,
      });
    } else if (isWorldReadable(bits)) {
      findings.push({
        checkId: "fs.config.perms_world_readable",
        severity: "critical",
        title: "Config file is world-readable",
        detail: `${params.configPath} mode=${formatOctal(bits)}; config can contain tokens and private settings.`,
        remediation: `chmod 600 ${params.configPath}`,
      });
    } else if (isGroupReadable(bits)) {
      findings.push({
        checkId: "fs.config.perms_group_readable",
        severity: "warn",
        title: "Config file is group-readable",
        detail: `${params.configPath} mode=${formatOctal(bits)}; config can contain tokens and private settings.`,
        remediation: `chmod 600 ${params.configPath}`,
      });
    }
  }

  return findings;
}

function collectGatewayConfigFindings(cfg: ClawdbotConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  const bind = typeof cfg.gateway?.bind === "string" ? cfg.gateway.bind : "loopback";
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, tailscaleMode });

  if (bind !== "loopback" && auth.mode === "none") {
    findings.push({
      checkId: "gateway.bind_no_auth",
      severity: "critical",
      title: "Gateway binds beyond loopback without auth",
      detail: `gateway.bind="${bind}" but no gateway.auth token/password is configured.`,
      remediation: `Set gateway.auth (token recommended) or bind to loopback.`,
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

function isLoopbackClientHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function collectBrowserControlFindings(cfg: ClawdbotConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  let resolved: ReturnType<typeof resolveBrowserConfig>;
  try {
    resolved = resolveBrowserConfig(cfg.browser);
  } catch (err) {
    findings.push({
      checkId: "browser.control_invalid_config",
      severity: "warn",
      title: "Browser control config looks invalid",
      detail: String(err),
      remediation: `Fix browser.controlUrl/browser.cdpUrl in ${resolveConfigPath()} and re-run "clawdbot security audit --deep".`,
    });
    return findings;
  }

  if (!resolved.enabled) return findings;

  const url = new URL(resolved.controlUrl);
  const isLoopback = isLoopbackClientHost(url.hostname);
  const envToken = process.env.CLAWDBOT_BROWSER_CONTROL_TOKEN?.trim();
  const controlToken = (envToken || resolved.controlToken)?.trim() || null;

  if (!isLoopback) {
    if (!controlToken) {
      findings.push({
        checkId: "browser.control_remote_no_token",
        severity: "critical",
        title: "Remote browser control is missing an auth token",
        detail: `browser.controlUrl is non-loopback (${resolved.controlUrl}) but no browser.controlToken (or CLAWDBOT_BROWSER_CONTROL_TOKEN) is configured.`,
        remediation:
          "Set browser.controlToken (or export CLAWDBOT_BROWSER_CONTROL_TOKEN) and prefer serving over Tailscale Serve or HTTPS reverse proxy.",
      });
    }

    if (url.protocol === "http:") {
      findings.push({
        checkId: "browser.control_remote_http",
        severity: "warn",
        title: "Remote browser control uses HTTP",
        detail: `browser.controlUrl=${resolved.controlUrl} is http; this is OK only if it's tailnet-only (Tailscale) or behind another encrypted tunnel.`,
        remediation: `Prefer HTTPS termination (Tailscale Serve) and keep the endpoint tailnet-only.`,
      });
    }

    if (controlToken && controlToken.length < 24) {
      findings.push({
        checkId: "browser.control_token_too_short",
        severity: "warn",
        title: "Browser control token looks short",
        detail: `browser control token is ${controlToken.length} chars; prefer a long random token.`,
      });
    }

    const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
    const gatewayAuth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, tailscaleMode });
    const gatewayToken =
      gatewayAuth.mode === "token" &&
      typeof gatewayAuth.token === "string" &&
      gatewayAuth.token.trim()
        ? gatewayAuth.token.trim()
        : null;

    if (controlToken && gatewayToken && controlToken === gatewayToken) {
      findings.push({
        checkId: "browser.control_token_reuse_gateway_token",
        severity: "warn",
        title: "Browser control token reuses the Gateway token",
        detail: `browser.controlToken matches gateway.auth token; compromise of browser control expands blast radius to the Gateway API.`,
        remediation: `Use a separate browser.controlToken dedicated to browser control.`,
      });
    }
  }

  return findings;
}

function collectLoggingFindings(cfg: ClawdbotConfig): SecurityAuditFinding[] {
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

function collectElevatedFindings(cfg: ClawdbotConfig): SecurityAuditFinding[] {
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
  cfg: ClawdbotConfig;
  plugins: ReturnType<typeof listChannelPlugins>;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];

  const warnDmPolicy = async (input: {
    label: string;
    provider: ChannelId;
    dmPolicy: string;
    allowFrom?: Array<string | number> | null;
    policyPath?: string;
    allowFromPath: string;
  }) => {
    const policyPath = input.policyPath ?? `${input.allowFromPath}policy`;
    const configAllowFrom = normalizeAllowFromList(input.allowFrom);
    const hasWildcard = configAllowFrom.includes("*");

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
      return;
    }

    if (input.dmPolicy === "disabled") {
      findings.push({
        checkId: `channels.${input.provider}.dm.disabled`,
        severity: "info",
        title: `${input.label} DMs are disabled`,
        detail: `${policyPath}="disabled" ignores inbound DMs.`,
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
  }

  return findings;
}

async function maybeProbeGateway(params: {
  cfg: ClawdbotConfig;
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

  const auth = remoteUrlMissing ? resolveAuth("local") : resolveAuth("remote");
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
  const env = process.env;
  const stateDir = opts.stateDir ?? resolveStateDir(env);
  const configPath = opts.configPath ?? resolveConfigPath(env, stateDir);

  findings.push(...collectAttackSurfaceSummaryFindings(cfg));
  findings.push(...collectSyncedFolderFindings({ stateDir, configPath }));

  findings.push(...collectGatewayConfigFindings(cfg));
  findings.push(...collectBrowserControlFindings(cfg));
  findings.push(...collectLoggingFindings(cfg));
  findings.push(...collectElevatedFindings(cfg));
  findings.push(...collectHooksHardeningFindings(cfg));
  findings.push(...collectSecretsInConfigFindings(cfg));
  findings.push(...collectModelHygieneFindings(cfg));
  findings.push(...collectExposureMatrixFindings(cfg));

  const configSnapshot =
    opts.includeFilesystem !== false
      ? await readConfigSnapshotForAudit({ env, configPath }).catch(() => null)
      : null;

  if (opts.includeFilesystem !== false) {
    findings.push(...(await collectFilesystemFindings({ stateDir, configPath })));
    if (configSnapshot) {
      findings.push(...(await collectIncludeFilePermFindings({ configSnapshot })));
    }
    findings.push(...(await collectStateDeepFilesystemFindings({ cfg, env, stateDir })));
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
      remediation: `Run "clawdbot status --all" to debug connectivity/auth, then re-run "clawdbot security audit --deep".`,
    });
  }

  const summary = countBySeverity(findings);
  return { ts: Date.now(), summary, findings, deep };
}
