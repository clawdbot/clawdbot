// Doctor-only import for retired workspace setup and attestation files.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { root, type Root } from "@openclaw/fs-safe";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import {
  LEGACY_WORKSPACE_ATTESTATION_DIRNAME,
  LEGACY_WORKSPACE_ATTESTATION_HEADER,
  LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
  LEGACY_WORKSPACE_STATE_CURRENT_FILENAME,
  WORKSPACE_DOCTOR_CLAIM_SUFFIX,
  resolveLegacyWorkspaceSourcePaths,
} from "../agents/workspace-legacy-state.js";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-store.js";
import { resolveLegacyStateDirs } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "./errors.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import type { MigrationMessages } from "./state-migrations.types.js";
import {
  markSourceRemoved,
  readReceipt,
  type MigrationReceipt,
} from "./state-migrations.workspace-setup-receipts.js";
import {
  canonicalCoversParsedSource,
  importAndRecordReceipt,
  parseSource,
  type ParsedSource,
  type SourceSnapshot,
} from "./state-migrations.workspace-setup-store.js";
import type {
  LegacyWorkspaceStateDetection,
  LegacyWorkspaceStateSource,
} from "./state-migrations.workspace-setup.types.js";

const SETUP_MAX_BYTES = 64 * 1024;
const CLAIM_SUFFIX = WORKSPACE_DOCTOR_CLAIM_SUFFIX;
const MIGRATION_LOCK_TIMEOUT_MS = 250;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 25;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function pathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function sourceOrClaimMayExist(sourcePath: string): boolean {
  return pathMayExist(sourcePath) || pathMayExist(`${sourcePath}${CLAIM_SUFFIX}`);
}

async function readBoundedRegularFile(params: {
  sourceRoot: Root;
  relativePath: string;
  sourcePath: string;
  maxBytes: number;
}): Promise<SourceSnapshot> {
  const opened = await params.sourceRoot.open(params.relativePath, {
    hardlinks: "reject",
    symlinks: "reject",
  });
  try {
    const before = opened.stat;
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size > params.maxBytes
    ) {
      throw new Error("legacy workspace source is not a safe regular file");
    }
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await opened.handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) {
        throw new Error("legacy workspace source ended unexpectedly");
      }
      offset += bytesRead;
    }
    const after = await opened.handle.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      offset !== after.size
    ) {
      throw new Error("legacy workspace source changed while reading");
    }
    let raw: string;
    try {
      raw = utf8Decoder.decode(buffer);
    } catch {
      throw new Error("legacy workspace source is not valid UTF-8");
    }
    return {
      sourcePath: params.sourcePath,
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      size: after.size,
      raw,
    };
  } finally {
    await opened[Symbol.asyncDispose]();
  }
}

function createLegacySource(
  params: Omit<LegacyWorkspaceStateSource, "relativePath" | "rootDir"> & { rootDir: string },
): LegacyWorkspaceStateSource {
  const rootDir = path.resolve(params.rootDir);
  const sourcePath = path.resolve(params.sourcePath);
  const relativePath = path.relative(rootDir, sourcePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("legacy workspace source is outside its migration root");
  }
  return { ...params, rootDir, relativePath, sourcePath };
}

