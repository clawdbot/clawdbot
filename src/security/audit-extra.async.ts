/**
 * Asynchronous security audit collector functions.
 *
 * These functions perform I/O (filesystem, config reads) to detect security issues.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { SANDBOX_BROWSER_SECURITY_HASH_EPOCH } from "../agents/sandbox/constants.js";
import { execDockerRaw, type ExecDockerRawResult } from "../agents/sandbox/docker.js";
import { resolveSkillSource } from "../agents/skills/source.js";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
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
import {
  formatPermissionDetail,
  formatPermissionRemediation,
  inspectPathPermissions,
  safeStat,
} from "./audit-fs.js";
import { extensionUsesSkippedScannerPath, isPathInside } from "./scan-paths.js";
import type { SkillScanFinding } from "./skill-scanner.js";
import * as skillScanner from "./skill-scanner.js";
import type { ExecFn } from "./windows-acl.js";

export { collectPluginsTrustFindings } from "./audit-plugins-trust.js";

export type SecurityAuditFinding = {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

type ExecDockerRawFn = (
  args: string[],
  opts?: { allowFailure?: boolean; input?: Buffer | string; signal?: AbortSignal },
) => Promise<ExecDockerRawResult>;

type CodeSafetySummaryCache = Map<string, Promise<unknown>>;
type WorkspaceSkillScanLimits = {
  maxFiles?: number;
  maxDirVisits?: number;
};
const MAX_WORKSPACE_SKILL_SCAN_FILES_PER_WORKSPACE = 2_000;
const MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS = 12;

/**
 * Resolves the realpath of `p` with a 2 s timeout.
 *
 * Returns the realpath string on success, or `null` if realpath fails or the
 * timeout fires first. Note: fs.realpath cannot be cancelled once submitted to
 * libuv — the underlying OS call continues running in the background after the
 * timeout resolves. Callers make sequential (not concurrent) calls so at most
 * one libuv thread is occupied at a time; the OS will eventually time out the
 * stuck NFS/SMB call independently.
 *
 * Timer cleanup: when realpath resolves before the deadline the timer is
 * cleared immediately so it does not linger across the rest of the audit run.
 * The timer is also unref'd so it cannot prevent process exit even if it fires
 * late (e.g. the process finishes while a hang is still in-flight).
 */
function realpathWithTimeout(p: string, timeoutMs = 2000): Promise<string | null> {
  let timerHandle: ReturnType<typeof setTimeout> | undefined;

  const realpathPromise = fs
    .realpath(p)
    .catch(() => null)
    .then((result) => {
      clearTimeout(timerHandle);
      return result;
    });

  const timeoutPromise = new Promise<null>((resolve) => {
    timerHandle = setTimeout(() => resolve(null), timeoutMs);
    // Prevent the timer from keeping the process alive while waiting on a
    // potentially hanging NFS/SMB path during a large audit run.
    timerHandle.unref?.();
  });

  return Promise.race([realpathPromise, timeoutPromise]);
}
let skillsModulePromise: Promise<typeof import("../agents/skills.js")> | undefined;
let configModulePromise: Promise<typeof import("../config/config.js")> | undefined;

function loadSkillsModule() {
  skillsModulePromise ??= import("../agents/skills.js");
  return skillsModulePromise;
}

function loadConfigModule() {
  configModulePromise ??= import("../config/config.js");
  return configModulePromise;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

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
}): Promise<Awaited<ReturnType<typeof skillScanner.scanDirectoryWithSummary>>> {
  const cacheKey = buildCodeSafetySummaryCacheKey({
    dirPath: params.dirPath,
    includeFiles: params.includeFiles,
  });
  const cache = params.summaryCache;
  if (cache) {
    const hit = cache.get(cacheKey);
    if (hit) {
      return (await hit) as Awaited<ReturnType<typeof skillScanner.scanDirectoryWithSummary>>;
    }
    const pending = skillScanner.scanDirectoryWithSummary(params.dirPath, {
      includeFiles: params.includeFiles,
    });
    cache.set(cacheKey, pending);
    return await pending;
  }
  return await skillScanner.scanDirectoryWithSummary(params.dirPath, {
    includeFiles: params.includeFiles,
  });
}

