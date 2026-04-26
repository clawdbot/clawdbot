import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { type ExecApprovalsFile, loadExecApprovals } from "../infra/exec-approvals.js";
import { isInterpreterLikeAllowlistPattern } from "../infra/exec-inline-eval.js";
import {
  listInterpreterLikeSafeBins,
  resolveMergedSafeBinProfileFixtures,
} from "../infra/exec-safe-bin-runtime-policy.js";
import { listRiskyConfiguredSafeBins } from "../infra/exec-safe-bin-semantics.js";
import { normalizeTrustedSafeBinDirs } from "../infra/exec-safe-bin-trust.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { asNullableRecord } from "../shared/record-coerce.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { collectDeepCodeSafetyFindings } from "./audit-deep-code-safety.js";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";
import {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
} from "./audit-fs.js";
import { collectGatewayConfigFindings as collectGatewayConfigFindingsBase } from "./audit-gateway-config.js";
import type {
  SecurityAuditFinding,
  SecurityAuditReport,
  SecurityAuditSeverity,
  SecurityAuditSummary,
} from "./audit.types.js";
import { collectEnabledInsecureOrDangerousFlags } from "./dangerous-config-flags.js";
import type { ExecFn } from "./windows-acl.js";

type ExecDockerRawFn = typeof import("../agents/sandbox/docker.js").execDockerRaw;
type ProbeGatewayFn = typeof import("../gateway/probe.js").probeGateway;

export type {
  SecurityAuditFinding,
  SecurityAuditReport,
  SecurityAuditSeverity,
  SecurityAuditSummary,
} from "./audit.types.js";

export type SecurityAuditOptions = {
  config: OpenClawConfig;
  sourceConfig?: OpenClawConfig;
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
  plugins?: ChannelPlugin[];
  /** Whether to import plugin modules to discover plugin security audit collectors. */
  loadPluginSecurityCollectors?: boolean;
  /** Dependency injection for tests (Windows ACL checks). */
  execIcacls?: ExecFn;
  /** Dependency injection for tests (Docker label checks). */
  execDockerRawFn?: ExecDockerRawFn;
  /** Optional preloaded config snapshot to skip audit-time config file reads. */
  configSnapshot?: ConfigFileSnapshot | null;
  /** Optional cache for code-safety summaries across repeated deep audits. */
  codeSafetySummaryCache?: Map<string, Promise<unknown>>;
  /** Optional explicit auth for deep gateway probe. */
  deepProbeAuth?: { token?: string; password?: string };
  /** Override workspace used for workspace plugin discovery. */
  workspaceDir?: string;
  /** Dependency injection for tests. */
  probeGatewayFn?: ProbeGatewayFn;
};

export type AuditExecutionContext = {
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  includeFilesystem: boolean;
  includeChannelSecurity: boolean;
  deep: boolean;
  deepTimeoutMs: number;
  stateDir: string;
  configPath: string;
  execIcacls?: ExecFn;
  execDockerRawFn?: ExecDockerRawFn;
  probeGatewayFn?: ProbeGatewayFn;
  plugins?: ChannelPlugin[];
  loadPluginSecurityCollectors: boolean;
  configSnapshot: ConfigFileSnapshot | null;
  codeSafetySummaryCache: Map<string, Promise<unknown>>;
  deepProbeAuth?: { token?: string; password?: string };
  workspaceDir?: string;
};

let readOnlyChannelPluginsModulePromise:
  | Promise<typeof import("../channels/plugins/read-only.js")>
  | undefined;
let auditNonDeepModulePromise: Promise<typeof import("./audit.nondeep.runtime.js")> | undefined;
let auditChannelModulePromise:
  | Promise<typeof import("./audit-channel.collect.runtime.js")>
  | undefined;
let pluginMetadataRegistryLoaderModulePromise:
  | Promise<typeof import("../plugins/runtime/metadata-registry-loader.js")>
  | undefined;
let pluginAutoEnableModulePromise:
  | Promise<typeof import("../config/plugin-auto-enable.js")>
  | undefined;
let channelPluginIdsModulePromise:
  | Promise<typeof import("../plugins/channel-plugin-ids.js")>
  | undefined;
