/**
 * Asynchronous security audit collector functions.
 *
 * These functions perform I/O (filesystem, config reads) to detect security issues.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../config/config.js";
import { collectIncludePathsRecursive } from "../config/includes-scan.js";
import { resolveOAuthDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { extensionUsesSkippedScannerPath, isPathInside } from "./scan-paths.js";
import type { SkillScanFinding } from "./skill-scanner.js";
import type { ExecFn } from "./windows-acl.js";

export type SecurityAuditFinding = {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

type CollectPluginsTrustFindingsParams = Parameters<
  typeof import("./audit-plugins-trust.js").collectPluginsTrustFindings
>[0];
type SkillScanSummary = Awaited<
  ReturnType<typeof import("./skill-scanner.js").scanDirectoryWithSummary>
>;
type ExecDockerRawFn = (
  args: string[],
  opts?: { allowFailure?: boolean; input?: Buffer | string; signal?: AbortSignal },
) => Promise<import("../agents/sandbox/docker.js").ExecDockerRawResult>;

type CodeSafetySummaryCache = Map<string, Promise<unknown>>;
let skillsModulePromise: Promise<typeof import("../agents/skills.js")> | undefined;
let configModulePromise: Promise<typeof import("../config/config.js")> | undefined;
let agentScopeModulePromise: Promise<typeof import("../agents/agent-scope.js")> | undefined;
let agentWorkspaceDirsModulePromise:
  | Promise<typeof import("../agents/workspace-dirs.js")>
  | undefined;
let skillSourceModulePromise: Promise<typeof import("../agents/skills/source.js")> | undefined;
let sandboxDockerModulePromise: Promise<typeof import("../agents/sandbox/docker.js")> | undefined;
let sandboxConstantsModulePromise:
  | Promise<typeof import("../agents/sandbox/constants.js")>
  | undefined;
let auditPluginsTrustModulePromise: Promise<typeof import("./audit-plugins-trust.js")> | undefined;
let auditFsModulePromise: Promise<typeof import("./audit-fs.js")> | undefined;
let skillScannerModulePromise: Promise<typeof import("./skill-scanner.js")> | undefined;

function loadSkillsModule() {
  skillsModulePromise ??= import("../agents/skills.js");
  return skillsModulePromise;
}

function loadConfigModule() {
  configModulePromise ??= import("../config/config.js");
  return configModulePromise;
}

function loadAuditFsModule() {
  auditFsModulePromise ??= import("./audit-fs.js");
  return auditFsModulePromise;
}

function loadAgentScopeModule() {
  agentScopeModulePromise ??= import("../agents/agent-scope.js");
  return agentScopeModulePromise;
}

function loadAgentWorkspaceDirsModule() {
  agentWorkspaceDirsModulePromise ??= import("../agents/workspace-dirs.js");
  return agentWorkspaceDirsModulePromise;
}

function loadSkillSourceModule() {
  skillSourceModulePromise ??= import("../agents/skills/source.js");
  return skillSourceModulePromise;
}

function loadSkillScannerModule() {
  skillScannerModulePromise ??= import("./skill-scanner.js");
  return skillScannerModulePromise;
}

async function loadExecDockerRaw(): Promise<ExecDockerRawFn> {
  sandboxDockerModulePromise ??= import("../agents/sandbox/docker.js");
  const { execDockerRaw } = await sandboxDockerModulePromise;
  return execDockerRaw;
}

async function loadSandboxBrowserSecurityHashEpoch(): Promise<string> {
  sandboxConstantsModulePromise ??= import("../agents/sandbox/constants.js");
  const { SANDBOX_BROWSER_SECURITY_HASH_EPOCH } = await sandboxConstantsModulePromise;
  return SANDBOX_BROWSER_SECURITY_HASH_EPOCH;
}

export async function collectPluginsTrustFindings(
  params: CollectPluginsTrustFindingsParams,
): Promise<SecurityAuditFinding[]> {
  auditPluginsTrustModulePromise ??= import("./audit-plugins-trust.js");
  const { collectPluginsTrustFindings: collect } = await auditPluginsTrustModulePromise;
  return await collect(params);
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function safeStat(targetPath: string): Promise<{
  ok: boolean;
  isSymlink: boolean;
  isDir: boolean;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  error?: string;
}> {
  try {
    const lst = await fs.lstat(targetPath);
    return {
      ok: true,
      isSymlink: lst.isSymbolicLink(),
      isDir: lst.isDirectory(),
      mode: typeof lst.mode === "number" ? lst.mode : null,
      uid: typeof lst.uid === "number" ? lst.uid : null,
      gid: typeof lst.gid === "number" ? lst.gid : null,
    };
  } catch (err) {
    return {
      ok: false,
      isSymlink: false,
      isDir: false,
      mode: null,
      uid: null,
      gid: null,
      error: String(err),
    };
  }
}

function expandTilde(p: string, env: NodeJS.ProcessEnv): string | null {
  if (!p.startsWith("~")) {
    return p;
  }
  const home = normalizeOptionalString(env.HOME) ?? null;
  if (!home) {
    return null;
  }
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(home, p.slice(2));
  }
  return null;
}

async function readPluginManifestExtensions(pluginPath: string): Promise<string[]> {
  const manifestPath = path.join(pluginPath, "package.json");
  const raw = await fs.readFile(manifestPath, "utf-8").catch(() => "");
  if (!raw.trim()) {
    return [];
  }

  let parsed: Partial<Record<typeof MANIFEST_KEY, { extensions?: unknown }>> | null;
  try {
    parsed = JSON.parse(raw) as Partial<
      Record<typeof MANIFEST_KEY, { extensions?: unknown }>
    > | null;
  } catch (err) {
    // Re-throw so callers can surface a security finding for malformed manifests.
    // A malicious plugin could use a malformed package.json to hide declared
    // extension entrypoints from deep scan — callers must not silently drop them.
    throw new Error(`Failed to parse plugin manifest at ${manifestPath}: ${String(err)}`, {
      cause: err,
    });
  }
  const extensions = parsed?.[MANIFEST_KEY]?.extensions;
  if (!Array.isArray(extensions)) {
    return [];
  }
  return extensions.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean);
}

function formatCodeSafetyDetails(findings: SkillScanFinding[], rootDir: string): string {
  return findings
    .map((finding) => {
      const relPath = path.relative(rootDir, finding.file);
      const filePath =
        relPath && relPath !== "." && !relPath.startsWith("..")
          ? relPath
          : path.basename(finding.file);
      const normalizedPath = filePath.replaceAll("\\", "/");
      return `  - [${finding.ruleId}] ${finding.message} (${normalizedPath}:${finding.line})`;
    })
    .join("\n");
}

async function listInstalledPluginDirs(params: {
  stateDir: string;
  onReadError?: (error: unknown) => void;
}): Promise<{ extensionsDir: string; pluginDirs: string[] }> {
  const extensionsDir = path.join(params.stateDir, "extensions");
  const st = await safeStat(extensionsDir);
  if (!st.ok || !st.isDir) {
    return { extensionsDir, pluginDirs: [] };
  }
  const entries = await fs.readdir(extensionsDir, { withFileTypes: true }).catch((err) => {
    params.onReadError?.(err);
    return [];
  });
  const pluginDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(Boolean);
  return { extensionsDir, pluginDirs };
}

function buildCodeSafetySummaryCacheKey(params: {
  dirPath: string;
  includeFiles?: string[];
}): string {
  const includeFiles = (params.includeFiles ?? []).map((entry) => entry.trim()).filter(Boolean);
  const includeKey = includeFiles.length > 0 ? includeFiles.toSorted().join("\u0000") : "";
  return `${params.dirPath}\u0000${includeKey}`;
}

async function getCodeSafetySummary(params: {
  dirPath: string;
  includeFiles?: string[];
  summaryCache?: CodeSafetySummaryCache;
}): Promise<SkillScanSummary> {
  const cacheKey = buildCodeSafetySummaryCacheKey({
    dirPath: params.dirPath,
    includeFiles: params.includeFiles,
  });
  const cache = params.summaryCache;
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit) {
      return (await hit) as SkillScanSummary;
    }
    const skillScanner = await loadSkillScannerModule();
    const pending = skillScanner.scanDirectoryWithSummary(params.dirPath, {
      includeFiles: params.includeFiles,
    });
    cache.set(cacheKey, pending);
    return await pending;
  }
  const skillScanner = await loadSkillScannerModule();
  return await skillScanner.scanDirectoryWithSummary(params.dirPath, {
    includeFiles: params.includeFiles,
  });
}

// --------------------------------------------------------------------------
// Exported collectors
// --------------------------------------------------------------------------

function normalizeDockerLabelValue(raw: string | undefined): string | null {
  const trimmed = normalizeOptionalString(raw) ?? "";
  if (!trimmed || trimmed === "<no value>") {
    return null;
  }
  return trimmed;
}

async function listSandboxBrowserContainers(
  execDockerRawFn: ExecDockerRawFn,
): Promise<string[] | null> {
  try {
    const result = await execDockerRawFn(
      ["ps", "-a", "--filter", "label=openclaw.sandboxBrowser=1", "--format", "{{.Names}}"],
      { allowFailure: true },
    );
    if (result.code !== 0) {
      return null;
    }
    return result.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

async function readSandboxBrowserHashLabels(params: {
  containerName: string;
  execDockerRawFn: ExecDockerRawFn;
}): Promise<{ configHash: string | null; epoch: string | null } | null> {
  try {
    const result = await params.execDockerRawFn(
      [
        "inspect",
        "-f",
        '{{ index .Config.Labels "openclaw.configHash" }}\t{{ index .Config.Labels "openclaw.browserConfigEpoch" }}',
        params.containerName,
      ],
      { allowFailure: true },
    );
    if (result.code !== 0) {
      return null;
    }
    const [hashRaw, epochRaw] = result.stdout.toString("utf8").split("\t");
    return {
      configHash: normalizeDockerLabelValue(hashRaw),
      epoch: normalizeDockerLabelValue(epochRaw),
    };
  } catch {
    return null;
  }
}

function parsePublishedHostFromDockerPortLine(line: string): string | null {
  const trimmed = normalizeOptionalString(line) ?? "";
  const rhs = trimmed.includes("->")
    ? (normalizeOptionalString(trimmed.split("->").at(-1)) ?? "")
    : trimmed;
  if (!rhs) {
    return null;
  }
  const bracketHost = rhs.match(/^\[([^\]]+)\]:\d+$/);
  if (bracketHost?.[1]) {
    return bracketHost[1];
  }
  const hostPort = rhs.match(/^([^:]+):\d+$/);
  if (hostPort?.[1]) {
    return hostPort[1];
  }
  return null;
}

function isLoopbackPublishHost(host: string): boolean {
  const normalized = normalizeOptionalLowercaseString(host);
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

async function readSandboxBrowserPortMappings(params: {
  containerName: string;
  execDockerRawFn: ExecDockerRawFn;
}): Promise<string[] | null> {
  try {
    const result = await params.execDockerRawFn(["port", params.containerName], {
      allowFailure: true,
    });
    if (result.code !== 0) {
      return null;
    }
    return result.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

export async function collectSandboxBrowserHashLabelFindings(params?: {
  execDockerRawFn?: ExecDockerRawFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const [execFn, browserHashEpoch] = await Promise.all([
    params?.execDockerRawFn ? Promise.resolve(params.execDockerRawFn) : loadExecDockerRaw(),
    loadSandboxBrowserSecurityHashEpoch(),
  ]);
  const containers = await listSandboxBrowserContainers(execFn);
  if (!containers || containers.length === 0) {
    return findings;
  }

  const missingHash: string[] = [];
  const staleEpoch: string[] = [];
  const nonLoopbackPublished: string[] = [];

  for (const containerName of containers) {
    const labels = await readSandboxBrowserHashLabels({ containerName, execDockerRawFn: execFn });
    if (!labels) {
      continue;
    }
    if (!labels.configHash) {
      missingHash.push(containerName);
    }
    if (labels.epoch !== browserHashEpoch) {
      staleEpoch.push(containerName);
    }
    const portMappings = await readSandboxBrowserPortMappings({
      containerName,
      execDockerRawFn: execFn,
    });
    if (!portMappings?.length) {
      continue;
    }
    const exposedMappings = portMappings.filter((line) => {
      const host = parsePublishedHostFromDockerPortLine(line);
      return Boolean(host && !isLoopbackPublishHost(host));
    });
    if (exposedMappings.length > 0) {
      nonLoopbackPublished.push(`${containerName} (${exposedMappings.join("; ")})`);
    }
  }

  if (missingHash.length > 0) {
    findings.push({
      checkId: "sandbox.browser_container.hash_label_missing",
      severity: "warn",
      title: "Sandbox browser container missing config hash label",
      detail:
        `Containers: ${missingHash.join(", ")}. ` +
        "These browser containers predate hash-based drift checks and may miss security remediations until recreated.",
      remediation: `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt).`,
    });
  }

  if (staleEpoch.length > 0) {
    findings.push({
      checkId: "sandbox.browser_container.hash_epoch_stale",
      severity: "warn",
      title: "Sandbox browser container hash epoch is stale",
      detail:
        `Containers: ${staleEpoch.join(", ")}. ` +
        `Expected openclaw.browserConfigEpoch=${browserHashEpoch}.`,
      remediation: `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt).`,
    });
  }

  if (nonLoopbackPublished.length > 0) {
    findings.push({
      checkId: "sandbox.browser_container.non_loopback_publish",
      severity: "critical",
      title: "Sandbox browser container publishes ports on non-loopback interfaces",
      detail:
        `Containers: ${nonLoopbackPublished.join(", ")}. ` +
        "Sandbox browser observer/control ports should stay loopback-only to avoid unintended remote access.",
      remediation:
        `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt), ` +
        "then verify published ports are bound to 127.0.0.1.",
    });
  }

  return findings;
}

export async function collectIncludeFilePermFindings(params: {
  configSnapshot: ConfigFileSnapshot;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  if (!params.configSnapshot.exists) {
    return findings;
  }

  const configPath = params.configSnapshot.path;
  const includePaths = await collectIncludePathsRecursive({
    configPath,
    parsed: params.configSnapshot.parsed,
  });
  if (includePaths.length === 0) {
    return findings;
  }

  const { formatPermissionDetail, formatPermissionRemediation, inspectPathPermissions } =
    await loadAuditFsModule();

  for (const p of includePaths) {
    const perms = await inspectPathPermissions(p, {
      env: params.env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (!perms.ok) {
      continue;
    }
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
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const oauthDir = resolveOAuthDir(params.env, params.stateDir);
  const { formatPermissionDetail, formatPermissionRemediation, inspectPathPermissions } =
    await loadAuditFsModule();

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
        .map(
          (a) =>
            normalizeOptionalString(
              a && typeof a === "object" ? (a as { id?: unknown }).id : undefined,
            ) ?? "",
        )
        .filter(Boolean)
    : [];
  const { resolveDefaultAgentId } = await loadAgentScopeModule();
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const ids = Array.from(new Set([defaultAgentId, ...agentIds])).map((id) => normalizeAgentId(id));

  for (const agentId of ids) {
    const agentDir = path.join(params.stateDir, "agents", agentId, "agent");
    const authPath = path.join(agentDir, "auth-profiles.json");
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

  const logFile = normalizeOptionalString(params.cfg.logging?.file) ?? "";
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

export async function readConfigSnapshotForAudit(params: {
  env: NodeJS.ProcessEnv;
  configPath: string;
}): Promise<ConfigFileSnapshot> {
  const { createConfigIO } = await loadConfigModule();
  return await createConfigIO({
    env: params.env,
    configPath: params.configPath,
  }).readConfigFileSnapshot();
}

export async function collectPluginsCodeSafetyFindings(params: {
  stateDir: string;
  summaryCache?: CodeSafetySummaryCache;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const { extensionsDir, pluginDirs } = await listInstalledPluginDirs({
    stateDir: params.stateDir,
    onReadError: (err) => {
      findings.push({
        checkId: "plugins.code_safety.scan_failed",
        severity: "warn",
        title: "Plugin extensions directory scan failed",
        detail: `Static code scan could not list extensions directory: ${String(err)}`,
        remediation:
          "Check file permissions and plugin layout, then rerun `openclaw security audit --deep`.",
      });
    },
  });

  for (const pluginName of pluginDirs) {
    const pluginPath = path.join(extensionsDir, pluginName);
    let extensionEntries: string[] = [];
    try {
      extensionEntries = await readPluginManifestExtensions(pluginPath);
    } catch (manifestErr) {
      // Malformed package.json — surface a warning so the user investigates.
      // A plugin could deliberately corrupt its manifest to hide declared
      // extension entrypoints from the deep code scanner.
      findings.push({
        checkId: "plugins.code_safety.manifest_parse_error",
        severity: "warn",
        title: `Plugin "${pluginName}" has a malformed package.json`,
        detail:
          `Could not parse plugin manifest: ${String(manifestErr)}.\n` +
          "The extension entrypoint list is unavailable. Deep scan will cover the plugin directory but may miss entries declared via `openclaw.extensions`.",
        remediation:
          "Inspect the plugin package.json for syntax errors. If the plugin is untrusted, remove it from your OpenClaw extensions state directory.",
      });
      // Continue — getCodeSafetySummary below still scans the plugin directory
    }
    const forcedScanEntries: string[] = [];
    const escapedEntries: string[] = [];

    for (const entry of extensionEntries) {
      const resolvedEntry = path.resolve(pluginPath, entry);
      if (!isPathInside(pluginPath, resolvedEntry)) {
        escapedEntries.push(entry);
        continue;
      }
      if (extensionUsesSkippedScannerPath(entry)) {
        findings.push({
          checkId: "plugins.code_safety.entry_path",
          severity: "warn",
          title: `Plugin "${pluginName}" entry path is hidden or node_modules`,
          detail: `Extension entry "${entry}" points to a hidden or node_modules path. Deep code scan will cover this entry explicitly, but review this path choice carefully.`,
          remediation: "Prefer extension entrypoints under normal source paths like dist/ or src/.",
        });
      }
      forcedScanEntries.push(resolvedEntry);
    }

    if (escapedEntries.length > 0) {
      findings.push({
        checkId: "plugins.code_safety.entry_escape",
        severity: "critical",
        title: `Plugin "${pluginName}" has extension entry path traversal`,
        detail: `Found extension entries that escape the plugin directory:\n${escapedEntries.map((entry) => `  - ${entry}`).join("\n")}`,
        remediation:
          "Update the plugin manifest so all openclaw.extensions entries stay inside the plugin directory.",
      });
    }

    const summary = await getCodeSafetySummary({
      dirPath: pluginPath,
      includeFiles: forcedScanEntries,
      summaryCache: params.summaryCache,
    }).catch((err) => {
      findings.push({
        checkId: "plugins.code_safety.scan_failed",
        severity: "warn",
        title: `Plugin "${pluginName}" code scan failed`,
        detail: `Static code scan could not complete: ${String(err)}`,
        remediation:
          "Check file permissions and plugin layout, then rerun `openclaw security audit --deep`.",
      });
      return null;
    });
    if (!summary) {
      continue;
    }

    if (summary.critical > 0) {
      const criticalFindings = summary.findings.filter((f) => f.severity === "critical");
      const details = formatCodeSafetyDetails(criticalFindings, pluginPath);

      findings.push({
        checkId: "plugins.code_safety",
        severity: "critical",
        title: `Plugin "${pluginName}" contains dangerous code patterns`,
        detail: `Found ${summary.critical} critical issue(s) in ${summary.scannedFiles} scanned file(s):\n${details}`,
        remediation:
          "Review the plugin source code carefully before use. If untrusted, remove the plugin from your OpenClaw extensions state directory.",
      });
    } else if (summary.warn > 0) {
      const warnFindings = summary.findings.filter((f) => f.severity === "warn");
      const details = formatCodeSafetyDetails(warnFindings, pluginPath);

      findings.push({
        checkId: "plugins.code_safety",
        severity: "warn",
        title: `Plugin "${pluginName}" contains suspicious code patterns`,
        detail: `Found ${summary.warn} warning(s) in ${summary.scannedFiles} scanned file(s):\n${details}`,
        remediation: `Review the flagged code to ensure it is intentional and safe.`,
      });
    }
  }

  return findings;
}

export async function collectInstalledSkillsCodeSafetyFindings(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  summaryCache?: CodeSafetySummaryCache;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const pluginExtensionsDir = path.join(params.stateDir, "extensions");
  const scannedSkillDirs = new Set<string>();
  const [{ listAgentWorkspaceDirs }, { resolveSkillSource }] = await Promise.all([
    loadAgentWorkspaceDirsModule(),
    loadSkillSourceModule(),
  ]);
  const workspaceDirs = listAgentWorkspaceDirs(params.cfg);
  const { loadWorkspaceSkillEntries } = await loadSkillsModule();

  for (const workspaceDir of workspaceDirs) {
    const entries = loadWorkspaceSkillEntries(workspaceDir, { config: params.cfg });
    for (const entry of entries) {
      if (resolveSkillSource(entry.skill) === "openclaw-bundled") {
        continue;
      }

      const skillDir = path.resolve(entry.skill.baseDir);
      if (isPathInside(pluginExtensionsDir, skillDir)) {
        // Plugin code is already covered by plugins.code_safety checks.
        continue;
      }
      if (scannedSkillDirs.has(skillDir)) {
        continue;
      }
      scannedSkillDirs.add(skillDir);

      const skillName = entry.skill.name;
      const summary = await getCodeSafetySummary({
        dirPath: skillDir,
        summaryCache: params.summaryCache,
      }).catch((err) => {
        findings.push({
          checkId: "skills.code_safety.scan_failed",
          severity: "warn",
          title: `Skill "${skillName}" code scan failed`,
          detail: `Static code scan could not complete for ${skillDir}: ${String(err)}`,
          remediation:
            "Check file permissions and skill layout, then rerun `openclaw security audit --deep`.",
        });
        return null;
      });
      if (!summary) {
        continue;
      }

      if (summary.critical > 0) {
        const criticalFindings = summary.findings.filter(
          (finding) => finding.severity === "critical",
        );
        const details = formatCodeSafetyDetails(criticalFindings, skillDir);
        findings.push({
          checkId: "skills.code_safety",
          severity: "critical",
          title: `Skill "${skillName}" contains dangerous code patterns`,
          detail: `Found ${summary.critical} critical issue(s) in ${summary.scannedFiles} scanned file(s) under ${skillDir}:\n${details}`,
          remediation: `Review the skill source code before use. If untrusted, remove "${skillDir}".`,
        });
      } else if (summary.warn > 0) {
        const warnFindings = summary.findings.filter((finding) => finding.severity === "warn");
        const details = formatCodeSafetyDetails(warnFindings, skillDir);
        findings.push({
          checkId: "skills.code_safety",
          severity: "warn",
          title: `Skill "${skillName}" contains suspicious code patterns`,
          detail: `Found ${summary.warn} warning(s) in ${summary.scannedFiles} scanned file(s) under ${skillDir}:\n${details}`,
          remediation: "Review flagged lines to ensure the behavior is intentional and safe.",
        });
      }
    }
  }

  return findings;
}