async function listWorkspaceSkillMarkdownFiles(
  workspaceDir: string,
  limits: WorkspaceSkillScanLimits = {},
): Promise<{ skillFilePaths: string[]; truncated: boolean }> {
  const skillsRoot = path.join(workspaceDir, "skills");
  const rootStat = await safeStat(skillsRoot);
  if (!rootStat.ok || !rootStat.isDir) {
    return { skillFilePaths: [], truncated: false };
  }

  const maxFiles = limits.maxFiles ?? MAX_WORKSPACE_SKILL_SCAN_FILES_PER_WORKSPACE;
  const maxTotalDirVisits = limits.maxDirVisits ?? maxFiles * 20;
  const skillFiles: string[] = [];
  const queue: string[] = [skillsRoot];
  const visitedDirs = new Set<string>();
  let totalDirVisits = 0;

  while (queue.length > 0 && skillFiles.length < maxFiles && totalDirVisits++ < maxTotalDirVisits) {
    const dir = queue.shift()!;
    // Use the module-level realpathWithTimeout so a hanging network FS doesn't
    // block the BFS indefinitely (same 2 s guard as the outer escape-detection loop).
    const dirRealPath = (await realpathWithTimeout(dir)) ?? path.resolve(dir);
    if (visitedDirs.has(dirRealPath)) {
      continue;
    }
    visitedDirs.add(dirRealPath);

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat) {
          continue;
        }
        if (stat.isDirectory()) {
          queue.push(fullPath);
          continue;
        }
        if (stat.isFile() && entry.name === "SKILL.md") {
          skillFiles.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        skillFiles.push(fullPath);
      }
    }
  }

  return { skillFilePaths: skillFiles, truncated: queue.length > 0 };
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
  const execFn = params?.execDockerRawFn ?? execDockerRaw;
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
    if (labels.epoch !== SANDBOX_BROWSER_SECURITY_HASH_EPOCH) {
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
        `Expected openclaw.browserConfigEpoch=${SANDBOX_BROWSER_SECURITY_HASH_EPOCH}.`,
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

export async function collectWorkspaceSkillSymlinkEscapeFindings(params: {
  cfg: OpenClawConfig;
  skillScanLimits?: WorkspaceSkillScanLimits;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const workspaceDirs = listAgentWorkspaceDirs(params.cfg);
  if (workspaceDirs.length === 0) {
    return findings;
  }

  const escapedSkillFiles: Array<{
    workspaceDir: string;
    skillFilePath: string;
    skillRealPath: string;
  }> = [];
  const seenSkillPaths = new Set<string>();

  for (const workspaceDir of workspaceDirs) {
    const workspacePath = path.resolve(workspaceDir);
    const workspaceRealPath = (await realpathWithTimeout(workspacePath)) ?? workspacePath;
    const { skillFilePaths, truncated } = await listWorkspaceSkillMarkdownFiles(
      workspacePath,
      params.skillScanLimits,
    );

    if (truncated) {
      // The BFS visit cap was hit before the full skills/ tree was scanned.
      // Escaped SKILL.md symlinks in the unvisited portion will not be detected.
      // Surface this as a warning so the user knows coverage was incomplete.
      findings.push({
        checkId: "skills.workspace.scan_truncated",
        severity: "warn",
        title: "Workspace skill scan reached the directory visit limit",
        detail:
          `The skills/ directory scan in ${workspacePath} stopped early after reaching the ` +
          `BFS visit cap. Skill files in the unscanned portion of the tree were not checked ` +
          "for symlink escapes.",
        remediation:
          "Flatten or simplify the skills/ directory hierarchy to stay within the scan budget, " +
          "or move deeply-nested skill collections to a managed skill location.",
      });
    }

    for (const skillFilePath of skillFilePaths) {
      const canonicalSkillPath = path.resolve(skillFilePath);
      if (seenSkillPaths.has(canonicalSkillPath)) {
        continue;
      }
      seenSkillPaths.add(canonicalSkillPath);

      const skillRealPath = await realpathWithTimeout(canonicalSkillPath);
      if (!skillRealPath) {
        // realpath timed out or failed — cannot verify the symlink target.
        // Treat as a potential escape rather than silently bypassing the check.
        // An attacker on a slow/network FS could otherwise hang realpath to
        // prevent escape detection.
        escapedSkillFiles.push({
          workspaceDir: workspacePath,
          skillFilePath: canonicalSkillPath,
          skillRealPath: "(realpath timed out \u2014 symlink target unverifiable)",
        });
        continue;
      }
      if (isPathInside(workspaceRealPath, skillRealPath)) {
        continue;
      }
      escapedSkillFiles.push({
        workspaceDir: workspacePath,
        skillFilePath: canonicalSkillPath,
        skillRealPath,
      });
    }
  }

  if (escapedSkillFiles.length === 0) {
    return findings;
  }

  findings.push({
    checkId: "skills.workspace.symlink_escape",
    severity: "warn",
    title: "Workspace skill files resolve outside the workspace root",
    detail:
      "Detected workspace `skills/**/SKILL.md` paths whose realpath escapes their workspace root:\n" +
      escapedSkillFiles
        .slice(0, MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS)
        .map(
          (entry) =>
            `- workspace=${entry.workspaceDir}\n` +
            `  skill=${entry.skillFilePath}\n` +
            `  realpath=${entry.skillRealPath}`,
        )
        .join("\n") +
      (escapedSkillFiles.length > MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS
        ? `\n- +${escapedSkillFiles.length - MAX_WORKSPACE_SKILL_ESCAPE_DETAIL_ROWS} more`
        : ""),
    remediation:
      "Keep workspace skills inside the workspace root (replace symlinked escapes with real in-workspace files), or move trusted shared skills to managed/bundled skill locations.",
  });

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