function snapshotsMatch(left: SourceSnapshot, right: SourceSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function siblingAttestationNeedsDoctor(filePath: string): boolean {
  try {
    const before = fs.lstatSync(filePath);
    if (!before.isFile()) {
      return false;
    }
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    let fd: number;
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    } catch {
      // An unreadable regular file could be an owned marker. Doctor must surface it.
      return true;
    }
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        return true;
      }
      const expected = Buffer.from(`${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n`, "utf8");
      const bytes = Buffer.alloc(expected.length);
      const read = fs.readSync(fd, bytes, 0, bytes.length, 0);
      return read === expected.length && bytes.equals(expected);
    } catch {
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function listOrphanAttestationSources(params: {
  stateDir: string;
  homedir: () => string;
}): LegacyWorkspaceStateSource[] {
  const sources: LegacyWorkspaceStateSource[] = [];
  const stateDirs = [...new Set([params.stateDir, ...resolveLegacyStateDirs(params.homedir)])];
  for (const [priority, stateDir] of stateDirs.entries()) {
    const attestationDir = path.join(stateDir, LEGACY_WORKSPACE_ATTESTATION_DIRNAME);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(attestationDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      // Preserve a path-shaped detection so Doctor reports the unsafe directory.
      sources.push({
        ...createLegacySource({
          kind: "attestation",
          rootDir: stateDir,
          sourcePath: attestationDir,
          workspaceKey: "unreadable-attestation-directory",
          priority,
        }),
      });
      continue;
    }
    for (const entry of entries) {
      const match = /^([a-f0-9]{64})\.attested(?:\.doctor-importing)?$/.exec(entry.name);
      if (!match?.[1]) {
        continue;
      }
      const sourceName = entry.name.endsWith(CLAIM_SUFFIX)
        ? entry.name.slice(0, -CLAIM_SUFFIX.length)
        : entry.name;
      sources.push(
        createLegacySource({
          kind: "attestation",
          rootDir: stateDir,
          sourcePath: path.join(attestationDir, sourceName),
          workspaceKey: match[1],
          priority,
        }),
      );
    }
  }
  return sources;
}

/** Detect retired workspace files only when an explicit Doctor flow opts in. */
export function detectLegacyWorkspaceState(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyWorkspaceStateDetection {
  if (params.doctorOnlyStateMigrations !== true) {
    return { sources: [], hasLegacy: false };
  }
  const env = { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir };
  const homedir = params.homedir ?? os.homedir;
  const byPath = new Map<string, LegacyWorkspaceStateSource>();
  const add = (source: LegacyWorkspaceStateSource) => {
    const key = `${source.kind}:${path.resolve(source.sourcePath)}`;
    const existing = byPath.get(key);
    const sourceIsConfigured = source.workspaceDir !== undefined;
    const existingIsConfigured = existing?.workspaceDir !== undefined;
    if (
      !existing ||
      (sourceIsConfigured && !existingIsConfigured) ||
      (sourceIsConfigured === existingIsConfigured && source.priority < existing.priority)
    ) {
      byPath.set(key, source);
    }
  };

  for (const workspaceDir of listAgentWorkspaceDirs(params.cfg)) {
    const identity = resolveWorkspaceStateIdentity(workspaceDir);
    const paths = resolveLegacyWorkspaceSourcePaths(workspaceDir, { env, homedir });
    for (const [priority, sourcePath] of paths.setupStatePaths.entries()) {
      if (sourceOrClaimMayExist(sourcePath)) {
        add(
          createLegacySource({
            kind: "setup",
            rootDir: sourcePath.endsWith(LEGACY_WORKSPACE_STATE_CURRENT_FILENAME)
              ? path.dirname(sourcePath)
              : path.dirname(path.dirname(sourcePath)),
            sourcePath,
            workspaceKey: identity.workspaceKey,
            workspaceDir: identity.workspacePath,
            workspaceAliasPath: paths.workspacePath,
            priority,
          }),
        );
      }
    }
    for (const [priority, sourcePath] of paths.stateDirAttestationPaths.entries()) {
      if (sourceOrClaimMayExist(sourcePath)) {
        add(
          createLegacySource({
            kind: "attestation",
            rootDir: path.dirname(path.dirname(sourcePath)),
            sourcePath,
            workspaceKey: identity.workspaceKey,
            workspaceDir: identity.workspacePath,
            workspaceAliasPath: paths.workspacePath,
            priority,
          }),
        );
      }
    }
    for (const [index, sourcePath] of paths.siblingAttestationPaths.entries()) {
      if (
        !pathMayExist(`${sourcePath}${CLAIM_SUFFIX}`) &&
        !siblingAttestationNeedsDoctor(sourcePath)
      ) {
        continue;
      }
      add(
        createLegacySource({
          kind: "attestation",
          rootDir: path.dirname(sourcePath),
          sourcePath,
          workspaceKey: identity.workspaceKey,
          workspaceDir: identity.workspacePath,
          workspaceAliasPath: paths.workspacePath,
          priority: paths.stateDirAttestationPaths.length + index,
        }),
      );
    }
  }

  for (const source of listOrphanAttestationSources({ stateDir: params.stateDir, homedir })) {
    add(source);
  }
  const sources = [...byPath.values()].toSorted(
    (left, right) =>
      left.priority - right.priority ||
      left.workspaceKey.localeCompare(right.workspaceKey) ||
      left.sourcePath.localeCompare(right.sourcePath),
  );
  return { sources, hasLegacy: sources.length > 0 };
}

function assertConfiguredWorkspaceIdentity(source: LegacyWorkspaceStateSource): void {
  if (!source.workspaceAliasPath) {
    return;
  }
  if (!source.workspaceDir) {
    throw new Error("configured legacy workspace source has no canonical path");
  }
  const current = resolveWorkspaceStateIdentity(source.workspaceAliasPath);
  if (
    current.workspaceKey !== source.workspaceKey ||
    current.workspacePath !== source.workspaceDir
  ) {
    throw new Error("configured workspace identity changed during Doctor migration");
  }
}

async function restoreClaim(params: {
  sourceRoot: Root;
  source: LegacyWorkspaceStateSource;
}): Promise<string | null> {
  const claimRelativePath = `${params.source.relativePath}${CLAIM_SUFFIX}`;
  try {
    if (!(await params.sourceRoot.exists(claimRelativePath))) {
      return null;
    }
    if (await params.sourceRoot.exists(params.source.relativePath)) {
      return `source path already exists: ${params.source.sourcePath}`;
    }
    await params.sourceRoot.move(claimRelativePath, params.source.relativePath);
    return null;
  } catch (error) {
    return formatErrorMessage(error);
  }
}

async function cleanupReceiptSource(params: {
  sourceRoot: Root;
  source: LegacyWorkspaceStateSource;
  receipt: MigrationReceipt;
  env: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  try {
    assertConfiguredWorkspaceIdentity(params.source);
    const candidates = [
      {
        relativePath: params.source.relativePath,
        sourcePath: params.source.sourcePath,
      },
      {
        relativePath: `${params.source.relativePath}${CLAIM_SUFFIX}`,
        sourcePath: `${params.source.sourcePath}${CLAIM_SUFFIX}`,
      },
    ];
    const existing = [];
    for (const candidate of candidates) {
      if (await params.sourceRoot.exists(candidate.relativePath)) {
        existing.push(candidate);
      }
    }
    if (existing.length === 0) {
      if (!params.receipt.removedSource) {
        markSourceRemoved(params.receipt.sourceKey, params.env);
      }
      return { changes: [], warnings: [] };
    }
    if (existing.length > 1) {
      return {
        changes: [],
        warnings: ["Workspace state is in SQLite, but source and interrupted claim both exist."],
      };
    }
    let active = existing[0]!;
    let snapshot = await readBoundedRegularFile({
      sourceRoot: params.sourceRoot,
      relativePath: active.relativePath,
      sourcePath: active.sourcePath,
      maxBytes:
        params.source.kind === "setup" ? SETUP_MAX_BYTES : LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
    });
    let claimedByThisRun = false;
    if (active.relativePath === params.source.relativePath) {
      const claim = candidates[1]!;
      await params.sourceRoot.move(active.relativePath, claim.relativePath);
      const claimed = await readBoundedRegularFile({
        sourceRoot: params.sourceRoot,
        relativePath: claim.relativePath,
        sourcePath: claim.sourcePath,
        maxBytes:
          params.source.kind === "setup" ? SETUP_MAX_BYTES : LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
      });
      if (!snapshotsMatch(snapshot, claimed)) {
        await restoreClaim({ sourceRoot: params.sourceRoot, source: params.source });
        throw new Error("legacy workspace source changed before Doctor could claim it");
      }
      active = claim;
      snapshot = claimed;
      claimedByThisRun = true;
    }
    const parsed = parseSource(params.source, snapshot);
    if (
      !params.receipt.sha256 ||
      snapshot.sha256 !== params.receipt.sha256 ||
      !canonicalCoversParsedSource({ source: params.source, parsed, env: params.env })
    ) {
      if (claimedByThisRun) {
        await restoreClaim({ sourceRoot: params.sourceRoot, source: params.source });
      }
      return {
        changes: [],
        warnings: ["Workspace state is in SQLite, but the retired source now conflicts."],
      };
    }
    const unchanged = await readBoundedRegularFile({
      sourceRoot: params.sourceRoot,
      relativePath: active.relativePath,
      sourcePath: active.sourcePath,
      maxBytes:
        params.source.kind === "setup" ? SETUP_MAX_BYTES : LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
    });
    if (!snapshotsMatch(snapshot, unchanged)) {
      if (claimedByThisRun) {
        await restoreClaim({ sourceRoot: params.sourceRoot, source: params.source });
      }
      throw new Error("legacy workspace claim changed before cleanup");
    }
    assertConfiguredWorkspaceIdentity(params.source);
    await params.sourceRoot.remove(active.relativePath);
    markSourceRemoved(params.receipt.sourceKey, params.env);
    return {
      changes: [],
      warnings: [],
      notices: ["Discarded retired workspace state already covered by its SQLite receipt."],
    };
  } catch (error) {
    return {
      changes: [],
      warnings: [
        `Workspace state is in SQLite, but legacy cleanup failed: ${formatErrorMessage(error)}`,
      ],
    };
  }
}

async function migrateOneSource(params: {
  source: LegacyWorkspaceStateSource;
  env: NodeJS.ProcessEnv;
  beforeClaim?: (source: LegacyWorkspaceStateSource) => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  let sourceRoot: Root;
  try {
    assertConfiguredWorkspaceIdentity(params.source);
    sourceRoot = await root(params.source.rootDir, {
      hardlinks: "reject",
      symlinks: "reject",
    });
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed reading legacy workspace state: ${formatErrorMessage(error)}`],
    };
  }
  const receipt = readReceipt(params.source, params.env);
  if (receipt) {
    return cleanupReceiptSource({
      sourceRoot,
      source: params.source,
      receipt,
      env: params.env,
    });
  }

  const sourcePath = params.source.sourcePath;
  const claimPath = `${sourcePath}${CLAIM_SUFFIX}`;
  const claimRelativePath = `${params.source.relativePath}${CLAIM_SUFFIX}`;
  let hasSource: boolean;
  let hasClaim: boolean;
  try {
    hasSource = await sourceRoot.exists(params.source.relativePath);
    hasClaim = await sourceRoot.exists(claimRelativePath);
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed reading legacy workspace state: ${formatErrorMessage(error)}`],
    };
  }
  if (hasSource && hasClaim) {
    return {
      changes: [],
      warnings: [
        "Failed migrating legacy workspace state: source and interrupted claim both exist.",
      ],
    };
  }
  const activePath = hasSource ? sourcePath : hasClaim ? claimPath : null;
  const activeRelativePath = hasSource
    ? params.source.relativePath
    : hasClaim
      ? claimRelativePath
      : null;
  if (!activePath || !activeRelativePath) {
    return { changes: [], warnings: [] };
  }

  let snapshot: SourceSnapshot;
  let parsed: ParsedSource;
  let claimedByThisRun = false;
  try {
    snapshot = await readBoundedRegularFile({
      sourceRoot,
      relativePath: activeRelativePath,
      sourcePath: activePath,
      maxBytes:
        params.source.kind === "setup" ? SETUP_MAX_BYTES : LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
    });
    parsed = parseSource(params.source, snapshot);
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed reading legacy workspace state: ${formatErrorMessage(error)}`],
    };
  }

  if (activePath === sourcePath) {
    try {
      params.beforeClaim?.(params.source);
      assertConfiguredWorkspaceIdentity(params.source);
      await sourceRoot.move(params.source.relativePath, claimRelativePath);
      const claimed = await readBoundedRegularFile({
        sourceRoot,
        relativePath: claimRelativePath,
        sourcePath: claimPath,
        maxBytes:
          params.source.kind === "setup" ? SETUP_MAX_BYTES : LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
      });
      if (!snapshotsMatch(snapshot, claimed)) {
        throw new Error("legacy workspace source changed before Doctor could claim it");
      }
      snapshot = claimed;
      claimedByThisRun = true;
    } catch (error) {
      const restoreError = await restoreClaim({ sourceRoot, source: params.source });
      return {
        changes: [],
        warnings: [
          `Failed migrating legacy workspace state: ${formatErrorMessage(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
        ],
      };
    }
  }

  let result: ReturnType<typeof importAndRecordReceipt>;
  try {
    assertConfiguredWorkspaceIdentity(params.source);
    result = importAndRecordReceipt({
      source: params.source,
      snapshot,
      parsed,
      env: params.env,
    });
  } catch (error) {
    const restoreError = claimedByThisRun
      ? await restoreClaim({ sourceRoot, source: params.source })
      : null;
    return {
      changes: [],
      warnings: [
        `Failed migrating legacy workspace state: ${formatErrorMessage(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  try {
    if (await sourceRoot.exists(params.source.relativePath)) {
      throw new Error("legacy workspace source reappeared during import");
    }
    const unchanged = await readBoundedRegularFile({
      sourceRoot,
      relativePath: claimRelativePath,
      sourcePath: claimPath,
      maxBytes:
        params.source.kind === "setup" ? SETUP_MAX_BYTES : LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
    });
    if (!snapshotsMatch(snapshot, unchanged)) {
      throw new Error("legacy workspace claim changed after import");
    }
    if (params.removeSource) {
      await params.removeSource(claimPath);
    } else {
      await sourceRoot.remove(claimRelativePath);
    }
    markSourceRemoved(result.sourceKey, params.env);
  } catch (error) {
    return {
      changes: [],
      warnings: [
        `Workspace state is in SQLite, but legacy cleanup failed: ${formatErrorMessage(error)}`,
      ],
    };
  }

  const label = parsed.kind === "setup" ? "workspace setup state" : "workspace attestation";
  return {
    changes: [
      result.imported ? `Migrated ${label} to SQLite.` : `Verified canonical SQLite ${label}.`,
    ],
    warnings: [],
    notices: ["Removed retired workspace state after verified SQLite import."],
  };
}

/** Import retired workspace files while excluding Gateways that can recreate them. */
export async function migrateLegacyWorkspaceState(params: {
  detected?: LegacyWorkspaceStateDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeClaim?: (source: LegacyWorkspaceStateSource) => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  if (!params.detected?.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  const env = { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir };
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: MIGRATION_LOCK_POLL_INTERVAL_MS,
      role: "sqlite-maintenance",
      timeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    const detail =
      error instanceof GatewayLockError
        ? "the Gateway or another SQLite maintenance command owns this state directory"
        : formatErrorMessage(error);
    return {
      changes: [],
      warnings: [
        `Failed migrating legacy workspace state: ${detail}. Stop the Gateway and run \`openclaw doctor --fix\` again.`,
      ],
    };
  }
  if (!lock) {
    return {
      changes: [],
      warnings: ["Failed migrating legacy workspace state: exclusive state ownership unavailable."],
    };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  let releaseError: unknown;
  try {
    for (const source of params.detected.sources) {
      const result = await migrateOneSource({
        source,
        env,
        ...(params.beforeClaim ? { beforeClaim: params.beforeClaim } : {}),
        ...(params.removeSource ? { removeSource: params.removeSource } : {}),
      });
      changes.push(...result.changes);
      warnings.push(...result.warnings);
      notices.push(...(result.notices ?? []));
    }
  } finally {
    try {
      await lock.release();
    } catch (error) {
      releaseError = error;
    }
  }
  if (releaseError) {
    warnings.push(`Workspace migration lock release failed: ${formatErrorMessage(releaseError)}`);
  }
  return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
}
