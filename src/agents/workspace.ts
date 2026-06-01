import { createHash } from "node:crypto";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { resolveLegacyStateDirs, resolveStateDir } from "../config/paths.js";
import { openRootFile } from "../infra/boundary-file-read.js";
import { pathExists } from "../infra/fs-safe.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import {
  CANONICAL_ROOT_MEMORY_FILENAME,
  exactWorkspaceEntryExists,
} from "../memory/root-memory-files.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "./workspace-default.js";
import {
  resolveWorkspaceTemplateDir,
  resolveWorkspaceTemplateSearchDirs,
} from "./workspace-templates.js";
export {
  DEFAULT_AGENT_WORKSPACE_DIR,
  resolveDefaultAgentWorkspaceDir,
} from "./workspace-default.js";
export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = CANONICAL_ROOT_MEMORY_FILENAME;
const WORKSPACE_STATE_DIRNAME = ".openclaw";
const WORKSPACE_STATE_FILENAME = "workspace-state.json";
const WORKSPACE_STATE_VERSION = 1;
const WORKSPACE_ATTESTATION_SUFFIX = ".attested";
const WORKSPACE_ATTESTATION_DIRNAME = "workspace-attestations";
const WORKSPACE_ATTESTATION_RECENT_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_ATTESTATION_HEADER = "openclaw-workspace-attestation:v1";
const WORKSPACE_ATTESTATION_MAX_BYTES = 2048;
const WORKSPACE_ONBOARDING_PROFILE_FILENAMES = [
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
] as const;

const workspaceTemplateCache = new Map<string, Promise<string>>();
let gitAvailabilityPromise: Promise<boolean> | null = null;
const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;

// File content cache keyed by stable file identity to avoid stale reads.
const workspaceFileCache = new Map<string, { content: string; identity: string }>();

/**
 * Read workspace files via boundary-safe open and cache by inode/dev/size/mtime identity.
 */
type WorkspaceGuardedReadResult =
  | { ok: true; content: string }
  | { ok: false; reason: "path" | "validation" | "io"; error?: unknown };

