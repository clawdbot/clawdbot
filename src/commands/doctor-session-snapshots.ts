/** Doctor repair for stale runtime snapshot paths cached in session stores. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveStateDir } from "../config/paths.js";
import { hydrateSessionStoreSkillPromptRefs } from "../config/sessions/skill-prompt-blobs.js";
import { updateSessionStore } from "../config/sessions/store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { writeTextAtomic } from "../infra/json-files.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resolveBundledSkillsDir } from "../skills/loading/bundled-dir.js";
import { resolveConfigDir, shortenHomePath } from "../utils.js";

const SESSION_SNAPSHOTS_CHECK_ID = "core/doctor/session-snapshots";

type SnapshotPathSource =
  | "skillsSnapshot.prompt"
  | "skillsSnapshot.resolvedSkills"
  | "systemPromptReport.injectedWorkspaceFiles";

type CachedSnapshotPath = {
  field: SnapshotPathSource;
  path: string;
};

type StaleSessionSnapshotPathFinding = {
  sessionKey: string;
  field: SnapshotPathSource;
  cachedPath: string;
  expectedPath: string;
};

type SessionSnapshotHealthIssue = StaleSessionSnapshotPathFinding & {
  storePath: string;
};

function resolveSessionSnapshotBundledSkillsDir(params?: {
  bundledSkillsDir?: string;
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
  execPath?: string;
}): string | undefined {
  const explicit = params?.bundledSkillsDir?.trim();
  if (explicit) {
    return explicit;
  }
  const resolved = resolveBundledSkillsDir({
    argv1: params?.argv1,
    moduleUrl: params?.moduleUrl,
    cwd: params?.cwd,
    execPath: params?.execPath,
  });
  if (resolved) {
    return resolved;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    argv1: params?.argv1 ?? process.argv[1],
    moduleUrl: params?.moduleUrl ?? import.meta.url,
    cwd: params?.cwd ?? process.cwd(),
  });
  return packageRoot ? path.join(packageRoot, "skills") : undefined;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractSkillLocations(prompt: unknown): string[] {
  if (typeof prompt !== "string" || !prompt.trim()) {
    return [];
  }
  const locations: string[] = [];
  const locationPattern = /<location>([\s\S]*?)<\/location>/g;
  for (const match of prompt.matchAll(locationPattern)) {
    const raw = match[1]?.trim();
    if (raw) {
      locations.push(decodeXmlText(raw));
    }
  }
  return locations;
}

function collectResolvedSkillPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const paths: string[] = [];
  for (const skill of value) {
    if (!isRecord(skill)) {
      continue;
    }
    if (typeof skill.filePath === "string" && skill.filePath.trim()) {
      paths.push(skill.filePath.trim());
    }
    if (typeof skill.baseDir === "string" && skill.baseDir.trim()) {
      paths.push(path.join(skill.baseDir.trim(), "SKILL.md"));
    }
    if (isRecord(skill.sourceInfo)) {
      if (typeof skill.sourceInfo.path === "string" && skill.sourceInfo.path.trim()) {
        paths.push(skill.sourceInfo.path.trim());
      }
      if (typeof skill.sourceInfo.baseDir === "string" && skill.sourceInfo.baseDir.trim()) {
        paths.push(path.join(skill.sourceInfo.baseDir.trim(), "SKILL.md"));
      }
    }
  }
  return paths;
}

function collectInjectedWorkspaceFilePaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (isRecord(entry) && typeof entry.path === "string" ? entry.path.trim() : ""))
    .filter(Boolean);
}

function collectCachedSnapshotPaths(entry: SessionEntry): CachedSnapshotPath[] {
  const snapshot = entry.skillsSnapshot as Record<string, unknown> | undefined;
  const report = entry.systemPromptReport as Record<string, unknown> | undefined;
  const paths: CachedSnapshotPath[] = [];
  for (const location of extractSkillLocations(snapshot?.prompt)) {
    paths.push({ field: "skillsSnapshot.prompt", path: location });
  }
  for (const location of collectResolvedSkillPaths(snapshot?.resolvedSkills)) {
    paths.push({ field: "skillsSnapshot.resolvedSkills", path: location });
  }
  if (isRecord(report)) {
    for (const location of collectInjectedWorkspaceFilePaths(report.injectedWorkspaceFiles)) {
      paths.push({ field: "systemPromptReport.injectedWorkspaceFiles", path: location });
    }
  }
  return paths;
}

function isAbsolutePathLike(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function splitPathSegments(value: string): string[] {
  return value
    .replace(/^[a-z]:/i, "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean);
}
function isWindowsAbsolutePath(value: string): boolean {
  return (
    (/^[a-z]:/i.test(value) && ["/", "\\"].includes(value.slice(2, 3))) || value.startsWith("\\\\")
  );
}
function isTempBackedOpenClawRoot(segments: readonly string[]): boolean {
  const lower = segments.map((segment) => segment.toLowerCase());
  const openclawIndex = lower.lastIndexOf("openclaw");
  if (openclawIndex < 1) {
    return false;
  }
  return lower[openclawIndex - 1] === "tmp" || lower[openclawIndex - 1] === "temp";
}

function isBundledRuntimeSkillsPath(cachedPath: string, skillRootIndex: number): boolean {
  const beforeSkillRoot = splitPathSegments(cachedPath).slice(0, skillRootIndex);
  const lower = beforeSkillRoot.map((segment) => segment.toLowerCase());
  return (
    lower.some(
      (segment) =>
        segment === "dist-runtime" || segment === "node_modules" || segment.startsWith("openclaw@"),
    ) || isTempBackedOpenClawRoot(beforeSkillRoot)
  );
}
function extractBundledSkillRelativeSegments(cachedPath: string): string[] | undefined {
  const segments = splitPathSegments(cachedPath);
  const skillRootIndex = segments.lastIndexOf("skills");
  if (skillRootIndex < 0 || !isBundledRuntimeSkillsPath(cachedPath, skillRootIndex)) {
    return undefined;
  }
  const relativeSegments = segments.slice(skillRootIndex + 1);
  if (relativeSegments.length < 2 || relativeSegments.at(-1) !== "SKILL.md") {
    return undefined;
  }
  return relativeSegments;
}
function isInsidePath(baseDir: string, candidatePath: string): boolean {
  const baseIsWindows = isWindowsAbsolutePath(baseDir);
  const candidateIsWindows = isWindowsAbsolutePath(candidatePath);
  if (baseIsWindows !== candidateIsWindows) {
    return false;
  }
  const pathApi = baseIsWindows ? path.win32 : path;
  const relative = pathApi.relative(pathApi.resolve(baseDir), pathApi.resolve(candidatePath));
  return (
    relative === "" ||
    (relative !== "" && !relative.startsWith("..") && !pathApi.isAbsolute(relative))
  );
}
function joinPathForRoot(root: string, ...segments: string[]): string {
  return isWindowsAbsolutePath(root)
    ? path.win32.join(root, ...segments)
    : path.join(root, ...segments);
}
function resolveExpectedBundledSkillPath(params: {
  cachedPath: string;
  bundledSkillsDir: string;
  pathExists: (filePath: string) => boolean;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const expandedCachedPath = expandHomePrefix(params.cachedPath, {
    home: params.homeDir,
    env: params.env,
  });
  if (!isAbsolutePathLike(expandedCachedPath)) {
    return undefined;
  }
  const relativeSegments = extractBundledSkillRelativeSegments(expandedCachedPath);
  if (!relativeSegments) {
    return undefined;
  }
  const movedPath = resolveMovedBundledSkillPath({
    relativeSegments,
    pathExists: params.pathExists,
    env: params.env,
  });
  if (movedPath) {
    return movedPath;
  }
  if (isInsidePath(params.bundledSkillsDir, expandedCachedPath)) {
    return undefined;
  }
  const expectedPath = joinPathForRoot(params.bundledSkillsDir, ...relativeSegments);
  if (params.pathExists(expectedPath)) {
    return expectedPath;
  }
  return undefined;
}

function resolveMovedBundledSkillPath(params: {
  relativeSegments: readonly string[];
  pathExists: (filePath: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (params.relativeSegments.join("/") !== "imsg/SKILL.md") {
    return undefined;
  }
  const expectedPath = path.join(resolveConfigDir(params.env), "plugin-skills", "imsg", "SKILL.md");
  return params.pathExists(expectedPath) ? expectedPath : undefined;
}

/** Finds cached bundled-skill paths that point at old runtime/temp package roots. */
function scanSessionStoreForStaleRuntimeSnapshotPaths(params: {
  store: Record<string, SessionEntry>;
  bundledSkillsDir: string | undefined;
  pathExists?: (filePath: string) => boolean;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): StaleSessionSnapshotPathFinding[] {
  const bundledSkillsDir = params.bundledSkillsDir?.trim();
  if (!bundledSkillsDir) {
    return [];
  }
  const pathExists = params.pathExists ?? fs.existsSync;
  const findings: StaleSessionSnapshotPathFinding[] = [];
  const seen = new Set<string>();
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    for (const cached of collectCachedSnapshotPaths(entry)) {
      const expectedPath = resolveExpectedBundledSkillPath({
        cachedPath: cached.path,
        bundledSkillsDir,
        pathExists,
        homeDir: params.homeDir,
        env: params.env,
      });
      if (!expectedPath) {
        continue;
      }
      const key = `${sessionKey}\0${cached.field}\0${cached.path}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      findings.push({
        sessionKey,
        field: cached.field,
        cachedPath: cached.path,
        expectedPath,
      });
    }
  }
  return findings;
}

async function listSessionStorePaths(stateDir: string): Promise<string[]> {
  const agentsDir = path.join(stateDir, "agents");
  let agentEntries: fs.Dirent[];
  try {
    agentEntries = await fs.promises.readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return agentEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(agentsDir, entry.name, "sessions", "sessions.json"))
    .filter((storePath) => fs.existsSync(storePath))
    .toSorted((a, b) => a.localeCompare(b));
}

function resolveSessionStorePaths(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] | undefined {
  if (!params.cfg) {
    return undefined;
  }
  return resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env })
    .map((target) => target.storePath)
    .filter((storePath) => fs.existsSync(storePath))
    .toSorted((a, b) => a.localeCompare(b));
}

function loadSessionStoreForSnapshotScan(storePath: string): Record<string, SessionEntry> {
  const parsed = JSON.parse(fs.readFileSync(storePath, "utf-8")) as unknown;
  if (!isRecord(parsed)) {
    return {};
  }
  const store = parsed as Record<string, SessionEntry>;
  hydrateSessionStoreSkillPromptRefs({ storePath, store });
  return store;
}

export async function detectSessionSnapshotHealthIssues(params?: {
  storePaths?: string[];
  bundledSkillsDir?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<SessionSnapshotHealthIssue[]> {
  const bundledSkillsDir = resolveSessionSnapshotBundledSkillsDir({
    bundledSkillsDir: params?.bundledSkillsDir,
  });
  if (!bundledSkillsDir) {
    return [];
  }
  const storePaths =
    params?.storePaths ??
    resolveSessionStorePaths({ cfg: params?.cfg, env: params?.env }) ??
    (await listSessionStorePaths(resolveStateDir(params?.env)));
  const issues: SessionSnapshotHealthIssue[] = [];
  for (const storePath of storePaths) {
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStoreForSnapshotScan(storePath);
    } catch {
      continue;
    }
    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      store,
      bundledSkillsDir,
      env: params?.env,
    });
    for (const finding of findings) {
      issues.push({
        sessionKey: finding.sessionKey,
        field: finding.field,
        cachedPath: finding.cachedPath,
        expectedPath: finding.expectedPath,
        storePath,
      });
    }
  }
  return issues;
}

export function sessionSnapshotIssueToHealthFinding(
  issue: SessionSnapshotHealthIssue,
): HealthFinding {
  return {
    checkId: SESSION_SNAPSHOTS_CHECK_ID,
    severity: "info",
    message: `${issue.sessionKey} cached session metadata references an inactive runtime root that can be cleaned up.`,
    path: issue.storePath,
    target: issue.cachedPath,
    requirement: `Current bundled skill path: ${issue.expectedPath}`,
    fixHint:
      "To clean up the advisory artifact, run `openclaw doctor --fix` to rewrite stale cached session metadata paths, or start a fresh session after confirming history can be retired.",
  };
}

export function sessionSnapshotIssueToRepairEffect(
  issue: SessionSnapshotHealthIssue,
): HealthRepairEffect {
  return {
    kind: "file",
    action: "would-rewrite-session-snapshot-path",
    target: issue.storePath,
    dryRunSafe: false,
  };
}

/** Replaces stale paths in raw, JSON-escaped, and XML-escaped prompt text. */
function replaceStalePathsInText(text: string, finding: StaleSessionSnapshotPathFinding): string {
  const jsonEscaped = JSON.stringify(finding.cachedPath).slice(1, -1);
  const jsonEscapedExpected = JSON.stringify(finding.expectedPath).slice(1, -1);
  const xmlEscaped = finding.cachedPath
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  const xmlEscapedExpected = finding.expectedPath
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  let result = text;
  if (result.includes(jsonEscaped)) {
    result = result.replaceAll(jsonEscaped, jsonEscapedExpected);
  }
  if (result.includes(xmlEscaped)) {
    result = result.replaceAll(xmlEscaped, xmlEscapedExpected);
  }
  if (result.includes(finding.cachedPath)) {
    result = result.replaceAll(finding.cachedPath, finding.expectedPath);
  }
  return result;
}

function repairFreshSessionSnapshotPaths(params: {
  store: Record<string, SessionEntry>;
  rawStore: Record<string, unknown>;
  findings: readonly StaleSessionSnapshotPathFinding[];
}): number {
  let replacements = 0;
  for (const finding of params.findings) {
    // Canonical loading intentionally strips resolvedSkills. Count the stale legacy cache once;
    // saving through the writer removes that non-persistent cache from the durable entry.
    if (finding.field === "skillsSnapshot.resolvedSkills") {
      const rawSession = params.rawStore[finding.sessionKey];
      const rawSnapshot = isRecord(rawSession) ? rawSession.skillsSnapshot : undefined;
      if (isRecord(rawSnapshot) && Array.isArray(rawSnapshot.resolvedSkills)) {
        replacements += 1;
      }
      continue;
    }

    const session = params.store[finding.sessionKey] as Record<string, unknown> | undefined;
    if (!isRecord(session)) {
      continue;
    }
    const jsonEscaped = JSON.stringify(finding.cachedPath).slice(1, -1);
    const jsonEscapedExpected = JSON.stringify(finding.expectedPath).slice(1, -1);

    if (finding.field === "skillsSnapshot.prompt") {
      const snapshot = session.skillsSnapshot;
      if (!isRecord(snapshot) || typeof snapshot.prompt !== "string") {
        continue;
      }
      const prompt = replaceStalePathsInText(snapshot.prompt, finding);
      if (prompt !== snapshot.prompt) {
        snapshot.prompt = prompt;
        replacements += 1;
      }
      continue;
    }

    const report = session.systemPromptReport;
    if (!isRecord(report) || !Array.isArray(report.injectedWorkspaceFiles)) {
      continue;
    }
    for (const entry of report.injectedWorkspaceFiles) {
      if (!isRecord(entry) || typeof entry.path !== "string") {
        continue;
      }
      let entryPath = entry.path;
      const original = entryPath;
      for (const { cached, expected } of [
        { cached: jsonEscaped, expected: jsonEscapedExpected },
        { cached: finding.cachedPath, expected: finding.expectedPath },
      ]) {
        if (entryPath.includes(cached)) {
          entryPath = entryPath.replaceAll(cached, expected);
        }
      }
      if (entryPath !== original) {
        entry.path = entryPath;
        replacements += 1;
      }
    }
  }
  return replacements;
}

/** Reports and optionally repairs stale bundled skill paths in session snapshot metadata. */
export async function noteSessionSnapshotHealth(params?: {
  storePaths?: string[];
  bundledSkillsDir?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair?: boolean;
}) {
  const bundledSkillsDir = resolveSessionSnapshotBundledSkillsDir({
    bundledSkillsDir: params?.bundledSkillsDir,
  });
  if (!bundledSkillsDir) {
    return;
  }
  const storePaths =
    params?.storePaths ??
    resolveSessionStorePaths({ cfg: params?.cfg, env: params?.env }) ??
    (await listSessionStorePaths(resolveStateDir(params?.env)));
  const findingsByStore = new Map<string, StaleSessionSnapshotPathFinding[]>();
  for (const storePath of storePaths) {
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStoreForSnapshotScan(storePath);
    } catch (err) {
      note(
        `- Failed to inspect session snapshot metadata in ${shortenHomePath(storePath)}: ${String(err)}`,
        "Session snapshots",
      );
      continue;
    }
    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      store,
      bundledSkillsDir,
      env: params?.env,
    });
    if (findings.length > 0) {
      findingsByStore.set(storePath, findings);
    }
  }
  const totalFindings = [...findingsByStore.values()].reduce(
    (total, findings) => total + findings.length,
    0,
  );
  if (totalFindings === 0) {
    return;
  }
  const affectedSessions = new Set(
    [...findingsByStore.values()].flatMap((findings) =>
      findings.map((finding) => finding.sessionKey),
    ),
  );

  if (params?.shouldRepair) {
    let repairedStores = 0;
    let totalReplacements = 0;
    let leftoverFindings = 0;

    for (const [storePath, findings] of findingsByStore) {
      try {
        const repairResult = await updateSessionStore(
          storePath,
          async (store) => {
            const raw = fs.readFileSync(storePath, "utf-8");
            const parsed = JSON.parse(raw) as unknown;
            const rawStore = isRecord(parsed) ? parsed : {};
            const replacements = repairFreshSessionSnapshotPaths({
              store,
              rawStore,
              findings,
            });
            if (replacements > 0) {
              // The backup belongs inside the writer lane so it matches the store revision that
              // the canonical writer is about to replace.
              const backupPath = `${storePath}.bak.${Date.now()}`;
              await writeTextAtomic(backupPath, raw, { mode: 0o600 });
            }
            return { replacements };
          },
          {
            requireWriteSuccess: true,
            skipMaintenance: true,
            skipSaveWhenResult: (result) => result.replacements === 0,
          },
        );

        if (repairResult.replacements > 0) {
          totalReplacements += repairResult.replacements;
          repairedStores++;

          // Rescan to report leftover findings
          const repairedStore = loadSessionStoreForSnapshotScan(storePath);
          const leftovers = scanSessionStoreForStaleRuntimeSnapshotPaths({
            store: repairedStore,
            bundledSkillsDir,
            env: params?.env,
          });
          leftoverFindings += leftovers.length;
        }
      } catch (err) {
        note(
          `- Failed to repair session snapshot paths in ${shortenHomePath(storePath)}: ${String(err)}`,
          "Session snapshots",
        );
      }
    }

    if (repairedStores > 0) {
      const msg = `- Repaired ${totalReplacements} stale path${totalReplacements === 1 ? "" : "s"} across ${repairedStores} store${repairedStores === 1 ? "" : "s"}.`;
      if (leftoverFindings > 0) {
        note(
          `${msg}\n  ${leftoverFindings} stale path${leftoverFindings === 1 ? "" : "s"} still remain (possibly non-bundled or non-repairable).`,
          "Session snapshots",
        );
      } else {
        note(msg, "Session snapshots");
      }
      return;
    }
  }

  const lines = [
    `- Found ${affectedSessions.size} session${affectedSessions.size === 1 ? "" : "s"} with stale cached session metadata paths.`,
    `  Live bundled skills root is healthy: ${shortenHomePath(bundledSkillsDir)}`,
    "  Cached session metadata still references an inactive runtime root; start a fresh session or reset the affected long-lived sessions after confirming history can be retired.",
  ];
  let shown = 0;
  for (const [storePath, findings] of findingsByStore) {
    lines.push(`  Store: ${shortenHomePath(storePath)}`);
    for (const finding of findings.slice(0, Math.max(0, 10 - shown))) {
      lines.push(
        `  - ${finding.sessionKey} ${finding.field}: ${shortenHomePath(
          finding.cachedPath,
        )} -> ${shortenHomePath(finding.expectedPath)}`,
      );
      shown += 1;
      if (shown >= 10) {
        break;
      }
    }
    if (shown >= 10) {
      break;
    }
  }
  if (totalFindings > shown) {
    lines.push(
      `  ...and ${totalFindings - shown} more stale cached path${totalFindings - shown === 1 ? "" : "s"}.`,
    );
  }
  note(lines.join("\n"), "Session snapshots");
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorSessionSnapshotsTestApi")
  ] = {
    resolveSessionSnapshotBundledSkillsDir,
    scanSessionStoreForStaleRuntimeSnapshotPaths,
  };
}