let pluginRuntimeModulePromise: Promise<typeof import("../plugins/runtime.js")> | undefined;
let gatewayProbeDepsPromise:
  | Promise<{
      buildGatewayConnectionDetails: typeof import("../gateway/call.js").buildGatewayConnectionDetails;
      resolveGatewayProbeAuthSafe: typeof import("../gateway/probe-auth.js").resolveGatewayProbeAuthSafe;
      resolveGatewayProbeTarget: typeof import("../gateway/probe-auth.js").resolveGatewayProbeTarget;
      probeGateway: typeof import("../gateway/probe.js").probeGateway;
    }>
  | undefined;

async function loadReadOnlyChannelPlugins() {
  readOnlyChannelPluginsModulePromise ??= import("../channels/plugins/read-only.js");
  return await readOnlyChannelPluginsModulePromise;
}

async function loadAuditNonDeepModule() {
  auditNonDeepModulePromise ??= import("./audit.nondeep.runtime.js");
  return await auditNonDeepModulePromise;
}

async function loadAuditChannelModule() {
  auditChannelModulePromise ??= import("./audit-channel.collect.runtime.js");
  return await auditChannelModulePromise;
}

async function loadPluginMetadataRegistryLoaderModule() {
  pluginMetadataRegistryLoaderModulePromise ??=
    import("../plugins/runtime/metadata-registry-loader.js");
  return await pluginMetadataRegistryLoaderModulePromise;
}

async function loadPluginAutoEnableModule() {
  pluginAutoEnableModulePromise ??= import("../config/plugin-auto-enable.js");
  return await pluginAutoEnableModulePromise;
}

async function loadChannelPluginIdsModule() {
  channelPluginIdsModulePromise ??= import("../plugins/channel-plugin-ids.js");
  return await channelPluginIdsModulePromise;
}

async function loadPluginRuntimeModule() {
  pluginRuntimeModulePromise ??= import("../plugins/runtime.js");
  return await pluginRuntimeModulePromise;
}

async function loadGatewayProbeDeps() {
  gatewayProbeDepsPromise ??= Promise.all([
    import("../gateway/call.js"),
    import("../gateway/probe-auth.js"),
    import("../gateway/probe.js"),
  ]).then(([callModule, probeAuthModule, probeModule]) => ({
    buildGatewayConnectionDetails: callModule.buildGatewayConnectionDetails,
    resolveGatewayProbeAuthSafe: probeAuthModule.resolveGatewayProbeAuthSafe,
    resolveGatewayProbeTarget: probeAuthModule.resolveGatewayProbeTarget,
    probeGateway: probeModule.probeGateway,
  }));
  return await gatewayProbeDepsPromise;
}

function countBySeverity(findings: SecurityAuditFinding[]): SecurityAuditSummary {
  let critical = 0;
  let warn = 0;
  let info = 0;
  for (const f of findings) {
    if (f.severity === "critical") {
      critical += 1;
    } else if (f.severity === "warn") {
      warn += 1;
    } else {
      info += 1;
    }
  }
  return { critical, warn, info };
}

function normalizeAllowFromList(list: Array<string | number> | undefined | null): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((v) => String(v).trim()).filter(Boolean);
}

