import fs from "node:fs";
import path from "node:path";
import { resolveBundledSkillsDir } from "../agents/skills/bundled-dir.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";

type SnapshotPathSource =
  | "skillsSnapshot.prompt"
  | "skillsSnapshot.resolvedSkills"
  | "systemPromptReport.injectedWorkspaceFiles";

type CachedSnapshotPath = {
  field: SnapshotPathSource;
  path: string;
};

export type StaleSessionSnapshotPathFinding = {
  sessionKey: string;
  field: SnapshotPathSource;
  cachedPath: string;
  expectedPath: string;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    relative === "" || (!!relative && !relative.startsWith("..") && !pathApi.isAbsolute(relative))
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
  if (isInsidePath(params.bundledSkillsDir, expandedCachedPath)) {
    return undefined;
  }
  const relativeSegments = extractBundledSkillRelativeSegments(expandedCachedPath);
  if (!relativeSegments) {
    return undefined;
  }
  const expectedPath = joinPathForRoot(params.bundledSkillsDir, ...relativeSegments);
  return params.pathExists(expectedPath) ? expectedPath : undefined;
}

export function scanSessionStoreForStaleRuntimeSnapshotPaths(params: {
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
  let agentEntries: fs.Dirent[] = [];
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
  return isRecord(parsed) ? (parsed as Record<string, SessionEntry>) : {};
}

export async function noteSessionSnapshotHealth(params?: {
  storePaths?: string[];
  bundledSkillsDir?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) {
  const bundledSkillsDir = params?.bundledSkillsDir ?? resolveBundledSkillsDir();
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