function workspaceFileIdentity(stat: syncFs.Stats, canonicalPath: string): string {
  return `${canonicalPath}|${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

async function readWorkspaceFileWithGuards(params: {
  filePath: string;
  workspaceDir: string;
}): Promise<WorkspaceGuardedReadResult> {
  const opened = await openRootFile({
    absolutePath: params.filePath,
    rootPath: params.workspaceDir,
    boundaryLabel: "workspace root",
    maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  });
  if (!opened.ok) {
    workspaceFileCache.delete(params.filePath);
    return opened;
  }

  const identity = workspaceFileIdentity(opened.stat, opened.path);
  const cached = workspaceFileCache.get(params.filePath);
  if (cached && cached.identity === identity) {
    syncFs.closeSync(opened.fd);
    return { ok: true, content: cached.content };
  }

  try {
    const content = syncFs.readFileSync(opened.fd, "utf-8");
    workspaceFileCache.set(params.filePath, { content, identity });
    return { ok: true, content };
  } catch (error) {
    workspaceFileCache.delete(params.filePath);
    return { ok: false, reason: "io", error };
  } finally {
    syncFs.closeSync(opened.fd);
  }
}

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {
    return content;
  }
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {
    return content;
  }
  const start = endIndex + "\n---".length;
  let trimmed = content.slice(start);
  trimmed = trimmed.replace(/^\s+/, "");
  return trimmed;
}

async function loadTemplate(name: string): Promise<string> {
  const cached = workspaceTemplateCache.get(name);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const templateDirs =
      name === DEFAULT_HEARTBEAT_FILENAME
        ? [await resolveWorkspaceTemplateDir()]
        : await resolveWorkspaceTemplateSearchDirs();
    const triedPaths: string[] = [];
    for (const templateDir of templateDirs) {
      const templatePath = path.join(templateDir, name);
      triedPaths.push(templatePath);
      try {
        const content = await fs.readFile(templatePath, "utf-8");
        return stripFrontMatter(content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    throw new Error(
      `Missing workspace template: ${name} (${triedPaths.join(", ")}). Ensure workspace templates are packaged.`,
    );
  })();

  workspaceTemplateCache.set(name, pending);
  try {
    return await pending;
  } catch (error) {
    workspaceTemplateCache.delete(name);
    throw error;
  }
}

export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_HEARTBEAT_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME
  | typeof DEFAULT_MEMORY_FILENAME;

export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

export type ExtraBootstrapLoadDiagnosticCode =
  | "invalid-bootstrap-filename"
  | "missing"
  | "security"
  | "io";

export type ExtraBootstrapLoadDiagnostic = {
  path: string;
  reason: ExtraBootstrapLoadDiagnosticCode;
  detail: string;
};

type WorkspaceSetupState = {
  version: typeof WORKSPACE_STATE_VERSION;
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
};
type WorkspaceAttestationMarkerStatus = "marker" | "not-marker" | "missing" | "unknown";

/** Set of recognized bootstrap filenames for runtime validation */
const VALID_BOOTSTRAP_NAMES: ReadonlySet<string> = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
]);

const OPTIONAL_BOOTSTRAP_FILENAMES: ReadonlySet<string> = new Set([
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
]);

export const WORKSPACE_VANISHED_ERROR_CODE = "WORKSPACE_VANISHED";

export class WorkspaceVanishedError extends Error {
  readonly code = WORKSPACE_VANISHED_ERROR_CODE;
  readonly workspaceDir: string;
  readonly attestationPath: string;

  constructor(params: { workspaceDir: string; attestationPath: string }) {
    super(
      `OpenClaw workspace appears to have disappeared after a recent initialization: ${params.workspaceDir}. ` +
        `Refusing to reseed BOOTSTRAP.md over a recently attested workspace. ` +
        `Restore the workspace or remove ${params.attestationPath} if this reset was intentional.`,
    );
    this.name = "WorkspaceVanishedError";
    this.workspaceDir = params.workspaceDir;
    this.attestationPath = params.attestationPath;
  }
}

async function writeFileIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, {
      encoding: "utf-8",
      flag: "wx",
    });
    return true;
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "EEXIST") {
      throw err;
    }
    return false;
  }
}

async function fileContentDiffersFromTemplate(
  filePath: string,
  template: string,
): Promise<boolean> {
  try {
    return (await fs.readFile(filePath, "utf-8")) !== template;
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "ENOENT") {
      throw err;
    }
    return false;
  }
}

async function hasWorkspaceUserContentEvidence(
  dir: string,
  opts?: { includeGit?: boolean },
): Promise<boolean> {
  const indicators = [path.join(dir, "memory")];
  if (opts?.includeGit) {
    indicators.push(path.join(dir, ".git"));
  }
  for (const indicator of indicators) {
    try {
      await fs.access(indicator);
      return true;
    } catch {
      // continue
    }
  }
  if (await exactWorkspaceEntryExists(dir, DEFAULT_MEMORY_FILENAME)) {
    return true;
  }
  return await hasWorkspaceSkillEvidence(dir);
}

async function hasWorkspaceSkillEvidence(dir: string): Promise<boolean> {
  try {
    const skillEntries = await fs.readdir(path.join(dir, "skills"), { withFileTypes: true });
    for (const entry of skillEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        await fs.access(path.join(dir, "skills", entry.name, "SKILL.md"));
        return true;
      } catch {
        // continue
      }
    }
  } catch {
    // no workspace skills
  }
  return false;
}

async function hasSkipBootstrapWorkspaceContentEvidence(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store" || entry.name === WORKSPACE_STATE_DIRNAME) {
        continue;
      }
      if (entry.name === "skills" && entry.isDirectory()) {
        if (!(await hasWorkspaceSkillEvidence(dir))) {
          continue;
        }
      }
      return true;
    }
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "ENOENT") {
      throw err;
    }
  }
  return false;
}

async function workspaceProfileLooksConfigured(params: {
  dir: string;
  includeGitEvidence?: boolean;
}): Promise<boolean> {
  const profileFileDiffs = await Promise.all(
    WORKSPACE_ONBOARDING_PROFILE_FILENAMES.map(async (fileName) =>
      fileContentDiffersFromTemplate(path.join(params.dir, fileName), await loadTemplate(fileName)),
    ),
  );
  return (
    profileFileDiffs.some(Boolean) ||
    (await hasWorkspaceUserContentEvidence(params.dir, {
      includeGit: params.includeGitEvidence,
    }))
  );
}

async function workspaceRequiredBootstrapLooksCustomized(
  dir: string,
  opts?: { attestationPath?: string },
): Promise<boolean> {
  const fileNames = [DEFAULT_AGENTS_FILENAME, DEFAULT_TOOLS_FILENAME, DEFAULT_HEARTBEAT_FILENAME];
  const generatedHashes = opts?.attestationPath
    ? await readWorkspaceAttestationGeneratedHashes(opts.attestationPath)
    : undefined;
  if (generatedHashes) {
    for (const fileName of fileNames) {
      const filePath = path.join(dir, fileName);
      const generatedHash = generatedHashes.get(fileName);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const contentHash = createHash("sha256").update(content).digest("hex");
        if (!generatedHash || contentHash !== generatedHash) {
          return true;
        }
      } catch {
        // Missing generated files are not customization evidence.
      }
    }
    return false;
  }
  const fileDiffs = await Promise.all(
    fileNames.map(async (fileName) =>
      fileContentDiffersFromTemplate(path.join(dir, fileName), await loadTemplate(fileName)),
    ),
  );
  return fileDiffs.some(Boolean);
}

async function workspaceAttestedGeneratedFilesIntact(
  dir: string,
  attestationPath: string,
): Promise<boolean> {
  const generatedHashes = await readWorkspaceAttestationGeneratedHashes(attestationPath);
  if (!generatedHashes) {
    return false;
  }
  for (const [fileName, generatedHash] of generatedHashes) {
    try {
      const content = await fs.readFile(path.join(dir, fileName), "utf-8");
      const contentHash = createHash("sha256").update(content).digest("hex");
      if (contentHash !== generatedHash) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function workspaceHasBootstrapCompletionEvidence(params: { dir: string }): Promise<boolean> {
  return await workspaceProfileLooksConfigured(params);
}

type WorkspaceBootstrapCompletionReconcileResult = {
  repaired: boolean;
  bootstrapExists: boolean;
  state: WorkspaceSetupState;
};

async function reconcileWorkspaceBootstrapCompletionState(params: {
  dir: string;
  bootstrapPath: string;
  statePath: string;
  state: WorkspaceSetupState;
  bootstrapExists?: boolean;
}): Promise<WorkspaceBootstrapCompletionReconcileResult> {
  const bootstrapExists = params.bootstrapExists ?? (await pathExists(params.bootstrapPath));
  if (
    typeof params.state.setupCompletedAt === "string" &&
    params.state.setupCompletedAt.trim().length > 0
  ) {
    return { repaired: false, bootstrapExists, state: params.state };
  }

  if (params.state.bootstrapSeededAt && !bootstrapExists) {
    const completedState: WorkspaceSetupState = {
      ...params.state,
      setupCompletedAt: new Date().toISOString(),
    };
    await writeWorkspaceSetupState(params.statePath, completedState);
    return { repaired: true, bootstrapExists: false, state: completedState };
  }

  if (
    !bootstrapExists ||
    !(await workspaceHasBootstrapCompletionEvidence({
      dir: params.dir,
    }))
  ) {
    return { repaired: false, bootstrapExists, state: params.state };
  }

  const now = new Date().toISOString();
  const repairedState: WorkspaceSetupState = {
    ...params.state,
    bootstrapSeededAt: params.state.bootstrapSeededAt ?? now,
    setupCompletedAt: now,
  };
  await writeWorkspaceSetupState(params.statePath, repairedState);
  try {
    await fs.rm(params.bootstrapPath, { force: true });
    return { repaired: true, bootstrapExists: false, state: repairedState };
  } catch {
    // Completion state is authoritative; stale BOOTSTRAP cleanup is best-effort.
    return { repaired: true, bootstrapExists: true, state: repairedState };
  }
}

function resolveWorkspaceStatePath(dir: string): string {
  return path.join(dir, WORKSPACE_STATE_DIRNAME, WORKSPACE_STATE_FILENAME);
}

export function resolveWorkspaceAttestationPath(dir: string): string {
  return resolveWorkspaceAttestationPathInStateDir(dir, resolveStateDir());
}

function resolveWorkspaceAttestationPathInStateDir(dir: string, stateDir: string): string {
  const key = createHash("sha256").update(path.resolve(dir)).digest("hex");
  return path.join(stateDir, WORKSPACE_ATTESTATION_DIRNAME, `${key}.attested`);
}

function resolveLegacyWorkspaceAttestationPath(dir: string): string {
  return `${dir}${WORKSPACE_ATTESTATION_SUFFIX}`;
}

export function resolveWorkspaceAttestationPaths(dir: string): string[] {
  const stateAttestationPaths = [resolveStateDir(), ...resolveLegacyStateDirs()].map((stateDir) =>
    resolveWorkspaceAttestationPathInStateDir(dir, stateDir),
  );
  const legacy = resolveLegacyWorkspaceAttestationPath(dir);
  return [...new Set([...stateAttestationPaths, legacy])];
}

async function findRecentWorkspaceAttestationPath(
  attestationPaths: string[],
): Promise<string | null> {
  for (const [index, attestationPath] of attestationPaths.entries()) {
    if (await hasRecentWorkspaceAttestation(attestationPath, { trustUnknown: index === 0 })) {
      return attestationPath;
    }
  }
  return null;
}

export async function hasRecentWorkspaceAttestation(
  attestationPath: string,
  opts?: { trustUnknown?: boolean },
): Promise<boolean> {
  try {
    const stat = await fs.lstat(attestationPath);
    if (
      !stat.isFile() ||
      stat.size > WORKSPACE_ATTESTATION_MAX_BYTES ||
      Date.now() - stat.mtimeMs > WORKSPACE_ATTESTATION_RECENT_MS
    ) {
      return false;
    }
    const status = await readWorkspaceAttestationMarkerStatus(attestationPath);
    return status === "marker" || (opts?.trustUnknown === true && status === "unknown");
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "ENOENT") {
      return opts?.trustUnknown === true;
    }
    return false;
  }
}

export async function isWorkspaceAttestationMarker(attestationPath: string): Promise<boolean> {
  return (await readWorkspaceAttestationMarkerStatus(attestationPath)) === "marker";
}

export async function shouldRemoveWorkspaceAttestation(
  attestationPath: string,
  opts?: { trustUnknown?: boolean },
): Promise<boolean> {
  try {
    return (
      (await isWorkspaceAttestationMarker(attestationPath)) ||
      (await hasRecentWorkspaceAttestation(attestationPath, opts))
    );
  } catch {
    return false;
  }
}

async function readWorkspaceAttestationMarkerStatus(
  attestationPath: string,
): Promise<WorkspaceAttestationMarkerStatus> {
  try {
    const stat = await fs.lstat(attestationPath);
    if (!stat.isFile() || stat.size > WORKSPACE_ATTESTATION_MAX_BYTES) {
      return "not-marker";
    }
    const raw = await fs.readFile(attestationPath, "utf-8");
    if (raw.startsWith(`${WORKSPACE_ATTESTATION_HEADER}\n`)) {
      return "marker";
    }
    return "not-marker";
  } catch (err) {
    const anyErr = err as { code?: string };
    return anyErr.code === "ENOENT" ? "missing" : "unknown";
  }
}

async function readWorkspaceAttestationGeneratedHashes(
  attestationPath: string,
): Promise<Map<string, string> | undefined> {
  try {
    const stat = await fs.lstat(attestationPath);
    if (!stat.isFile() || stat.size > WORKSPACE_ATTESTATION_MAX_BYTES) {
      return undefined;
    }
    const raw = await fs.readFile(attestationPath, "utf-8");
    if (!raw.startsWith(`${WORKSPACE_ATTESTATION_HEADER}\n`)) {
      return undefined;
    }
    const hashes = new Map<string, string>();
    for (const line of raw.split(/\r?\n/)) {
      const match = /^generated:([^:]+):([a-f0-9]{64})$/.exec(line);
      if (match?.[1] && match[2]) {
        hashes.set(match[1], match[2]);
      }
    }
    return hashes.size > 0 ? hashes : undefined;
  } catch {
    return undefined;
  }
}

async function collectGeneratedBootstrapHashes(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const fileNames = [
    DEFAULT_AGENTS_FILENAME,
    DEFAULT_SOUL_FILENAME,
    DEFAULT_TOOLS_FILENAME,
    DEFAULT_IDENTITY_FILENAME,
    DEFAULT_USER_FILENAME,
    DEFAULT_HEARTBEAT_FILENAME,
  ];
  for (const fileName of fileNames) {
    try {
      const content = await fs.readFile(path.join(dir, fileName), "utf-8");
      if (content === (await loadTemplate(fileName))) {
        hashes.set(fileName, createHash("sha256").update(content).digest("hex"));
      }
    } catch {
      // Missing or unreadable files are not attested as generated.
    }
  }
  return hashes;
}

async function buildWorkspaceAttestationContent(dir: string, now: Date): Promise<string> {
  const hashes = await collectGeneratedBootstrapHashes(dir);
  const lines = [WORKSPACE_ATTESTATION_HEADER, now.toISOString()];
  for (const [fileName, hash] of [...hashes.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    lines.push(`generated:${fileName}:${hash}`);
  }
  return `${lines.join("\n")}\n`;
}

async function writeWorkspaceAttestation(attestationPath: string, dir: string): Promise<void> {
  await fs.mkdir(path.dirname(attestationPath), { recursive: true });
  const now = new Date();
  const content = await buildWorkspaceAttestationContent(dir, now);
  try {
    const status = await readWorkspaceAttestationMarkerStatus(attestationPath);
    if (status === "marker") {
      await fs.writeFile(attestationPath, content, "utf-8");
      await fs.utimes(attestationPath, now, now);
      return;
    }
    if (status !== "missing") {
      return;
    }
  } catch {
    return;
  }

  const noFollowFlag =
    typeof syncFs.constants.O_NOFOLLOW === "number" ? syncFs.constants.O_NOFOLLOW : 0;
  const handle = await fs.open(
    attestationPath,
    syncFs.constants.O_WRONLY | syncFs.constants.O_CREAT | syncFs.constants.O_EXCL | noFollowFlag,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf-8");
  } finally {
    await handle.close();
  }
}

async function maybeWriteWorkspaceAttestation(attestationPath: string, dir: string): Promise<void> {
  try {
    await writeWorkspaceAttestation(attestationPath, dir);
  } catch {
    // The marker is a lifecycle guard; setup should not fail solely because it
    // could not refresh auxiliary disappearance evidence.
  }
}

function parseWorkspaceSetupState(raw: string): WorkspaceSetupState | null {
  try {
    const parsed = JSON.parse(raw) as {
      bootstrapSeededAt?: unknown;
      setupCompletedAt?: unknown;
      onboardingCompletedAt?: unknown;
    };
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const legacyCompletedAt = readStringValue(parsed.onboardingCompletedAt);
    return {
      version: WORKSPACE_STATE_VERSION,
      bootstrapSeededAt: readStringValue(parsed.bootstrapSeededAt),
      setupCompletedAt: readStringValue(parsed.setupCompletedAt) ?? legacyCompletedAt,
    };
  } catch {
    return null;
  }
}

async function readWorkspaceSetupState(
  statePath: string,
  opts?: { persistLegacyMigration?: boolean },
): Promise<WorkspaceSetupState> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = parseWorkspaceSetupState(raw);
    if (
      opts?.persistLegacyMigration &&
      parsed &&
      raw.includes('"onboardingCompletedAt"') &&
      !raw.includes('"setupCompletedAt"') &&
      parsed.setupCompletedAt
    ) {
      await writeWorkspaceSetupState(statePath, parsed);
    }
    return parsed ?? { version: WORKSPACE_STATE_VERSION };
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code !== "ENOENT") {
      throw err;
    }
    return {
      version: WORKSPACE_STATE_VERSION,
    };
  }
}

async function readWorkspaceSetupStateForDir(dir: string): Promise<WorkspaceSetupState> {
  const statePath = resolveWorkspaceStatePath(resolveUserPath(dir));
  return await readWorkspaceSetupState(statePath);
}

export async function isWorkspaceSetupCompleted(dir: string): Promise<boolean> {
  const state = await readWorkspaceSetupStateForDir(dir);
  return typeof state.setupCompletedAt === "string" && state.setupCompletedAt.trim().length > 0;
}

export async function resolveWorkspaceBootstrapStatus(
  dir: string,
): Promise<"pending" | "complete"> {
  const resolvedDir = resolveUserPath(dir);
  const statePath = resolveWorkspaceStatePath(resolvedDir);
  const state = await readWorkspaceSetupState(statePath);
  if (typeof state.setupCompletedAt === "string" && state.setupCompletedAt.trim().length > 0) {
    return "complete";
  }
  const bootstrapPath = path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME);
  const bootstrapExists = await pathExists(bootstrapPath);
  if (!bootstrapExists) {
    return "complete";
  }
  return "pending";
}

export async function isWorkspaceBootstrapPending(dir: string): Promise<boolean> {
  return (await resolveWorkspaceBootstrapStatus(dir)) === "pending";
}

export async function reconcileWorkspaceBootstrapCompletion(
  dir: string,
): Promise<WorkspaceBootstrapCompletionReconcileResult> {
  const resolvedDir = resolveUserPath(dir);
  const statePath = resolveWorkspaceStatePath(resolvedDir);
  const bootstrapPath = path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME);
  const state = await readWorkspaceSetupState(statePath, {
    persistLegacyMigration: true,
  });
  return await reconcileWorkspaceBootstrapCompletionState({
    dir: resolvedDir,
    bootstrapPath,
    statePath,
    state,
  });
}

async function writeWorkspaceSetupState(
  statePath: string,
  state: WorkspaceSetupState,
): Promise<void> {
  await replaceFileAtomic({
    filePath: statePath,
    content: `${JSON.stringify(state, null, 2)}\n`,
    tempPrefix: ".workspace-state",
  });
}

async function hasGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isGitAvailable(): Promise<boolean> {
  if (gitAvailabilityPromise) {
    return gitAvailabilityPromise;
  }

  gitAvailabilityPromise = (async () => {
    try {
      const result = await runCommandWithTimeout(["git", "--version"], { timeoutMs: 2_000 });
      return result.code === 0;
    } catch {
      return false;
    }
  })();

  return gitAvailabilityPromise;
}

async function ensureGitRepo(dir: string, isBrandNewWorkspace: boolean) {
  if (!isBrandNewWorkspace) {
    return;
  }
  if (await hasGitRepo(dir)) {
    return;
  }
  if (!(await isGitAvailable())) {
    return;
  }
  try {
    await runCommandWithTimeout(["git", "init"], { cwd: dir, timeoutMs: 10_000 });
  } catch {
    // Ignore git init failures; workspace creation should still succeed.
  }
}

export async function ensureAgentWorkspace(params?: {
  dir?: string;
  ensureBootstrapFiles?: boolean;
  /**
   * List of optional bootstrap filenames to skip writing.
   * Applies only to SOUL.md, USER.md, HEARTBEAT.md, IDENTITY.md.
   * Required workspace setup such as AGENTS.md and TOOLS.md still runs.
   */
  skipOptionalBootstrapFiles?: string[];
}): Promise<{
  dir: string;
  agentsPath?: string;
  soulPath?: string;
  toolsPath?: string;
  identityPath?: string;
  userPath?: string;
  heartbeatPath?: string;
  bootstrapPath?: string;
  identityPathCreated?: boolean;
}> {
  const rawDir = params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);
  const [attestationPath, ...legacyAttestationPaths] = resolveWorkspaceAttestationPaths(dir);
  const attestationPaths = [attestationPath, ...legacyAttestationPaths];
  const recentAttestationPath = await findRecentWorkspaceAttestationPath(attestationPaths);

  if (!(await pathExists(dir)) && recentAttestationPath) {
    throw new WorkspaceVanishedError({
      workspaceDir: dir,
      attestationPath: recentAttestationPath,
    });
  }

  await fs.mkdir(dir, { recursive: true });

  if (!params?.ensureBootstrapFiles) {
    const hasContentEvidence = await hasSkipBootstrapWorkspaceContentEvidence(dir);
    if (recentAttestationPath && !hasContentEvidence) {
      throw new WorkspaceVanishedError({
        workspaceDir: dir,
        attestationPath: recentAttestationPath,
      });
    }
    if (hasContentEvidence) {
      await maybeWriteWorkspaceAttestation(attestationPath, dir);
    }
    return { dir };
  }

  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
  const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
  const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
  const userPath = path.join(dir, DEFAULT_USER_FILENAME);
  const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);
  const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
  const statePath = resolveWorkspaceStatePath(dir);

  const isBrandNewWorkspace = await (async () => {
    const templatePaths = [agentsPath, soulPath, toolsPath, identityPath, userPath, heartbeatPath];
    const paths = [...templatePaths, path.join(dir, "memory")];
    const existing = await Promise.all(
      paths.map(async (p) => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }),
    );
    return existing.every((v) => !v) && !(await hasWorkspaceUserContentEvidence(dir));
  })();

  if (isBrandNewWorkspace) {
    if (recentAttestationPath) {
      throw new WorkspaceVanishedError({
        workspaceDir: dir,
        attestationPath: recentAttestationPath,
      });
    }
  }

  if (recentAttestationPath && !isBrandNewWorkspace) {
    const bootstrapExists = await pathExists(bootstrapPath);
    const state = await readWorkspaceSetupState(statePath, {
      persistLegacyMigration: true,
    });
    const hasSetupState = Boolean(state.bootstrapSeededAt || state.setupCompletedAt);
    const hasCustomizedRequiredBootstrap = await workspaceRequiredBootstrapLooksCustomized(dir, {
      attestationPath: recentAttestationPath,
    });
    const hasConfiguredProfile = await workspaceProfileLooksConfigured({
      dir,
    });
    const hasWorkspaceEvidence =
      bootstrapExists ||
      hasCustomizedRequiredBootstrap ||
      hasConfiguredProfile ||
      (hasSetupState && (await workspaceAttestedGeneratedFilesIntact(dir, recentAttestationPath)));
    if (!hasWorkspaceEvidence) {
      throw new WorkspaceVanishedError({
        workspaceDir: dir,
        attestationPath: recentAttestationPath,
      });
    }
  }

  const agentsTemplate = await loadTemplate(DEFAULT_AGENTS_FILENAME);
  const soulTemplate = await loadTemplate(DEFAULT_SOUL_FILENAME);
  const toolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
  const identityTemplate = await loadTemplate(DEFAULT_IDENTITY_FILENAME);
  const userTemplate = await loadTemplate(DEFAULT_USER_FILENAME);
  const heartbeatTemplate = await loadTemplate(DEFAULT_HEARTBEAT_FILENAME);
  const skipOptionalBootstrapFiles = new Set(params?.skipOptionalBootstrapFiles ?? []);
  const shouldWriteBootstrapFile = (fileName: string): boolean =>
    !OPTIONAL_BOOTSTRAP_FILENAMES.has(fileName) || !skipOptionalBootstrapFiles.has(fileName);

  await writeFileIfMissing(agentsPath, agentsTemplate);
  if (shouldWriteBootstrapFile(DEFAULT_SOUL_FILENAME)) {
    await writeFileIfMissing(soulPath, soulTemplate);
  }
  await writeFileIfMissing(toolsPath, toolsTemplate);
  const identityPathCreated = shouldWriteBootstrapFile(DEFAULT_IDENTITY_FILENAME)
    ? await writeFileIfMissing(identityPath, identityTemplate)
    : false;
  if (shouldWriteBootstrapFile(DEFAULT_USER_FILENAME)) {
    await writeFileIfMissing(userPath, userTemplate);
  }
  if (shouldWriteBootstrapFile(DEFAULT_HEARTBEAT_FILENAME)) {
    await writeFileIfMissing(heartbeatPath, heartbeatTemplate);
  }

  let state = await readWorkspaceSetupState(statePath, {
    persistLegacyMigration: true,
  });
  let stateDirty = false;
  const markState = (next: Partial<WorkspaceSetupState>) => {
    state = { ...state, ...next };
    stateDirty = true;
  };
  const nowIso = () => new Date().toISOString();

  let bootstrapExists = await pathExists(bootstrapPath);
  if (!state.bootstrapSeededAt && bootstrapExists) {
    markState({ bootstrapSeededAt: nowIso() });
  }

  if (!state.setupCompletedAt) {
    const repair = await reconcileWorkspaceBootstrapCompletionState({
      dir,
      bootstrapPath,
      statePath,
      state,
      bootstrapExists,
    });
    if (repair.repaired) {
      state = repair.state;
      stateDirty = false;
      bootstrapExists = repair.bootstrapExists;
    }
  }

  if (!state.bootstrapSeededAt && !state.setupCompletedAt && !bootstrapExists) {
    // Legacy migration path: if USER/IDENTITY diverged from templates, or if user-content
    // indicators exist, treat setup as complete and avoid recreating BOOTSTRAP for
    // already-configured workspaces.
    const hasRecentAttestedCustomization = recentAttestationPath
      ? await workspaceRequiredBootstrapLooksCustomized(dir, {
          attestationPath: recentAttestationPath,
        })
      : false;
    if (
      hasRecentAttestedCustomization ||
      (await workspaceProfileLooksConfigured({
        dir,
        includeGitEvidence: true,
      }))
    ) {
      markState({ setupCompletedAt: nowIso() });
    } else {
      const bootstrapTemplate = await loadTemplate(DEFAULT_BOOTSTRAP_FILENAME);
      const wroteBootstrap = await writeFileIfMissing(bootstrapPath, bootstrapTemplate);
      if (!wroteBootstrap) {
        bootstrapExists = await pathExists(bootstrapPath);
      } else {
        bootstrapExists = true;
      }
      if (bootstrapExists && !state.bootstrapSeededAt) {
        markState({ bootstrapSeededAt: nowIso() });
      }
    }
  }

  if (stateDirty) {
    await writeWorkspaceSetupState(statePath, state);
  }
  await ensureGitRepo(dir, isBrandNewWorkspace);
  await maybeWriteWorkspaceAttestation(attestationPath, dir);

  return {
    dir,
    agentsPath,
    soulPath,
    toolsPath,
    identityPath,
    userPath,
    heartbeatPath,
    bootstrapPath,
    identityPathCreated,
  };
}

export async function loadWorkspaceBootstrapFiles(dir: string): Promise<WorkspaceBootstrapFile[]> {
  const resolvedDir = resolveUserPath(dir);

  const entries: Array<{
    name: WorkspaceBootstrapFileName;
    filePath: string;
  }> = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
    },
    {
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME),
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
    {
      name: DEFAULT_MEMORY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_MEMORY_FILENAME),
    },
  ];

  const result: WorkspaceBootstrapFile[] = [];
  for (const entry of entries) {
    if (
      entry.name === DEFAULT_MEMORY_FILENAME &&
      !(await exactWorkspaceEntryExists(resolvedDir, DEFAULT_MEMORY_FILENAME))
    ) {
      continue;
    }
    const loaded = await readWorkspaceFileWithGuards({
      filePath: entry.filePath,
      workspaceDir: resolvedDir,
    });
    if (loaded.ok) {
      result.push({
        name: entry.name,
        path: entry.filePath,
        content: loaded.content,
        missing: false,
      });
    } else {
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }
  return result;
}

const SUBAGENT_BOOTSTRAP_ALLOWLIST = new Set([DEFAULT_AGENTS_FILENAME, DEFAULT_TOOLS_FILENAME]);

const CRON_BOOTSTRAP_ALLOWLIST = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
]);

export function filterBootstrapFilesForSession(
  files: WorkspaceBootstrapFile[],
  sessionKey?: string,
): WorkspaceBootstrapFile[] {
  if (!sessionKey) {
    return files;
  }
  if (isSubagentSessionKey(sessionKey)) {
    return files.filter((file) => SUBAGENT_BOOTSTRAP_ALLOWLIST.has(file.name));
  }
  if (isCronSessionKey(sessionKey)) {
    return files.filter((file) => CRON_BOOTSTRAP_ALLOWLIST.has(file.name));
  }
  return files;
}

function hasGlobPattern(pattern: string): boolean {
  // Keep square brackets literal here; workspace paths commonly contain them.
  return /[?*{}]/u.test(pattern);
}

function normalizeWorkspacePatternPath(value: string): string {
  return value
    .replaceAll(path.sep, "/")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

function resolveGlobWalkRoot(pattern: string): string {
  const normalized = normalizeWorkspacePatternPath(pattern);
  const globIndex = normalized.search(/[?*{}]/u);
  if (globIndex === -1) {
    return normalized;
  }
  const slashIndex = normalized.lastIndexOf("/", globIndex);
  return slashIndex === -1 ? "." : normalized.slice(0, slashIndex) || ".";
}

async function* walkWorkspaceFiles(
  workspaceDir: string,
  initialRelativeDir: string,
): AsyncGenerator<string> {
  const stack = [initialRelativeDir === "." ? "" : initialRelativeDir];
  while (stack.length > 0) {
    const currentRelativeDir = stack.pop() ?? "";
    const currentDir = path.resolve(workspaceDir, currentRelativeDir);
    const relativeToWorkspace = path.relative(workspaceDir, currentDir);
    if (relativeToWorkspace.startsWith("..") || path.isAbsolute(relativeToWorkspace)) {
      continue;
    }

    let entries: syncFs.Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const childRelativePath = currentRelativeDir
        ? path.join(currentRelativeDir, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        stack.push(childRelativePath);
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        yield normalizeWorkspacePatternPath(childRelativePath);
      }
    }
  }
}

async function resolveExtraBootstrapPatternPaths(
  workspaceDir: string,
  pattern: string,
): Promise<string[]> {
  if (typeof fs.glob === "function") {
    try {
      const matches: string[] = [];
      for await (const match of fs.glob(pattern, { cwd: workspaceDir })) {
        matches.push(match);
      }
      return matches;
    } catch {
      // Fall through to the local matcher before treating the pattern as literal.
    }
  }

  if (typeof path.matchesGlob !== "function") {
    return [pattern];
  }

  const normalizedPattern = normalizeWorkspacePatternPath(pattern);
  const matches: string[] = [];
  for await (const candidate of walkWorkspaceFiles(
    workspaceDir,
    resolveGlobWalkRoot(normalizedPattern),
  )) {
    if (path.matchesGlob(candidate, normalizedPattern)) {
      matches.push(candidate);
    }
  }
  return matches.length > 0 ? matches : [pattern];
}

export async function loadExtraBootstrapFiles(
  dir: string,
  extraPatterns: string[],
): Promise<WorkspaceBootstrapFile[]> {
  const loaded = await loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns);
  return loaded.files;
}

export async function loadExtraBootstrapFilesWithDiagnostics(
  dir: string,
  extraPatterns: string[],
): Promise<{
  files: WorkspaceBootstrapFile[];
  diagnostics: ExtraBootstrapLoadDiagnostic[];
}> {
  if (!extraPatterns.length) {
    return { files: [], diagnostics: [] };
  }
  const resolvedDir = resolveUserPath(dir);

  // Resolve glob patterns into concrete file paths
  const resolvedPaths = new Set<string>();
  for (const pattern of extraPatterns) {
    if (hasGlobPattern(pattern)) {
      const matches = await resolveExtraBootstrapPatternPaths(resolvedDir, pattern);
      for (const match of matches) {
        resolvedPaths.add(match);
      }
    } else {
      resolvedPaths.add(pattern);
    }
  }

  const files: WorkspaceBootstrapFile[] = [];
  const diagnostics: ExtraBootstrapLoadDiagnostic[] = [];
  for (const relPath of resolvedPaths) {
    const filePath = path.resolve(resolvedDir, relPath);
    // Only load files whose basename is a recognized bootstrap filename
    const baseName = path.basename(relPath);
    if (!VALID_BOOTSTRAP_NAMES.has(baseName)) {
      diagnostics.push({
        path: filePath,
        reason: "invalid-bootstrap-filename",
        detail: `unsupported bootstrap basename: ${baseName}`,
      });
      continue;
    }
    const loaded = await readWorkspaceFileWithGuards({
      filePath,
      workspaceDir: resolvedDir,
    });
    if (loaded.ok) {
      files.push({
        name: baseName as WorkspaceBootstrapFileName,
        path: filePath,
        content: loaded.content,
        missing: false,
      });
      continue;
    }

    const reason: ExtraBootstrapLoadDiagnosticCode =
      loaded.reason === "path" ? "missing" : loaded.reason === "validation" ? "security" : "io";
    diagnostics.push({
      path: filePath,
      reason,
      detail:
        loaded.error instanceof Error
          ? loaded.error.message
          : typeof loaded.error === "string"
            ? loaded.error
            : reason,
    });
  }
  return { files, diagnostics };
}