export async function collectFilesystemFindings(params: {
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
        detail: `${formatPermissionDetail(params.stateDir, stateDirPerms)}; other users can write into your OpenClaw state.`,
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
        detail: `${formatPermissionDetail(params.stateDir, stateDirPerms)}; group users can write into your OpenClaw state.`,
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
    const skipReadablePermWarnings = configPerms.isSymlink;
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
    } else if (!skipReadablePermWarnings && configPerms.worldReadable) {
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
    } else if (!skipReadablePermWarnings && configPerms.groupReadable) {
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

export function collectGatewayConfigFindings(
  cfg: OpenClawConfig,
  sourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): SecurityAuditFinding[] {
  return collectGatewayConfigFindingsBase(cfg, sourceConfig, env, {
    collectDangerousConfigFlags: collectEnabledInsecureOrDangerousFlags,
  });
}

export async function collectPluginSecurityAuditFindings(
  context: AuditExecutionContext,
): Promise<SecurityAuditFinding[]> {
  if (!context.loadPluginSecurityCollectors) {
    return [];
  }
  const { getActivePluginRegistry } = await loadPluginRuntimeModule();
  let collectors = getActivePluginRegistry()?.securityAuditCollectors ?? [];
  if (collectors.length === 0) {
    const { applyPluginAutoEnable } = await loadPluginAutoEnableModule();
    const autoEnabled = applyPluginAutoEnable({
      config: context.sourceConfig,
      env: context.env,
    });
    const requestedPluginIds = new Set<string>();
    for (const pluginId of Object.keys(autoEnabled.autoEnabledReasons)) {
      const normalized = pluginId.trim();
      if (normalized) {
        requestedPluginIds.add(normalized);
      }
    }
    for (const pluginId of autoEnabled.config.plugins?.allow ?? []) {
      if (typeof pluginId !== "string") {
        continue;
      }
      const normalized = pluginId.trim();
      if (normalized) {
        requestedPluginIds.add(normalized);
      }
    }
    for (const [pluginId, entry] of Object.entries(autoEnabled.config.plugins?.entries ?? {})) {
      if (entry?.enabled === false) {
        continue;
      }
      const normalized = pluginId.trim();
      if (normalized) {
        requestedPluginIds.add(normalized);
      }
    }
    if (context.includeChannelSecurity && context.plugins !== undefined) {
      const { resolveConfiguredChannelPluginIds } = await loadChannelPluginIdsModule();
      const auditedChannelPluginIds = new Set(context.plugins.map((plugin) => plugin.id));
      for (const pluginId of resolveConfiguredChannelPluginIds({
        config: autoEnabled.config,
        activationSourceConfig: context.sourceConfig,
        workspaceDir: context.workspaceDir,
        env: context.env,
      })) {
        if (auditedChannelPluginIds.has(pluginId)) {
          requestedPluginIds.delete(pluginId);
        }
      }
    }
    if (requestedPluginIds.size === 0) {
      return [];
    }
    const snapshot = (
      await loadPluginMetadataRegistryLoaderModule()
    ).loadPluginMetadataRegistrySnapshot({
      config: autoEnabled.config,
      activationSourceConfig: context.sourceConfig,
      env: context.env,
      workspaceDir: context.workspaceDir,
      onlyPluginIds: [...requestedPluginIds],
    });
    collectors = snapshot.securityAuditCollectors ?? [];
  }
  const collectorResults = await Promise.all(
    collectors.map(async (entry) => {
      try {
        return await entry.collector({
          config: context.cfg,
          sourceConfig: context.sourceConfig,
          env: context.env,
          stateDir: context.stateDir,
          configPath: context.configPath,
        });
      } catch (err) {
        return [
          {
            checkId: `plugins.${entry.pluginId}.security_audit_failed`,
            severity: "warn" as const,
            title: "Plugin security audit collector failed",
            detail: `${entry.pluginId}: ${String(err)}`,
          },
        ];
      }
    }),
  );
  return collectorResults.flat();
}

export function collectLoggingFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const redact = cfg.logging?.redactSensitive;
  if (redact !== "off") {
    return [];
  }
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

export function collectElevatedFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const enabled = cfg.tools?.elevated?.enabled;
  const allowFrom = cfg.tools?.elevated?.allowFrom ?? {};
  const anyAllowFromKeys = Object.keys(allowFrom).length > 0;

  if (enabled === false) {
    return findings;
  }
  if (!anyAllowFromKeys) {
    return findings;
  }

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

export function collectExecRuntimeFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const globalExecHost = cfg.tools?.exec?.host;
  const globalStrictInlineEval = cfg.tools?.exec?.strictInlineEval === true;
  const defaultSandboxMode = resolveSandboxConfigForAgent(cfg).mode;
  const defaultHostIsExplicitSandbox = globalExecHost === "sandbox";
  const approvals = loadExecApprovals();

  if (defaultHostIsExplicitSandbox && defaultSandboxMode === "off") {
    findings.push({
      checkId: "tools.exec.host_sandbox_no_sandbox_defaults",
      severity: "warn",
      title: "Exec host is sandbox but sandbox mode is off",
      detail:
        "tools.exec.host is explicitly set to sandbox while agents.defaults.sandbox.mode=off. " +
        "In this mode, exec fails closed because no sandbox runtime is available.",
      remediation:
        'Enable sandbox mode (`agents.defaults.sandbox.mode="non-main"` or `"all"`) or set tools.exec.host to "gateway" with approvals.',
    });
  }

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const riskyAgents = agents
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        entry.tools?.exec?.host === "sandbox" &&
        resolveSandboxConfigForAgent(cfg, entry.id).mode === "off",
    )
    .map((entry) => entry.id)
    .slice(0, 5);

  if (riskyAgents.length > 0) {
    findings.push({
      checkId: "tools.exec.host_sandbox_no_sandbox_agents",
      severity: "warn",
      title: "Agent exec host uses sandbox while sandbox mode is off",
      detail:
        `agents.list.*.tools.exec.host is set to sandbox for: ${riskyAgents.join(", ")}. ` +
        "With sandbox mode off, exec fails closed for those agents.",
      remediation:
        'Enable sandbox mode for these agents (`agents.list[].sandbox.mode`) or set their tools.exec.host to "gateway".',
    });
  }

  const effectiveExecScopes = Array.from(
    new Map(
      [
        {
          id: DEFAULT_AGENT_ID,
          security: cfg.tools?.exec?.security ?? "deny",
          host: cfg.tools?.exec?.host ?? "auto",
        },
        ...agents
          .filter(
            (entry): entry is NonNullable<(typeof agents)[number]> =>
              Boolean(entry) && typeof entry === "object" && typeof entry.id === "string",
          )
          .map((entry) => ({
            id: entry.id,
            security: entry.tools?.exec?.security ?? cfg.tools?.exec?.security ?? "deny",
            host: entry.tools?.exec?.host ?? cfg.tools?.exec?.host ?? "auto",
          })),
      ].map((entry) => [entry.id, entry] as const),
    ).values(),
  );
  const fullExecScopes = effectiveExecScopes.filter((entry) => entry.security === "full");
  const execEnabledScopes = effectiveExecScopes.filter((entry) => entry.security !== "deny");
  const openExecSurfacePaths = collectOpenExecSurfacePaths(cfg);

  if (fullExecScopes.length > 0) {
    findings.push({
      checkId: "tools.exec.security_full_configured",
      severity: openExecSurfacePaths.length > 0 ? "critical" : "warn",
      title: "Exec security=full is configured",
      detail:
        `Full exec trust is enabled for: ${fullExecScopes.map((entry) => entry.id).join(", ")}.` +
        (openExecSurfacePaths.length > 0
          ? ` Open channel access was also detected at:\n${openExecSurfacePaths.map((entry) => `- ${entry}`).join("\n")}`
          : ""),
      remediation:
        'Prefer tools.exec.security="allowlist" with ask prompts, and reserve "full" for tightly scoped break-glass agents only.',
    });
  }

  if (openExecSurfacePaths.length > 0 && execEnabledScopes.length > 0) {
    findings.push({
      checkId: "security.exposure.open_channels_with_exec",
      severity: fullExecScopes.length > 0 ? "critical" : "warn",
      title: "Open channels can reach exec-enabled agents",
      detail:
        `Open DM/group access detected at:\n${openExecSurfacePaths.map((entry) => `- ${entry}`).join("\n")}\n` +
        `Exec-enabled scopes:\n${execEnabledScopes.map((entry) => `- ${entry.id}: security=${entry.security}, host=${entry.host}`).join("\n")}`,
      remediation:
        "Tighten dmPolicy/groupPolicy to pairing or allowlist, or disable exec for agents reachable from shared/public channels.",
    });
  }

  const autoAllowSkillsHits = collectAutoAllowSkillsHits(approvals);
  if (autoAllowSkillsHits.length > 0) {
    findings.push({
      checkId: "tools.exec.auto_allow_skills_enabled",
      severity: "warn",
      title: "autoAllowSkills is enabled for exec approvals",
      detail:
        `Implicit skill-bin allowlisting is enabled at:\n${autoAllowSkillsHits.map((entry) => `- ${entry}`).join("\n")}\n` +
        "This widens host exec trust beyond explicit manual allowlist entries.",
      remediation:
        "Disable autoAllowSkills in exec approvals and keep manual allowlists tight when you need explicit host-exec trust.",
    });
  }

  const interpreterAllowlistHits = collectInterpreterAllowlistHits({
    approvals,
    strictInlineEvalForAgentId: (agentId) => {
      if (!agentId || agentId === "*" || agentId === DEFAULT_AGENT_ID) {
        return globalStrictInlineEval;
      }
      const agent = agents.find((entry) => entry?.id === agentId);
      return agent?.tools?.exec?.strictInlineEval === true || globalStrictInlineEval;
    },
  });
  if (interpreterAllowlistHits.length > 0) {
    findings.push({
      checkId: "tools.exec.allowlist_interpreter_without_strict_inline_eval",
      severity: "warn",
      title: "Interpreter allowlist entries are missing strictInlineEval hardening",
      detail: `Interpreter/runtime allowlist entries were found without strictInlineEval enabled:\n${interpreterAllowlistHits.map((entry) => `- ${entry}`).join("\n")}`,
      remediation:
        "Set tools.exec.strictInlineEval=true (or per-agent tools.exec.strictInlineEval=true) when allowlisting interpreters like python, node, ruby, perl, php, lua, or osascript.",
    });
  }

  const normalizeConfiguredSafeBins = (entries: unknown): string[] => {
    if (!Array.isArray(entries)) {
      return [];
    }
    return Array.from(
      new Set(
        entries
          .map((entry) => normalizeOptionalLowercaseString(entry) ?? "")
          .filter((entry) => entry.length > 0),
      ),
    ).toSorted();
  };
  const normalizeConfiguredTrustedDirs = (entries: unknown): string[] => {
    if (!Array.isArray(entries)) {
      return [];
    }
    return normalizeTrustedSafeBinDirs(
      entries.filter((entry): entry is string => typeof entry === "string"),
    );
  };
  const classifyRiskySafeBinTrustedDir = (entry: string): string | null => {
    const raw = entry.trim();
    if (!raw) {
      return null;
    }
    if (!path.isAbsolute(raw)) {
      return "relative path (trust boundary depends on process cwd)";
    }
    const normalized = path.resolve(raw).replace(/\\/g, "/").toLowerCase();
    if (
      normalized === "/tmp" ||
      normalized.startsWith("/tmp/") ||
      normalized === "/var/tmp" ||
      normalized.startsWith("/var/tmp/") ||
      normalized === "/private/tmp" ||
      normalized.startsWith("/private/tmp/")
    ) {
      return "temporary directory is mutable and easy to poison";
    }
    if (
      normalized === "/usr/local/bin" ||
      normalized === "/opt/homebrew/bin" ||
      normalized === "/opt/local/bin" ||
      normalized === "/home/linuxbrew/.linuxbrew/bin"
    ) {
      return "package-manager bin directory (often user-writable)";
    }
    if (
      normalized.startsWith("/users/") ||
      normalized.startsWith("/home/") ||
      normalized.includes("/.local/bin")
    ) {
      return "home-scoped bin directory (typically user-writable)";
    }
    if (/^[a-z]:\/users\//.test(normalized)) {
      return "home-scoped bin directory (typically user-writable)";
    }
    return null;
  };

  const globalExec = cfg.tools?.exec;
  const riskyTrustedDirHits: string[] = [];
  const collectRiskyTrustedDirHits = (scopePath: string, entries: unknown): void => {
    for (const entry of normalizeConfiguredTrustedDirs(entries)) {
      const reason = classifyRiskySafeBinTrustedDir(entry);
      if (!reason) {
        continue;
      }
      riskyTrustedDirHits.push(`- ${scopePath}.safeBinTrustedDirs: ${entry} (${reason})`);
    }
  };
  collectRiskyTrustedDirHits("tools.exec", globalExec?.safeBinTrustedDirs);
  for (const entry of agents) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    collectRiskyTrustedDirHits(
      `agents.list.${entry.id}.tools.exec`,
      entry.tools?.exec?.safeBinTrustedDirs,
    );
  }

  const interpreterHits: string[] = [];
  const riskySemanticSafeBinHits: string[] = [];
  const globalSafeBins = normalizeConfiguredSafeBins(globalExec?.safeBins);
  if (globalSafeBins.length > 0) {
    const merged = resolveMergedSafeBinProfileFixtures({ global: globalExec }) ?? {};
    const interpreters = listInterpreterLikeSafeBins(globalSafeBins).filter((bin) => !merged[bin]);
    if (interpreters.length > 0) {
      interpreterHits.push(`- tools.exec.safeBins: ${interpreters.join(", ")}`);
    }
    for (const hit of listRiskyConfiguredSafeBins(globalSafeBins)) {
      riskySemanticSafeBinHits.push(`- tools.exec.safeBins: ${hit.bin} (${hit.warning})`);
    }
  }

  for (const entry of agents) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    const agentExec = entry.tools?.exec;
    const agentSafeBins = normalizeConfiguredSafeBins(agentExec?.safeBins);
    if (agentSafeBins.length === 0) {
      continue;
    }
    const merged =
      resolveMergedSafeBinProfileFixtures({
        global: globalExec,
        local: agentExec,
      }) ?? {};
    const interpreters = listInterpreterLikeSafeBins(agentSafeBins).filter((bin) => !merged[bin]);
    if (interpreters.length === 0) {
      for (const hit of listRiskyConfiguredSafeBins(agentSafeBins)) {
        riskySemanticSafeBinHits.push(
          `- agents.list.${entry.id}.tools.exec.safeBins: ${hit.bin} (${hit.warning})`,
        );
      }
      continue;
    }
    interpreterHits.push(
      `- agents.list.${entry.id}.tools.exec.safeBins: ${interpreters.join(", ")}`,
    );
    for (const hit of listRiskyConfiguredSafeBins(agentSafeBins)) {
      riskySemanticSafeBinHits.push(
        `- agents.list.${entry.id}.tools.exec.safeBins: ${hit.bin} (${hit.warning})`,
      );
    }
  }

  if (interpreterHits.length > 0) {
    findings.push({
      checkId: "tools.exec.safe_bins_interpreter_unprofiled",
      severity: "warn",
      title: "safeBins includes interpreter/runtime binaries without explicit profiles",
      detail:
        `Detected interpreter-like safeBins entries missing explicit profiles:\n${interpreterHits.join("\n")}\n` +
        "These entries can turn safeBins into a broad execution surface when used with permissive argv profiles.",
      remediation:
        "Remove interpreter/runtime bins from safeBins (prefer allowlist entries) or define hardened tools.exec.safeBinProfiles.<bin> rules.",
    });
  }

  if (riskySemanticSafeBinHits.length > 0) {
    findings.push({
      checkId: "tools.exec.safe_bins_broad_behavior",
      severity: "warn",
      title: "safeBins includes binaries with broader semantics than low-risk stream filters",
      detail:
        `Detected risky safeBins entries:\n${riskySemanticSafeBinHits.join("\n")}\n` +
        "These tools expose semantics that do not fit the low-risk stdin-filter fast path.",
      remediation:
        "Remove these binaries from safeBins and prefer explicit allowlist entries or approval-gated execution.",
    });
  }

  if (riskyTrustedDirHits.length > 0) {
    findings.push({
      checkId: "tools.exec.safe_bin_trusted_dirs_risky",
      severity: "warn",
      title: "safeBinTrustedDirs includes risky mutable directories",
      detail:
        `Detected risky safeBinTrustedDirs entries:\n${riskyTrustedDirHits.slice(0, 10).join("\n")}` +
        (riskyTrustedDirHits.length > 10
          ? `\n- +${riskyTrustedDirHits.length - 10} more entries.`
          : ""),
      remediation:
        "Prefer root-owned immutable bins, keep default trust dirs (/bin, /usr/bin), and avoid trusting temporary/home/package-manager paths unless tightly controlled.",
    });
  }

  return findings;
}

