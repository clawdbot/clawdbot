import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isPathInside } from "../infra/path-guards.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  NODE_WORKER_WORKSPACE_STDERR_MAX_BYTES,
  NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES,
  parseNodeWorkerWorkspaceExecResult,
  type NodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecResult,
} from "../worker/node-workspace-protocol.js";
import type {
  NodeWorkerWorkspaceRetainInput,
  NodeWorkerWorkspaceRetainResult,
} from "../worker/node-workspace-retain-protocol.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import {
  type NodeWorkerTransferGateway,
  runNodeWorkerWorkspaceTransfer,
  serializeNodeWorkerWorkspace,
} from "./node-worker-transfer-client.js";
import {
  hashNodeWorkerWorkspaceComponent as hashPathComponent,
  nodeWorkerWorkspaceGenerationKey as workspaceGenerationKey,
  nodeWorkerWorkspaceLaunchGenerationKey as launchGenerationKey,
  nodeWorkerWorkspaceSessionKey as workspaceSessionKey,
  parseNodeWorkerWorkspaceGeneration as parseGenerationName,
  parseNodeWorkerWorkspaceTransferGeneration as parseTransferArtifactGeneration,
  resolveNodeManagedWorkspaceIdentity,
  type NodeWorkerManagedWorkspaceRequest,
} from "./node-worker-workspace-identity.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const WORKSPACE_RETENTION_DELETE_LIMIT = 256;
const ENVIRONMENT_HASH_PATTERN = /^[a-f0-9]{16}$/u;
const SESSION_HASH_PATTERN = /^[a-f0-9]{32}$/u;
const MANIFEST_FILE_PATTERN = /^[a-f0-9]{64}\.json$/u;

type NodeWorkerWorkspaceLaunchReference = {
  gatewayNamespace: string;
  environmentId: string;
  sessionId: string;
  ownerEpoch: number;
};

type WorkspaceSession = {
  gatewayNamespace: string;
  environmentHash: string;
  sessionHash: string;
  workspacesRoot: string;
  environmentRoot: string;
  sessionRoot: string;
};

type AcceptedRetainSnapshot = {
  controllerId: string;
  sequence: number;
  signature: string;
  retainedGenerations: Set<string>;
  manifestsBySession: Map<string, Set<string> | null>;
};

