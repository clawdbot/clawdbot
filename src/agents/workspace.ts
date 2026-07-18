/**
 * Workspace bootstrap, template, state, and attestation helpers. This module
 * creates and reads AGENTS/SOUL/TOOLS-style bootstrap files while guarding
 * filesystem boundaries and recently-attested workspaces.
 */
import { createHash } from "node:crypto";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { extractFrontmatterBlock } from "../../packages/markdown-core/src/frontmatter.js";
import { openRootFile } from "../infra/boundary-file-read.js";
import { pathExists } from "../infra/fs-safe.js";
import { retryAsync } from "../infra/retry.js";
import {
  CANONICAL_ROOT_MEMORY_FILENAME,
  exactWorkspaceEntryExists,
} from "../memory/root-memory-files.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { isCronSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { resolveUserPath } from "../utils.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "./workspace-default.js";
import {
  assertNoUnmigratedWorkspaceState,
  LEGACY_WORKSPACE_STATE_CURRENT_FILENAME,
  LEGACY_WORKSPACE_STATE_DIRNAME,
} from "./workspace-legacy-state.js";
import {
  clearExpiredWorkspaceStateForVanishedWorkspace,
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
  WORKSPACE_ATTESTATION_RECENT_MS,
  type WorkspaceAttestation,
  type WorkspaceStateSnapshot,
  type WorkspaceSetupState,
} from "./workspace-state-store.js";
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
const WORKSPACE_ONBOARDING_PROFILE_FILENAMES = [
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
] as const;
const TRANSIENT_WORKSPACE_READ_CODES = new Set(["EAGAIN", "EWOULDBLOCK", "EINTR"]);
const TRANSIENT_WORKSPACE_READ_ERRNOS = new Set([-11, -4]);
const TRANSIENT_WORKSPACE_READ_MESSAGE = /Unknown system error -(?:11|4)\b/i;

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
  try {
    // A transient FS race (EAGAIN/EWOULDBLOCK/EINTR under load) on the open or
    // read must not drop the agent's bootstrap file for the turn — this reader
    // runs every turn for AGENTS/SOUL/HEARTBEAT/etc. Retry the whole open+read so
    // each attempt uses a fresh fd (retrying readFileSync on the same fd could
    // return truncated content after a partial read); the inode-identity guard
    // in openRootFile still protects against a swapped file between attempts.
    return await retryAsync(
      async () => {
        const opened = await openRootFile({
          absolutePath: params.filePath,
          rootPath: params.workspaceDir,
          boundaryLabel: "workspace root",
          maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
        });
        if (!opened.ok) {
          // Boundary resolution can report transient IO as "validation", while
          // pinned open failures use "io". Classify the underlying error so
          // deterministic path and validation failures still return unchanged.
          if (isTransientWorkspaceReadError(opened.error)) {
            throw opened.error;
          }
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
        } finally {
          syncFs.closeSync(opened.fd);
        }
      },
      {
        attempts: 3,
        minDelayMs: 50,
        maxDelayMs: 50,
        shouldRetry: (err) => isTransientWorkspaceReadError(err),
      },
    );
  } catch (error) {
    // Non-transient read failure, or transient retries exhausted.
    workspaceFileCache.delete(params.filePath);
    return { ok: false, reason: "io", error };
  }
}