function collectOpenExecSurfacePaths(cfg: OpenClawConfig): string[] {
  const channels = asNullableRecord(cfg.channels);
  if (!channels) {
    return [];
  }
  const hits = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown, scope: string) => {
    const record = asNullableRecord(value);
    if (!record || seen.has(record)) {
      return;
    }
    seen.add(record);
    if (record.groupPolicy === "open") {
      hits.add(`${scope}.groupPolicy`);
    }
    if (record.dmPolicy === "open") {
      hits.add(`${scope}.dmPolicy`);
    }
    for (const [key, nested] of Object.entries(record)) {
      if (key === "groups" || key === "accounts" || key === "dms") {
        visit(nested, `${scope}.${key}`);
        continue;
      }
      if (asNullableRecord(nested)) {
        visit(nested, `${scope}.${key}`);
      }
    }
  };
  for (const [channelId, channelValue] of Object.entries(channels)) {
    visit(channelValue, `channels.${channelId}`);
  }
  return Array.from(hits).toSorted();
}

function collectAutoAllowSkillsHits(approvals: ExecApprovalsFile): string[] {
  const hits: string[] = [];
  if (approvals.defaults?.autoAllowSkills === true) {
    hits.push("defaults.autoAllowSkills");
  }
  for (const [agentId, agent] of Object.entries(approvals.agents ?? {})) {
    if (agent?.autoAllowSkills === true) {
      hits.push(`agents.${agentId}.autoAllowSkills`);
    }
  }
  return hits;
}