async function listOwnedEntries(parent: string): Promise<fs.Dirent[]> {
  try {
    return (await fsp.readdir(parent, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listOwnedDirectories(parent: string): Promise<string[]> {
  return (await listOwnedEntries(parent))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name);
}

async function removeOwnedDirectory(
  root: string,
  target: string,
  canDelete: () => boolean = () => true,
): Promise<boolean> {
  try {
    const [stats, parent, resolved] = await Promise.all([
      fsp.lstat(target),
      fsp.realpath(path.dirname(target)),
      fsp.realpath(target),
    ]);
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      path.dirname(resolved) !== parent ||
      !isPathInside(root, resolved)
    ) {
      return false;
    }
    if (!canDelete()) {
      return false;
    }
    await fsp.rm(target, { recursive: true, force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeOwnedFile(
  root: string,
  target: string,
  canDelete: () => boolean = () => true,
): Promise<boolean> {
  try {
    const [stats, parent, resolved] = await Promise.all([
      fsp.lstat(target),
      fsp.realpath(path.dirname(target)),
      fsp.realpath(target),
    ]);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      path.dirname(resolved) !== parent ||
      !isPathInside(root, resolved)
    ) {
      return false;
    }
    if (!canDelete()) {
      return false;
    }
    await fsp.rm(target, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeIfEmpty(target: string): Promise<void> {
  try {
    await fsp.rmdir(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  }
}

function ensureContainedDirectory(parent: string, name: string): string {
  const candidate = path.join(parent, name);
  fs.mkdirSync(candidate, { recursive: true });
  const stats = fs.lstatSync(candidate);
  const resolved = fs.realpathSync.native(candidate);
  if (stats.isSymbolicLink() || !stats.isDirectory() || !isPathInside(parent, resolved)) {
    throw new Error("INVALID_REQUEST: node worker workspace path escaped its owner root");
  }
  return resolved;
}

function resolveArgumentPath(workspaceDir: string, arg: string): string | undefined {
  if (path.isAbsolute(arg)) {
    return arg;
  }
  if (arg.startsWith(".") || arg.includes("/") || (path.sep === "\\" && arg.includes("\\"))) {
    return path.resolve(workspaceDir, arg);
  }
  return undefined;
}

function assertWorkspaceArgv(workspaceDir: string, argv: readonly string[]): void {
  // This private transport owns cwd and direct path operands; it is not the user-facing
  // system.run policy domain, so absolute/relative escapes must never cross its workspace.
  for (const [index, arg] of argv.entries()) {
    // Canonical workspace helpers travel as the source operand to `node -e`.
    // Treating JavaScript slash characters as host paths rejects the shipped scripts.
    if (index > 0 && argv[index - 1] === "-e" && path.basename(argv[0] ?? "") === "node") {
      continue;
    }
    const candidate = resolveArgumentPath(workspaceDir, arg);
    if (!candidate) {
      continue;
    }
    let resolved = candidate;
    try {
      resolved = fs.realpathSync.native(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    if (resolved !== workspaceDir && !isPathInside(workspaceDir, resolved)) {
      throw new Error("INVALID_REQUEST: workspace command argv resolves outside its workspace");
    }
  }
}

function projectWorkspaceResult(
  workspaceDir: string,
  result: Awaited<ReturnType<typeof runCommandWithTimeout>>,
): NodeWorkerWorkspaceExecResult {
  const projected = {
    workspaceDir,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    signal: result.signal,
    killed: result.killed,
    termination: result.termination,
    ...(result.stdoutTruncatedBytes === undefined
      ? {}
      : { stdoutTruncatedBytes: result.stdoutTruncatedBytes }),
    ...(result.stderrTruncatedBytes === undefined
      ? {}
      : { stderrTruncatedBytes: result.stderrTruncatedBytes }),
    ...(result.noOutputTimedOut === undefined ? {} : { noOutputTimedOut: result.noOutputTimedOut }),
    ...(result.outputLimitExceeded === undefined
      ? {}
      : { outputLimitExceeded: result.outputLimitExceeded }),
    ...(result.outputErrorStream === undefined
      ? {}
      : { outputErrorStream: result.outputErrorStream }),
  };
  const parsed = parseNodeWorkerWorkspaceExecResult(projected);
  if (!parsed) {
    throw new Error("node worker workspace result violated its bounded contract");
  }
  return parsed;
}

function buildAcceptedSnapshot(input: NodeWorkerWorkspaceRetainInput): AcceptedRetainSnapshot {
  const retainedGenerations = new Set<string>();
  const manifestsBySession = new Map<string, Set<string> | null>();
  for (const entry of input.retain) {
    const environmentHash = hashPathComponent(entry.environmentId, 16);
    const sessionHash = hashPathComponent(entry.sessionId, 32);
    retainedGenerations.add(
      workspaceGenerationKey({
        gatewayNamespace: input.gatewayNamespace,
        environmentHash,
        sessionHash,
        generation: entry.generation,
      }),
    );
    const sessionKey = workspaceSessionKey(environmentHash, sessionHash);
    const current = manifestsBySession.get(sessionKey);
    if (current === null || entry.manifestRefs === null) {
      manifestsBySession.set(sessionKey, null);
      continue;
    }
    const refs = current ?? new Set<string>();
    for (const manifestRef of entry.manifestRefs) {
      refs.add(manifestRef);
    }
    manifestsBySession.set(sessionKey, refs);
  }
  return {
    controllerId: input.controllerId,
    sequence: input.sequence,
    signature: JSON.stringify(input.retain),
    retainedGenerations,
    manifestsBySession,
  };
}

/** Runs trusted worker transport commands only from a node-owned session workspace. */
export class NodeWorkerWorkspaceRuntime {
  private readonly root: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly retainQueue = new KeyedAsyncQueue();
  private readonly acceptedSnapshots = new Map<string, AcceptedRetainSnapshot>();
  private readonly activeWorkspaceOperations = new Map<string, number>();
  private readonly latestTransferredManifest = new Map<string, string>();
  private readonly deletingWorkspaceGenerations = new Set<string>();
  private readonly activeRetainProtections = new Map<string, Set<Set<string>>>();

  constructor(options: { root?: string; env?: NodeJS.ProcessEnv } = {}) {
    const env = options.env ?? process.env;
    const configuredRoot = path.resolve(
      options.root ?? path.join(resolveStateDir(env), "node-host"),
    );
    fs.mkdirSync(configuredRoot, { recursive: true });
    this.root = fs.realpathSync.native(configuredRoot);
    this.env = {
      ...snapshotNodeWorkerEnv(env),
      GCM_INTERACTIVE: "Never",
      GIT_ASKPASS: "",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS: "",
    };
  }

  /** Claims an existing identity-derived workspace against concurrent retention. */
  acquireManagedWorkspace(request: NodeWorkerManagedWorkspaceRequest): {
    workspaceDir: string;
    release: () => void;
  } {
    const identity = resolveNodeManagedWorkspaceIdentity(this.root, request);
    if (this.deletingWorkspaceGenerations.has(identity.generationKey)) {
      throw new Error("INVALID_REQUEST: node placement workspace is being removed");
    }
    const finishOperation = this.beginWorkspaceOperation(
      identity.gatewayNamespace,
      identity.generationKey,
    );
    let released = false;
    return {
      workspaceDir: identity.workspaceDir,
      release: () => {
        if (!released) {
          released = true;
          finishOperation();
        }
      },
    };
  }

  private beginWorkspaceOperation(gatewayNamespace: string, generationKey: string): () => void {
    this.activeWorkspaceOperations.set(
      generationKey,
      (this.activeWorkspaceOperations.get(generationKey) ?? 0) + 1,
    );
    for (const protection of this.activeRetainProtections.get(gatewayNamespace) ?? []) {
      protection.add(generationKey);
    }
    return () => {
      const count = this.activeWorkspaceOperations.get(generationKey) ?? 0;
      if (count <= 1) {
        this.activeWorkspaceOperations.delete(generationKey);
      } else {
        this.activeWorkspaceOperations.set(generationKey, count - 1);
      }
    };
  }

  private currentLocalProtection(
    gatewayNamespace: string,
    retainedDuringPass: ReadonlySet<string>,
    listNonterminal: () => readonly NodeWorkerWorkspaceLaunchReference[],
  ): Set<string> {
    const protectedGenerations = new Set(retainedDuringPass);
    for (const generationKey of this.activeWorkspaceOperations.keys()) {
      if (generationKey.startsWith(`${gatewayNamespace}/`)) {
        protectedGenerations.add(generationKey);
      }
    }
    for (const launch of listNonterminal()) {
      if (launch.gatewayNamespace === gatewayNamespace) {
        protectedGenerations.add(launchGenerationKey(launch));
      }
    }
    return protectedGenerations;
  }

  private async listWorkspaceSessions(gatewayNamespace: string): Promise<WorkspaceSession[]> {
    const gatewayRoot = path.join(this.root, gatewayNamespace);
    const workspacesRoot = path.join(gatewayRoot, "workspaces");
    const sessions: WorkspaceSession[] = [];
    for (const environmentHash of await listOwnedDirectories(workspacesRoot)) {
      if (!ENVIRONMENT_HASH_PATTERN.test(environmentHash)) {
        continue;
      }
      const environmentRoot = path.join(workspacesRoot, environmentHash);
      for (const sessionHash of await listOwnedDirectories(environmentRoot)) {
        if (!SESSION_HASH_PATTERN.test(sessionHash)) {
          continue;
        }
        sessions.push({
          gatewayNamespace,
          environmentHash,
          sessionHash,
          workspacesRoot,
          environmentRoot,
          sessionRoot: path.join(environmentRoot, sessionHash),
        });
      }
    }
    return sessions;
  }

  async applyRetainSnapshot(
    input: NodeWorkerWorkspaceRetainInput,
    listNonterminal: () => readonly NodeWorkerWorkspaceLaunchReference[],
    signal?: AbortSignal,
  ): Promise<NodeWorkerWorkspaceRetainResult> {
    return await this.retainQueue.enqueue(input.gatewayNamespace, async () => {
      signal?.throwIfAborted();
      const next = buildAcceptedSnapshot(input);
      const current = this.acceptedSnapshots.get(input.gatewayNamespace);
      if (current?.controllerId === next.controllerId) {
        if (next.sequence < current.sequence) {
          return { applied: false, deleted: 0, hasMore: false };
        }
        if (next.sequence === current.sequence && next.signature !== current.signature) {
          throw new Error("INVALID_REQUEST: workspace retain sequence changed contents");
        }
      }
      this.acceptedSnapshots.set(input.gatewayNamespace, next);
      const retainedDuringPass = new Set<string>();
      for (const generationKey of this.activeWorkspaceOperations.keys()) {
        if (generationKey.startsWith(`${input.gatewayNamespace}/`)) {
          retainedDuringPass.add(generationKey);
        }
      }
      const protections = this.activeRetainProtections.get(input.gatewayNamespace) ?? new Set();
      protections.add(retainedDuringPass);
      this.activeRetainProtections.set(input.gatewayNamespace, protections);
      try {
        const result = await this.collectRetainedWorkspaceSnapshot({
          gatewayNamespace: input.gatewayNamespace,
          snapshot: next,
          retainedDuringPass,
          listNonterminal,
          signal,
        });
        return { applied: true, ...result };
      } finally {
        protections.delete(retainedDuringPass);
        if (protections.size === 0) {
          this.activeRetainProtections.delete(input.gatewayNamespace);
        }
      }
    });
  }

  private async collectRetainedWorkspaceSnapshot(params: {
    gatewayNamespace: string;
    snapshot: AcceptedRetainSnapshot;
    retainedDuringPass: ReadonlySet<string>;
    listNonterminal: () => readonly NodeWorkerWorkspaceLaunchReference[];
    signal?: AbortSignal;
  }): Promise<{ deleted: number; hasMore: boolean }> {
    let deleted = 0;
    let hasMore = false;
    for (const session of await this.listWorkspaceSessions(params.gatewayNamespace)) {
      params.signal?.throwIfAborted();
      await serializeNodeWorkerWorkspace(session.sessionRoot, async () => {
        const currentSnapshot = this.acceptedSnapshots.get(params.gatewayNamespace);
        if (
          currentSnapshot?.controllerId !== params.snapshot.controllerId ||
          currentSnapshot.sequence !== params.snapshot.sequence ||
          currentSnapshot.signature !== params.snapshot.signature
        ) {
          return;
        }
        const localProtection = this.currentLocalProtection(
          params.gatewayNamespace,
          params.retainedDuringPass,
          params.listNonterminal,
        );
        const entries = await listOwnedEntries(session.sessionRoot);
        const existingGenerations = new Set<number>();
        for (const entry of entries) {
          const generation = parseGenerationName(entry.name);
          if (generation !== undefined && entry.isDirectory() && !entry.isSymbolicLink()) {
            existingGenerations.add(generation);
          }
        }
        const candidates: Array<{ path: string; generationKey: string }> = [];
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) {
            continue;
          }
          const generation = parseGenerationName(entry.name);
          const artifactGeneration = parseTransferArtifactGeneration(entry.name);
          if (generation !== undefined) {
            const key = workspaceGenerationKey({ ...session, generation });
            if (!currentSnapshot.retainedGenerations.has(key) && !localProtection.has(key)) {
              candidates.push({
                path: path.join(session.sessionRoot, entry.name),
                generationKey: key,
              });
            }
            continue;
          }
          if (artifactGeneration === undefined) {
            continue;
          }
          const key = workspaceGenerationKey({ ...session, generation: artifactGeneration });
          const retainedTargetMissing =
            currentSnapshot.retainedGenerations.has(key) &&
            !existingGenerations.has(artifactGeneration);
          if (!localProtection.has(key) && !retainedTargetMissing) {
            candidates.push({
              path: path.join(session.sessionRoot, entry.name),
              generationKey: key,
            });
          }
        }
        for (const candidate of candidates) {
          if (deleted >= WORKSPACE_RETENTION_DELETE_LIMIT) {
            hasMore = true;
            return;
          }
          // A launch or workspace command can claim this generation while filesystem reads await.
          if (
            this.currentLocalProtection(
              params.gatewayNamespace,
              params.retainedDuringPass,
              params.listNonterminal,
            ).has(candidate.generationKey)
          ) {
            continue;
          }
          if (
            await removeOwnedDirectory(this.root, candidate.path, () => {
              if (
                this.currentLocalProtection(
                  params.gatewayNamespace,
                  params.retainedDuringPass,
                  params.listNonterminal,
                ).has(candidate.generationKey)
              ) {
                return false;
              }
              // No claim may begin after this final check and before recursive removal settles.
              this.deletingWorkspaceGenerations.add(candidate.generationKey);
              return true;
            }).finally(() => this.deletingWorkspaceGenerations.delete(candidate.generationKey))
          ) {
            deleted += 1;
            if (parseGenerationName(path.basename(candidate.path)) !== undefined) {
              this.latestTransferredManifest.delete(candidate.generationKey);
            }
          }
        }
        const sessionPrefix = `${params.gatewayNamespace}/${session.environmentHash}/${session.sessionHash}/`;
        const hasCurrentLocalProtection = () =>
          [
            ...this.currentLocalProtection(
              params.gatewayNamespace,
              params.retainedDuringPass,
              params.listNonterminal,
            ),
          ].some((key) => key.startsWith(sessionPrefix));
        const hasLocalProtection = hasCurrentLocalProtection();
        const retainedManifestRefs = currentSnapshot.manifestsBySession.get(
          workspaceSessionKey(session.environmentHash, session.sessionHash),
        );
        if (!hasLocalProtection && retainedManifestRefs !== null) {
          const reachable = new Set(retainedManifestRefs);
          for (const generation of existingGenerations) {
            const latest = this.latestTransferredManifest.get(
              workspaceGenerationKey({ ...session, generation }),
            );
            if (latest) {
              reachable.add(latest);
            }
          }
          const manifestRoot = path.join(session.sessionRoot, ".openclaw-worker", "manifests");
          for (const entry of await listOwnedEntries(manifestRoot)) {
            if (
              !entry.isFile() ||
              entry.isSymbolicLink() ||
              !MANIFEST_FILE_PATTERN.test(entry.name) ||
              reachable.has(`sha256:${entry.name.slice(0, -5)}`)
            ) {
              continue;
            }
            if (deleted >= WORKSPACE_RETENTION_DELETE_LIMIT) {
              hasMore = true;
              return;
            }
            if (
              await removeOwnedFile(
                this.root,
                path.join(manifestRoot, entry.name),
                () => !hasCurrentLocalProtection(),
              )
            ) {
              deleted += 1;
            }
          }
          await removeIfEmpty(manifestRoot);
          await removeIfEmpty(path.dirname(manifestRoot));
        }
        const remaining = await listOwnedEntries(session.sessionRoot);
        const hasGenerationOrArtifact = remaining.some(
          (entry) =>
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            (parseGenerationName(entry.name) !== undefined ||
              parseTransferArtifactGeneration(entry.name) !== undefined),
        );
        const hasAuthoritativeRetain = [...currentSnapshot.retainedGenerations].some((key) =>
          key.startsWith(sessionPrefix),
        );
        if (!hasGenerationOrArtifact && !hasAuthoritativeRetain && !hasCurrentLocalProtection()) {
          const metadataRoot = path.join(session.sessionRoot, ".openclaw-worker");
          if (deleted >= WORKSPACE_RETENTION_DELETE_LIMIT) {
            hasMore = true;
            return;
          }
          if (
            await removeOwnedDirectory(this.root, metadataRoot, () => !hasCurrentLocalProtection())
          ) {
            deleted += 1;
          }
          await removeIfEmpty(session.sessionRoot);
          await removeIfEmpty(session.environmentRoot);
          await removeIfEmpty(session.workspacesRoot);
        }
      });
      if (hasMore) {
        break;
      }
    }
    return { deleted, hasMore };
  }

  async exec(
    input: NodeWorkerWorkspaceExecInput,
    signal?: AbortSignal,
    gateway?: NodeWorkerTransferGateway,
  ): Promise<NodeWorkerWorkspaceExecResult> {
    const environmentHash = hashPathComponent(input.environmentId, 16);
    const sessionHash = hashPathComponent(input.sessionId, 32);
    const sessionRootCandidate = path.join(
      this.root,
      input.gatewayNamespace,
      "workspaces",
      environmentHash,
      sessionHash,
    );
    const generationKey = workspaceGenerationKey({
      gatewayNamespace: input.gatewayNamespace,
      environmentHash,
      sessionHash,
      generation: input.generation,
    });
    const finishOperation = this.beginWorkspaceOperation(input.gatewayNamespace, generationKey);
    try {
      return await serializeNodeWorkerWorkspace(sessionRootCandidate, async () => {
        const gatewayRoot = ensureContainedDirectory(this.root, input.gatewayNamespace);
        const workspacesRoot = ensureContainedDirectory(gatewayRoot, "workspaces");
        const environmentRoot = ensureContainedDirectory(workspacesRoot, environmentHash);
        const sessionRoot = ensureContainedDirectory(environmentRoot, sessionHash);
        const workspaceName = String(input.generation);
        const workspacePath = path.join(sessionRoot, workspaceName);
        if (input.transfer || input.resetWorkspace) {
          try {
            const stats = fs.lstatSync(workspacePath);
            const resolved = fs.realpathSync.native(workspacePath);
            if (
              stats.isSymbolicLink() ||
              !stats.isDirectory() ||
              !isPathInside(sessionRoot, resolved)
            ) {
              throw new Error("INVALID_REQUEST: node worker workspace path escaped its owner root");
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
          }
        }
        if (input.transfer) {
          if (input.resetWorkspace) {
            throw new Error("INVALID_REQUEST: workspace transfer owns its atomic replacement");
          }
          if (!gateway?.url) {
            throw new Error("INVALID_REQUEST: workspace transfer gateway is unavailable");
          }
          const stdout = await runNodeWorkerWorkspaceTransfer({
            gatewayUrl: gateway.url,
            gatewayTlsFingerprint: gateway.tlsFingerprint,
            gatewayCloudflareAccess: gateway.cloudflareAccess,
            environmentId: input.environmentId,
            workspaceDir: workspacePath,
            manifestHome: sessionRoot,
            transfer: input.transfer,
            signal,
          });
          // A snapshot sent before this transfer knows only the old base. Keep the latest
          // result across command gaps; supersede it on transfer or drop it with its generation.
          this.latestTransferredManifest.set(generationKey, stdout);
          return projectWorkspaceResult(workspacePath, {
            stdout: `${stdout}\n`,
            stderr: "",
            code: 0,
            signal: null,
            killed: false,
            termination: "exit",
          });
        }
        if (input.resetWorkspace) {
          // Reset never accepts a caller path: only the identity-derived workspace can be removed.
          fs.rmSync(workspacePath, { recursive: true, force: true });
        }
        const workspaceDir = ensureContainedDirectory(sessionRoot, workspaceName);
        assertWorkspaceArgv(workspaceDir, input.argv);
        const commandEnv = {
          ...this.env,
          HOME: sessionRoot,
          ...(process.platform === "win32" ? { USERPROFILE: sessionRoot } : {}),
        };
        const result = await runCommandWithTimeout(input.argv, {
          cwd: workspaceDir,
          baseEnv: commandEnv,
          ...(input.input === undefined ? {} : { input: input.input }),
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
          killProcessTree: true,
          maxOutputBytes: {
            stdout: NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES,
            stderr: NODE_WORKER_WORKSPACE_STDERR_MAX_BYTES,
          },
          terminateOnOutputLimit: true,
        });
        return projectWorkspaceResult(workspaceDir, result);
      });
    } finally {
      finishOperation();
    }
  }
}