function stripFrontMatter(content: string): string {
  return extractFrontmatterBlock(content)?.body.replace(/^\s+/, "") ?? content;
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

  constructor(params: { workspaceDir: string }) {
    super(
      `OpenClaw workspace appears to have disappeared after a recent initialization: ${params.workspaceDir}. ` +
        `Refusing to reseed BOOTSTRAP.md over a recently attested workspace. ` +
        "Restore the workspace or run a full OpenClaw reset if this reset was intentional.",
    );
    this.name = "WorkspaceVanishedError";
    this.workspaceDir = params.workspaceDir;
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

function isTransientWorkspaceReadError(error: unknown): boolean {
  const fsError = error as NodeJS.ErrnoException | undefined;
  if (fsError?.code && TRANSIENT_WORKSPACE_READ_CODES.has(fsError.code)) {
    return true;
  }
  if (typeof fsError?.errno === "number" && TRANSIENT_WORKSPACE_READ_ERRNOS.has(fsError.errno)) {
    return true;
  }
  return error instanceof Error && TRANSIENT_WORKSPACE_READ_MESSAGE.test(error.message);
}

async function fileContentDiffersFromTemplate(
  filePath: string,
  template: string,
): Promise<boolean> {
  try {
    return await retryAsync(async () => (await fs.readFile(filePath, "utf-8")) !== template, {
      attempts: 3,
      minDelayMs: 50,
      maxDelayMs: 50,
      shouldRetry: (err) => isTransientWorkspaceReadError(err),
    });
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code === "ENOENT") {
      return false;
    }
    throw err;
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
      if (
        entry.name === ".DS_Store" ||
        entry.name === LEGACY_WORKSPACE_STATE_DIRNAME ||
        entry.name === LEGACY_WORKSPACE_STATE_CURRENT_FILENAME
      ) {
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
  opts?: { generatedHashes?: ReadonlyMap<string, string> },
): Promise<boolean> {
  const fileNames = [DEFAULT_AGENTS_FILENAME, DEFAULT_TOOLS_FILENAME, DEFAULT_HEARTBEAT_FILENAME];
  const generatedHashes = opts?.generatedHashes;
  if (generatedHashes && generatedHashes.size > 0) {
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
  generatedHashes: ReadonlyMap<string, string>,
): Promise<boolean> {
  if (
    !generatedHashes.has(DEFAULT_AGENTS_FILENAME) ||
    !generatedHashes.has(DEFAULT_TOOLS_FILENAME)
  ) {
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
    const persistedState = mergeWorkspaceSetupState(params.dir, completedState);
    return { repaired: true, bootstrapExists: false, state: persistedState };
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
  const persistedState = mergeWorkspaceSetupState(params.dir, repairedState);
  try {
    await fs.rm(params.bootstrapPath, { force: true });
    return { repaired: true, bootstrapExists: false, state: persistedState };
  } catch {
    // Completion state is authoritative; stale BOOTSTRAP cleanup is best-effort.
    return { repaired: true, bootstrapExists: true, state: persistedState };
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

function recentWorkspaceAttestation(
  attestation: WorkspaceAttestation | undefined,
  nowMs = Date.now(),
): WorkspaceAttestation | undefined {
  if (!attestation) {
    return undefined;
  }
  const ageMs = nowMs - attestation.attestedAtMs;
  // Clock rollback must not turn disappearance protection into permission to
  // reseed. A healthy workspace refreshes the future-dated row below.
  if (ageMs > WORKSPACE_ATTESTATION_RECENT_MS) {
    return undefined;
  }
  return attestation;
}

async function maybeWriteWorkspaceAttestation(dir: string): Promise<void> {
  try {
    // Order snapshots by when their filesystem observation starts. The store
    // compares against a separate lock-time clock, so a newer committed scan
    // wins when this async collection finishes later.
    const attestedAtMs = Date.now();
    const generatedHashes = await collectGeneratedBootstrapHashes(dir);
    replaceWorkspaceAttestation({
      workspaceDir: dir,
      attestedAtMs,
      generatedHashes,
    });
  } catch {
    // Attestation is a lifecycle guard; setup should not fail solely because
    // the auxiliary disappearance evidence could not be refreshed.
  }
}

function hasWorkspaceSetupStateMarker(state: WorkspaceSetupState): boolean {
  return Boolean(state.bootstrapSeededAt || state.setupCompletedAt);
}

function hasRecentWorkspaceSetupState(
  snapshot: WorkspaceStateSnapshot,
  nowMs = Date.now(),
): boolean {
  if (!hasWorkspaceSetupStateMarker(snapshot.setup) || snapshot.setupUpdatedAtMs === undefined) {
    return false;
  }
  return nowMs - snapshot.setupUpdatedAtMs <= WORKSPACE_ATTESTATION_RECENT_MS;
}

async function workspaceAttestationHasSurvivalEvidence(params: {
  dir: string;
  bootstrapPath: string;
  state: WorkspaceSetupState;
  attestation: WorkspaceAttestation;
}): Promise<boolean> {
  if (await pathExists(params.bootstrapPath)) {
    return true;
  }
  if (
    await workspaceRequiredBootstrapLooksCustomized(params.dir, {
      generatedHashes: params.attestation.generatedHashes,
    })
  ) {
    return true;
  }
  if (await workspaceProfileLooksConfigured({ dir: params.dir })) {
    return true;
  }
  return (
    hasWorkspaceSetupStateMarker(params.state) &&
    (await workspaceAttestedGeneratedFilesIntact(params.dir, params.attestation.generatedHashes))
  );
}

async function workspaceSetupStateHasSurvivalEvidence(params: {
  dir: string;
  bootstrapPath: string;
  initialState: WorkspaceStateSnapshot;
}): Promise<boolean> {
  if (await pathExists(params.bootstrapPath)) {
    return true;
  }
  if (await hasWorkspaceUserContentEvidence(params.dir)) {
    return true;
  }
  const currentState = readCanonicalWorkspaceStateSnapshot(params.dir);
  if (
    currentState.setup.bootstrapSeededAt !== params.initialState.setup.bootstrapSeededAt ||
    currentState.setup.setupCompletedAt !== params.initialState.setup.setupCompletedAt
  ) {
    return true;
  }
  const generatedHashes = await collectGeneratedBootstrapHashes(params.dir);
  return [
    DEFAULT_AGENTS_FILENAME,
    DEFAULT_SOUL_FILENAME,
    DEFAULT_TOOLS_FILENAME,
    DEFAULT_IDENTITY_FILENAME,
    DEFAULT_USER_FILENAME,
    DEFAULT_HEARTBEAT_FILENAME,
  ].every((fileName) => generatedHashes.has(fileName));
}

function readCanonicalWorkspaceStateSnapshot(dir: string): WorkspaceStateSnapshot {
  const snapshot = readWorkspaceStateSnapshot(dir);
  assertNoUnmigratedWorkspaceState({
    workspaceDir: dir,
  });
  return snapshot;
}

export async function isWorkspaceSetupCompleted(dir: string): Promise<boolean> {
  const state = readCanonicalWorkspaceStateSnapshot(dir).setup;
  return typeof state.setupCompletedAt === "string" && state.setupCompletedAt.trim().length > 0;
}

export async function resolveWorkspaceBootstrapStatus(
  dir: string,
): Promise<"pending" | "complete"> {
  const resolvedDir = resolveUserPath(dir);
  const state = readCanonicalWorkspaceStateSnapshot(resolvedDir).setup;
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
  bootstrapPending?: boolean;
  identityPathCreated?: boolean;
}> {
  const rawDir = params?.dir?.trim() ? params.dir.trim() : DEFAULT_AGENT_WORKSPACE_DIR;
  const dir = resolveUserPath(rawDir);
  let initialState = readCanonicalWorkspaceStateSnapshot(dir);
  let reseedingExpiredWorkspaceState = false;
  const recentAttestation = recentWorkspaceAttestation(initialState.attestation);
  const recentSetupState = hasRecentWorkspaceSetupState(initialState);
  const workspaceExists = await pathExists(dir);

  if (!workspaceExists) {
    if (recentAttestation) {
      throw new WorkspaceVanishedError({ workspaceDir: dir });
    }
    // Old setup state lived inside the workspace and disappeared with it.
    // Expired SQLite evidence must preserve that reseed contract. The write
    // transaction also catches a concurrent attestation refresh.
    if (!clearExpiredWorkspaceStateForVanishedWorkspace(dir)) {
      throw new WorkspaceVanishedError({ workspaceDir: dir });
    }
  }

  await fs.mkdir(dir, { recursive: true });

  const bootstrapPath = path.join(dir, DEFAULT_BOOTSTRAP_FILENAME);
  if (!params?.ensureBootstrapFiles) {
    const hasContentEvidence = await hasSkipBootstrapWorkspaceContentEvidence(dir);
    if (recentAttestation && !hasContentEvidence) {
      throw new WorkspaceVanishedError({ workspaceDir: dir });
    }
    if (
      hasWorkspaceSetupStateMarker(initialState.setup) &&
      !initialState.attestation &&
      !(await workspaceSetupStateHasSurvivalEvidence({
        dir,
        bootstrapPath,
        initialState,
      }))
    ) {
      if (recentSetupState || !clearExpiredWorkspaceStateForVanishedWorkspace(dir)) {
        throw new WorkspaceVanishedError({ workspaceDir: dir });
      }
    }
    if (hasContentEvidence) {
      await maybeWriteWorkspaceAttestation(dir);
    }
    return { dir, bootstrapPending: false };
  }

  const agentsPath = path.join(dir, DEFAULT_AGENTS_FILENAME);
  const soulPath = path.join(dir, DEFAULT_SOUL_FILENAME);
  const toolsPath = path.join(dir, DEFAULT_TOOLS_FILENAME);
  const identityPath = path.join(dir, DEFAULT_IDENTITY_FILENAME);
  const userPath = path.join(dir, DEFAULT_USER_FILENAME);
  const heartbeatPath = path.join(dir, DEFAULT_HEARTBEAT_FILENAME);

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
    if (recentAttestation) {
      throw new WorkspaceVanishedError({ workspaceDir: dir });
    }
    reseedingExpiredWorkspaceState = initialState.setupExists || Boolean(initialState.attestation);
    // A wiped workspace can leave its directory (or only .git) behind. Clear
    // expired SQLite evidence before deciding whether setup already completed.
    if (!clearExpiredWorkspaceStateForVanishedWorkspace(dir)) {
      throw new WorkspaceVanishedError({ workspaceDir: dir });
    }
  }

  if (initialState.attestation && !isBrandNewWorkspace) {
    const hasWorkspaceEvidence = await workspaceAttestationHasSurvivalEvidence({
      dir,
      bootstrapPath,
      state: initialState.setup,
      attestation: initialState.attestation,
    });
    if (!hasWorkspaceEvidence) {
      if (recentAttestation) {
        throw new WorkspaceVanishedError({ workspaceDir: dir });
      }
      reseedingExpiredWorkspaceState = true;
      // The transaction rejects a concurrent refresh. Only the expired
      // snapshot we just inspected may be cleared before reseeding.
      if (!clearExpiredWorkspaceStateForVanishedWorkspace(dir)) {
        throw new WorkspaceVanishedError({ workspaceDir: dir });
      }
    }
  } else if (
    hasWorkspaceSetupStateMarker(initialState.setup) &&
    !isBrandNewWorkspace &&
    !(await workspaceSetupStateHasSurvivalEvidence({ dir, bootstrapPath, initialState }))
  ) {
    // Setup can outlive a best-effort attestation write or arrive alone from
    // Doctor. Ambiguous partial remnants must fail closed, not inherit stale
    // completion state and silently suppress BOOTSTRAP reseeding.
    if (recentSetupState) {
      throw new WorkspaceVanishedError({ workspaceDir: dir });
    }
    reseedingExpiredWorkspaceState = true;
    if (!clearExpiredWorkspaceStateForVanishedWorkspace(dir)) {
      throw new WorkspaceVanishedError({ workspaceDir: dir });
    }
  }

  const agentsTemplate = await loadTemplate(DEFAULT_AGENTS_FILENAME);
  const soulTemplate = await loadTemplate(DEFAULT_SOUL_FILENAME);
  const toolsTemplate = await loadTemplate(DEFAULT_TOOLS_FILENAME);
  const identityTemplate = await loadTemplate(DEFAULT_IDENTITY_FILENAME);
  const userTemplate = await loadTemplate(DEFAULT_USER_FILENAME);
  const heartbeatTemplate = await loadTemplate(DEFAULT_HEARTBEAT_FILENAME);
  // Template and filesystem checks above are async. Another process may have
  // completed setup while they ran, so optional-file policy needs fresh state.
  initialState = readCanonicalWorkspaceStateSnapshot(dir);
  const skipOptionalBootstrapFiles = new Set(params?.skipOptionalBootstrapFiles ?? []);
  // When the workspace is already configured, skip optional bootstrap files to
  // prevent subagent spawns from recreating root-level SOUL.md, USER.md,
  // IDENTITY.md, or HEARTBEAT.md that were removed intentionally or only exist
  // under agent-specific subdirectories.
  if (initialState.setup.setupCompletedAt) {
    for (const filename of OPTIONAL_BOOTSTRAP_FILENAMES) {
      skipOptionalBootstrapFiles.add(filename);
    }
  }
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

  let state = readCanonicalWorkspaceStateSnapshot(dir).setup;
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
    // If USER/IDENTITY diverged from templates, or if user-content indicators
    // exist, treat setup as complete and avoid recreating BOOTSTRAP.
    const hasRecentAttestedCustomization = recentAttestation
      ? await workspaceRequiredBootstrapLooksCustomized(dir, {
          generatedHashes: recentAttestation.generatedHashes,
        })
      : false;
    if (
      hasRecentAttestedCustomization ||
      (await workspaceProfileLooksConfigured({
        dir,
        // A preexisting Git repository is user evidence. Git metadata left by
        // an expired, wiped OpenClaw workspace is not completion evidence.
        includeGitEvidence: !reseedingExpiredWorkspaceState,
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
    state = mergeWorkspaceSetupState(dir, state);
  }
  await ensureGitRepo(dir, isBrandNewWorkspace);
  await maybeWriteWorkspaceAttestation(dir);

  return {
    dir,
    agentsPath,
    soulPath,
    toolsPath,
    identityPath,
    userPath,
    heartbeatPath,
    bootstrapPath,
    bootstrapPending: !state.setupCompletedAt && bootstrapExists,
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