function collectInterpreterAllowlistHits(params: {
  approvals: ExecApprovalsFile;
  strictInlineEvalForAgentId: (agentId: string | undefined) => boolean;
}): string[] {
  const hits: string[] = [];
  for (const [agentId, agent] of Object.entries(params.approvals.agents ?? {})) {
    if (!agent || params.strictInlineEvalForAgentId(agentId)) {
      continue;
    }
    for (const entry of agent.allowlist ?? []) {
      if (!isInterpreterLikeAllowlistPattern(entry.pattern)) {
        continue;
      }
      hits.push(`agents.${agentId}.allowlist: ${entry.pattern}`);
    }
  }
  return hits;
}

async function maybeProbeGateway(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  probe: ProbeGatewayFn;
  explicitAuth?: { token?: string; password?: string };
}): Promise<{
  deep: SecurityAuditReport["deep"];
  authWarning?: string;
}> {
  const { buildGatewayConnectionDetails, resolveGatewayProbeAuthSafe, resolveGatewayProbeTarget } =
    await loadGatewayProbeDeps();
  const connection = buildGatewayConnectionDetails({ config: params.cfg });
  const url = connection.url;
  const probeTarget = resolveGatewayProbeTarget(params.cfg);

  const authResolution = resolveGatewayProbeAuthSafe({
    cfg: params.cfg,
    env: params.env,
    mode: probeTarget.mode,
    explicitAuth: params.explicitAuth,
  });
  const res = await params
    .probe({ url, auth: authResolution.auth, timeoutMs: params.timeoutMs })
    .catch((err) => ({
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

  if (authResolution.warning && !res.ok) {
    res.error = res.error ? `${res.error}; ${authResolution.warning}` : authResolution.warning;
  }

  return {
    deep: {
      gateway: {
        attempted: true,
        url,
        ok: res.ok,
        error: res.ok ? null : res.error,
        close: res.close ? { code: res.close.code, reason: res.close.reason } : null,
      },
    },
    authWarning: authResolution.warning,
  };
}

async function createAuditExecutionContext(
  opts: SecurityAuditOptions,
): Promise<AuditExecutionContext> {
  const cfg = opts.config;
  const sourceConfig = opts.sourceConfig ?? opts.config;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const includeFilesystem = opts.includeFilesystem !== false;
  const includeChannelSecurity = opts.includeChannelSecurity !== false;
  const deep = opts.deep === true;
  const deepTimeoutMs = Math.max(250, opts.deepTimeoutMs ?? 5000);
  const stateDir = opts.stateDir ?? resolveStateDir(env);
  const configPath = opts.configPath ?? resolveConfigPath(env, stateDir);
  const workspaceDir =
    opts.workspaceDir ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const { readConfigSnapshotForAudit } = await loadAuditNonDeepModule();
  const configSnapshot = includeFilesystem
    ? opts.configSnapshot !== undefined
      ? opts.configSnapshot
      : await readConfigSnapshotForAudit({ env, configPath }).catch(() => null)
    : null;
  return {
    cfg,
    sourceConfig,
    env,
    platform,
    includeFilesystem,
    includeChannelSecurity,
    deep,
    deepTimeoutMs,
    stateDir,
    configPath,
    execIcacls: opts.execIcacls,
    execDockerRawFn: opts.execDockerRawFn,
    probeGatewayFn: opts.probeGatewayFn,
    plugins: opts.plugins,
    loadPluginSecurityCollectors: opts.loadPluginSecurityCollectors !== false,
    workspaceDir,
    configSnapshot,
    codeSafetySummaryCache: opts.codeSafetySummaryCache ?? new Map<string, Promise<unknown>>(),
    deepProbeAuth: opts.deepProbeAuth,
  };
}

export async function runSecurityAudit(opts: SecurityAuditOptions): Promise<SecurityAuditReport> {
  const findings: SecurityAuditFinding[] = [];
  const context = await createAuditExecutionContext(opts);
  const { cfg, env, platform, stateDir, configPath } = context;
  const auditNonDeep = await loadAuditNonDeepModule();

  findings.push(...auditNonDeep.collectAttackSurfaceSummaryFindings(cfg));
  findings.push(...auditNonDeep.collectSyncedFolderFindings({ stateDir, configPath }));

  findings.push(...collectGatewayConfigFindings(cfg, context.sourceConfig, env));
  findings.push(...(await collectPluginSecurityAuditFindings(context)));
  findings.push(...collectLoggingFindings(cfg));
  findings.push(...collectElevatedFindings(cfg));
  findings.push(...collectExecRuntimeFindings(cfg));
  findings.push(...auditNonDeep.collectHooksHardeningFindings(cfg, env));
  findings.push(...auditNonDeep.collectGatewayHttpNoAuthFindings(cfg, env));
  findings.push(...auditNonDeep.collectGatewayHttpSessionKeyOverrideFindings(cfg));
  findings.push(...auditNonDeep.collectSandboxDockerNoopFindings(cfg));
  findings.push(...auditNonDeep.collectSandboxDangerousConfigFindings(cfg));
  findings.push(...auditNonDeep.collectNodeDenyCommandPatternFindings(cfg));
  findings.push(...auditNonDeep.collectNodeDangerousAllowCommandFindings(cfg));
  findings.push(...auditNonDeep.collectMinimalProfileOverrideFindings(cfg));
  findings.push(...auditNonDeep.collectSecretsInConfigFindings(cfg));
  findings.push(...auditNonDeep.collectModelHygieneFindings(cfg));
  findings.push(...auditNonDeep.collectSmallModelRiskFindings({ cfg, env }));
  findings.push(...auditNonDeep.collectExposureMatrixFindings(cfg));
  findings.push(...auditNonDeep.collectLikelyMultiUserSetupFindings(cfg));

  if (context.includeFilesystem) {
    findings.push(
      ...(await collectFilesystemFindings({
        stateDir,
        configPath,
        env,
        platform,
        execIcacls: context.execIcacls,
      })),
    );
    if (context.configSnapshot) {
      findings.push(
        ...(await auditNonDeep.collectIncludeFilePermFindings({
          configSnapshot: context.configSnapshot,
          env,
          platform,
          execIcacls: context.execIcacls,
        })),
      );
    }
    findings.push(
      ...(await auditNonDeep.collectStateDeepFilesystemFindings({
        cfg,
        env,
        stateDir,
        platform,
        execIcacls: context.execIcacls,
      })),
    );
    findings.push(...(await auditNonDeep.collectWorkspaceSkillSymlinkEscapeFindings({ cfg })));
    findings.push(
      ...(await auditNonDeep.collectSandboxBrowserHashLabelFindings({
        execDockerRawFn: context.execDockerRawFn,
      })),
    );
    findings.push(...(await auditNonDeep.collectPluginsTrustFindings({ cfg, stateDir })));
    findings.push(
      ...(await collectDeepCodeSafetyFindings({
        cfg,
        stateDir,
        deep: context.deep,
        summaryCache: context.codeSafetySummaryCache,
      })),
    );
  }

  let shouldAuditChannelSecurity = false;
  if (context.includeChannelSecurity) {
    if (context.plugins !== undefined) {
      shouldAuditChannelSecurity = true;
    } else {
      const { hasConfiguredChannelsForReadOnlyScope, resolveConfiguredChannelPluginIds } =
        await loadChannelPluginIdsModule();
      shouldAuditChannelSecurity =
        hasConfiguredChannelsForReadOnlyScope({
          config: cfg,
          activationSourceConfig: context.sourceConfig,
          workspaceDir: context.workspaceDir,
          env,
        }) ||
        resolveConfiguredChannelPluginIds({
          config: cfg,
          activationSourceConfig: context.sourceConfig,
          workspaceDir: context.workspaceDir,
          env,
        }).length > 0;
    }
  }
  if (shouldAuditChannelSecurity) {
    const channelPlugins =
      context.plugins ??
      (await loadReadOnlyChannelPlugins()).listReadOnlyChannelPluginsForConfig(cfg, {
        activationSourceConfig: context.sourceConfig,
        workspaceDir: context.workspaceDir,
        env,
        stateDir,
        includePersistedAuthState: true,
        includeSetupRuntimeFallback: false,
      });
    const { collectChannelSecurityFindings } = await loadAuditChannelModule();
    findings.push(
      ...(await collectChannelSecurityFindings({
        cfg,
        sourceConfig: context.sourceConfig,
        plugins: channelPlugins,
      })),
    );
  }

  const deepProbeResult = context.deep
    ? await maybeProbeGateway({
        cfg,
        env,
        timeoutMs: context.deepTimeoutMs,
        probe: context.probeGatewayFn ?? (await loadGatewayProbeDeps()).probeGateway,
        explicitAuth: context.deepProbeAuth,
      })
    : undefined;
  const deep = deepProbeResult?.deep;
  findings.push(...collectDeepProbeFindings({ deep, authWarning: deepProbeResult?.authWarning }));

  const summary = countBySeverity(findings);
  return { ts: Date.now(), summary, findings, deep };
}
