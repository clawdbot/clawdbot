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
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import {
  LegacyMigrationSourceClaim,
  legacyMigrationPathMayExist as pathMayExist,
  legacyMigrationSourceOrClaimMayExist as sourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch as snapshotsMatch,
} from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";
import {
  markLegacyMigrationSourceRemoved,
  readReceipt,
  type MigrationReceipt,
} from "./state-migrations.workspace-setup-receipts.js";
import { listSandboxWorkspaceDirs } from "./state-migrations.workspace-setup-sandbox.js";
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
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

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

function createLegacySourceClaim(
  sourceRoot: Root,
  source: LegacyWorkspaceStateSource,
): LegacyMigrationSourceClaim<SourceSnapshot> {
  return new LegacyMigrationSourceClaim({
    stateRoot: sourceRoot,
    stateDir: source.rootDir,
    sourcePath: source.sourcePath,
    label: "workspace",
    claimSuffix: CLAIM_SUFFIX,
    formatError: formatErrorMessage,
    readSnapshot: (sourcePath) =>
      readBoundedRegularFile({
        sourceRoot,
        relativePath:
          sourcePath === source.sourcePath
            ? source.relativePath
            : `${source.relativePath}${CLAIM_SUFFIX}`,
        sourcePath,
        maxBytes:
          source.kind === "setup" ? SETUP_MAX_BYTES : LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
      }),
  });
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

function addLegacyWorkspaceSources(params: {
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  add: (source: LegacyWorkspaceStateSource) => void;
}): void {
  const identity = resolveWorkspaceStateIdentity(params.workspaceDir);
  const paths = resolveLegacyWorkspaceSourcePaths(params.workspaceDir, {
    env: params.env,
    homedir: params.homedir,
  });
  for (const [priority, sourcePath] of paths.setupStatePaths.entries()) {
    if (sourceOrClaimMayExist(sourcePath)) {
      params.add(
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
      params.add(
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
    params.add(
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
    addLegacyWorkspaceSources({ workspaceDir, env, homedir, add });
  }

  for (const workspaceDir of listSandboxWorkspaceDirs({
    cfg: params.cfg,
    env,
    homedir,
    stateDir: params.stateDir,
  })) {
    addLegacyWorkspaceSources({ workspaceDir, env, homedir, add });
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

async function cleanupReceiptSource(params: {
  sourceClaim: LegacyMigrationSourceClaim<SourceSnapshot>;
  source: LegacyWorkspaceStateSource;
  receipt: MigrationReceipt;
  env: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  try {
    assertConfiguredWorkspaceIdentity(params.source);
    const sourceClaim = params.sourceClaim;
    const hasSource = await sourceClaim.exists();
    const hasClaim = await sourceClaim.exists(true);
    if (!hasSource && !hasClaim) {
      if (!params.receipt.removedSource) {
        markLegacyMigrationSourceRemoved(params.receipt.sourceKey, params.env);
      }
      return { changes: [], warnings: [] };
    }
    if (hasSource && hasClaim) {
      return {
        changes: [],
        warnings: ["Workspace state is in SQLite, but source and interrupted claim both exist."],
      };
    }
    let snapshot = await sourceClaim.read(hasClaim);
    let claimedByThisRun = false;
    if (hasSource) {
      try {
        snapshot = await sourceClaim.claim({
          snapshot,
          mismatchMessage: "legacy workspace source changed before Doctor could claim it",
        });
      } catch (error) {
        await sourceClaim.restore();
        throw error;
      }
      claimedByThisRun = true;
    }
    const parsed = parseSource(params.source, snapshot);
    if (
      !params.receipt.sha256 ||
      snapshot.sha256 !== params.receipt.sha256 ||
      !canonicalCoversParsedSource({ source: params.source, parsed, env: params.env })
    ) {
      if (claimedByThisRun) {
        await sourceClaim.restore();
      }
      return {
        changes: [],
        warnings: ["Workspace state is in SQLite, but the retired source now conflicts."],
      };
    }
    const unchanged = await sourceClaim.read(true);
    if (!snapshotsMatch(snapshot, unchanged)) {
      if (claimedByThisRun) {
        await sourceClaim.restore();
      }
      throw new Error("legacy workspace claim changed before cleanup");
    }
    assertConfiguredWorkspaceIdentity(params.source);
    await sourceClaim.remove({ skipSourceCheck: true });
    markLegacyMigrationSourceRemoved(params.receipt.sourceKey, params.env);
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
  let sourceClaim: LegacyMigrationSourceClaim<SourceSnapshot>;
  try {
    assertConfiguredWorkspaceIdentity(params.source);
    const sourceRoot = await root(params.source.rootDir, {
      hardlinks: "reject",
      symlinks: "reject",
    });
    sourceClaim = createLegacySourceClaim(sourceRoot, params.source);
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed reading legacy workspace state: ${formatErrorMessage(error)}`],
    };
  }
  const receipt = readReceipt(params.source, params.env);
  if (receipt) {
    return cleanupReceiptSource({
      sourceClaim,
      source: params.source,
      receipt,
      env: params.env,
    });
  }
  let hasSource: boolean;
  let hasClaim: boolean;
  try {
    hasSource = await sourceClaim.exists();
    hasClaim = await sourceClaim.exists(true);
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
  if (!hasSource && !hasClaim) {
    return { changes: [], warnings: [] };
  }

  let snapshot: SourceSnapshot;
  let parsed: ParsedSource;
  let claimedByThisRun = false;
  try {
    snapshot = await sourceClaim.read(!hasSource);
    parsed = parseSource(params.source, snapshot);
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed reading legacy workspace state: ${formatErrorMessage(error)}`],
    };
  }

  if (hasSource) {
    try {
      snapshot = await sourceClaim.claim({
        snapshot,
        beforeClaim: () => {
          params.beforeClaim?.(params.source);
          assertConfiguredWorkspaceIdentity(params.source);
        },
        mismatchMessage: "legacy workspace source changed before Doctor could claim it",
      });
      claimedByThisRun = true;
    } catch (error) {
      const restoreError = await sourceClaim.restore();
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
    const restoreError = claimedByThisRun ? await sourceClaim.restore() : null;
    return {
      changes: [],
      warnings: [
        `Failed migrating legacy workspace state: ${formatErrorMessage(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  try {
    if (await sourceClaim.exists()) {
      throw new Error("legacy workspace source reappeared during import");
    }
    const unchanged = await sourceClaim.read(true);
    if (!snapshotsMatch(snapshot, unchanged)) {
      throw new Error("legacy workspace claim changed after import");
    }
    await sourceClaim.remove({ removeSource: params.removeSource, skipSourceCheck: true });
    markLegacyMigrationSourceRemoved(result.sourceKey, params.env);
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
  const detected = params.detected;
  if (!detected?.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy workspace state",
    releaseLabel: "Workspace",
    formatAcquireError: formatErrorMessage,
    run: async (env) => {
      const changes: string[] = [];
      const warnings: string[] = [];
      const notices: string[] = [];
      for (const source of detected.sources) {
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
      return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
    },
  });
}
