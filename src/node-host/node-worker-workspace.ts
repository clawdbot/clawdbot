import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isPathInside } from "../infra/path-guards.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import type {
  NodeWorkerPreparedWorkspaceInput,
  NodeWorkerPreparedWorkspaceResult,
} from "../worker/node-workspace-prepared-protocol.js";
import type {
  NodeWorkerWorkspaceExecInput,
  NodeWorkerWorkspaceExecResult,
} from "../worker/node-workspace-protocol.js";
import type {
  NodeWorkerWorkspaceRetainInput,
  NodeWorkerWorkspaceRetainResult,
} from "../worker/node-workspace-retain-protocol.js";
import { parseWorkerSkillResourceGeneration } from "../worker/skill-resource-protocol.js";
import { snapshotNodeWorkerEnv } from "./node-worker-environment.js";
import { NodeWorkerPreparedWorkspaceStore } from "./node-worker-prepared-workspace-store.js";
import { prepareNodeWorkerWorkspace } from "./node-worker-prepared-workspace.js";
import {
  type NodeWorkerTransferGateway,
  serializeNodeWorkerWorkspace,
} from "./node-worker-transfer-client.js";
import {
  execNodeWorkerWorkspace,
  ensureNodeWorkerWorkspaceDirectory,
  removeNodeWorkerWorkspaceDirectory,
} from "./node-worker-workspace-exec.js";
import {
  hashNodeWorkerWorkspaceComponent as hashPathComponent,
  nodeWorkerWorkspaceGenerationKey as workspaceGenerationKey,
  nodeWorkerWorkspaceLaunchGenerationKey as launchGenerationKey,
  nodeWorkerWorkspaceSessionKey as workspaceSessionKey,
  parseNodeWorkerWorkspaceGeneration as parseGenerationName,
  parseNodeWorkerWorkspaceTransferGeneration as parseTransferArtifactGeneration,
  resolveNodeManagedWorkspaceIdentity,
  resolveNodePreparedWorkspaceIdentity,
  type NodeWorkerManagedWorkspaceRequest,
} from "./node-worker-workspace-identity.js";

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
  private readonly seedsRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly preparedRoot: string;
  private readonly prepared?: NodeWorkerPreparedWorkspaceStore;
  private readonly retainQueue = new KeyedAsyncQueue();
  private readonly acceptedSnapshots = new Map<string, AcceptedRetainSnapshot>();
  private readonly activeWorkspaceOperations = new Map<string, number>();
  private readonly latestTransferredManifest = new Map<string, string>();
  // Registration hashes move from their prepared owner root to the bound generation.
  private readonly workspaceHashMemos = new Map<string, Map<string, string>>();
  private readonly deletingWorkspaceGenerations = new Set<string>();
  private readonly activeRetainProtections = new Map<string, Set<Set<string>>>();

  constructor(options: { root?: string; env?: NodeJS.ProcessEnv; ephemeral?: boolean } = {}) {
    const env = options.env ?? process.env;
    const configuredRoot = path.resolve(
      options.root ?? path.join(resolveStateDir(env), "node-host"),
    );
    fs.mkdirSync(configuredRoot, { recursive: true });
    this.root = fs.realpathSync.native(configuredRoot);
    // Git artifacts are machine caches, outside the per-lease state scrub boundary.
    const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
    this.seedsRoot = path.resolve(home, ".openclaw-worker", "git-seeds");
    this.preparedRoot = path.resolve(
      options.ephemeral ? fs.realpathSync.native(home) : home,
      ".openclaw-worker",
      "prepared",
    );
    if (options.ephemeral) {
      this.prepared = new NodeWorkerPreparedWorkspaceStore({ env });
    }
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

  /** Only the fresh provisioning owner may register, before Gateway readiness is committed. */
  async prepare(
    input: NodeWorkerPreparedWorkspaceInput,
    signal?: AbortSignal,
  ): Promise<NodeWorkerPreparedWorkspaceResult> {
    if (!this.prepared) {
      throw new Error("INVALID_REQUEST: prepared workspaces require a dedicated ephemeral node");
    }
    return await prepareNodeWorkerWorkspace(
      this.preparedRoot,
      this.prepared,
      input,
      this.workspaceHashMemos,
      signal,
    );
  }

  acquirePreparedWorkspace(
    request: Omit<NodeWorkerManagedWorkspaceRequest, "sessionKey"> & { sessionKey?: string },
  ) {
    if (!this.prepared?.find(request.environmentId)) {
      if (isPathInside(this.preparedRoot, request.workspaceDir)) {
        throw new Error("INVALID_REQUEST: prepared workspace binding is missing");
      }
      return undefined;
    }
    if (!request.sessionKey) {
      throw new Error("INVALID_REQUEST: prepared workspace acquisition requires its bound session");
    }
    return this.acquireManagedWorkspace({ ...request, sessionKey: request.sessionKey });
  }

  /** Claims an existing identity-derived workspace against concurrent retention. */
  acquireManagedWorkspace(request: NodeWorkerManagedWorkspaceRequest): {
    workspaceDir: string;
    homeDir?: string;
    release: () => void;
  } {
    const prepared = this.prepared?.find(request.environmentId);
    const identity = prepared
      ? resolveNodePreparedWorkspaceIdentity(this.preparedRoot, prepared, request)
      : resolveNodeManagedWorkspaceIdentity(this.root, request);
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
      ...(prepared ? { homeDir: prepared.home_dir } : {}),
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
    let deleted = await this.collectPreparedWorkspaces(params);
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
          // Skill bundles live until their generation retires, including between commands;
          // transfer scratch directories below have a shorter replacement lifecycle.
          const generation =
            parseGenerationName(entry.name) ?? parseWorkerSkillResourceGeneration(entry.name);
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
            await removeNodeWorkerWorkspaceDirectory(this.root, candidate.path, () => {
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
              this.workspaceHashMemos.delete(candidate.generationKey);
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
              parseWorkerSkillResourceGeneration(entry.name) !== undefined ||
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
            await removeNodeWorkerWorkspaceDirectory(
              this.root,
              metadataRoot,
              () => !hasCurrentLocalProtection(),
            )
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

  private async collectPreparedWorkspaces(params: {
    gatewayNamespace: string;
    snapshot: AcceptedRetainSnapshot;
    retainedDuringPass: ReadonlySet<string>;
    listNonterminal: () => readonly NodeWorkerWorkspaceLaunchReference[];
    signal?: AbortSignal;
  }): Promise<number> {
    const store = this.prepared;
    if (!store) {
      return 0;
    }
    let deleted = 0;
    for (const row of store.list(params.gatewayNamespace)) {
      if (row.state === "available" || row.state === "retired") {
        continue;
      }
      if (!row.session_id || !row.session_key || row.owner_epoch === null) {
        throw new Error("INVALID_REQUEST: prepared workspace has invalid retirement ownership");
      }
      const generationKey = launchGenerationKey({
        gatewayNamespace: row.gateway_namespace,
        environmentId: row.environment_id,
        sessionId: row.session_id,
        ownerEpoch: row.owner_epoch,
      });
      const isProtected = () =>
        params.snapshot.retainedGenerations.has(generationKey) ||
        this.currentLocalProtection(
          params.gatewayNamespace,
          params.retainedDuringPass,
          params.listNonterminal,
        ).has(generationKey);
      if (isProtected()) {
        continue;
      }
      const ownerRoot = path.join(this.preparedRoot, row.gateway_namespace, row.cache_key);
      await serializeNodeWorkerWorkspace(ownerRoot, async () => {
        params.signal?.throwIfAborted();
        if (isProtected()) {
          return;
        }
        // Retain passes serialize. Fence new claims before filesystem awaits;
        // a later retain cannot reopen this durable retirement tombstone.
        const retiring = store.retire(row);
        this.deletingWorkspaceGenerations.add(generationKey);
        try {
          const removed = await removeNodeWorkerWorkspaceDirectory(this.preparedRoot, ownerRoot);
          if (!removed) {
            try {
              await fsp.lstat(ownerRoot);
              throw new Error("INVALID_REQUEST: prepared workspace retirement path is not owned");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
              }
            }
          }
          store.retire(retiring, true);
          this.latestTransferredManifest.delete(generationKey);
          this.workspaceHashMemos.delete(generationKey);
          deleted += Number(removed);
        } finally {
          this.deletingWorkspaceGenerations.delete(generationKey);
        }
      });
    }
    return deleted;
  }

  async exec(
    input: NodeWorkerWorkspaceExecInput,
    signal?: AbortSignal,
    gateway?: NodeWorkerTransferGateway,
  ): Promise<NodeWorkerWorkspaceExecResult> {
    const environmentHash = hashPathComponent(input.environmentId, 16);
    const sessionHash = hashPathComponent(input.sessionId, 32);
    const registered = this.prepared?.find(input.environmentId);
    const sessionRootCandidate = registered
      ? path.dirname(registered.workspace_dir)
      : path.join(this.root, input.gatewayNamespace, "workspaces", environmentHash, sessionHash);
    const generationKey = workspaceGenerationKey({
      gatewayNamespace: input.gatewayNamespace,
      environmentHash,
      sessionHash,
      generation: input.generation,
    });
    if (this.deletingWorkspaceGenerations.has(generationKey)) {
      throw new Error("INVALID_REQUEST: node placement workspace is being removed");
    }
    const finishOperation = this.beginWorkspaceOperation(input.gatewayNamespace, generationKey);
    try {
      return await serializeNodeWorkerWorkspace(sessionRootCandidate, async () => {
        signal?.throwIfAborted();
        const prepared = this.prepared?.find(input.environmentId);
        if (
          input.preparationKey !== undefined &&
          prepared?.preparation_key !== input.preparationKey
        ) {
          throw new Error("INVALID_REQUEST: prepared workspace registration is missing or changed");
        }
        let sessionRoot: string;
        let workspacePath: string;
        if (prepared) {
          if (prepared.gateway_namespace !== input.gatewayNamespace || !input.sessionKey) {
            throw new Error(
              "INVALID_REQUEST: prepared workspace command requires its bound session",
            );
          }
          const identity = resolveNodePreparedWorkspaceIdentity(this.preparedRoot, prepared, {
            workspaceDir: prepared.workspace_dir,
            environmentId: input.environmentId,
            sessionId: input.sessionId,
            sessionKey: input.sessionKey,
            ownerEpoch: input.generation,
          });
          workspacePath = identity.workspaceDir;
          sessionRoot = path.dirname(workspacePath);
        } else {
          if (registered) {
            throw new Error("INVALID_REQUEST: prepared workspace registration disappeared");
          }
          const gatewayRoot = ensureNodeWorkerWorkspaceDirectory(this.root, input.gatewayNamespace);
          const workspacesRoot = ensureNodeWorkerWorkspaceDirectory(gatewayRoot, "workspaces");
          const environmentRoot = ensureNodeWorkerWorkspaceDirectory(
            workspacesRoot,
            environmentHash,
          );
          sessionRoot = ensureNodeWorkerWorkspaceDirectory(environmentRoot, sessionHash);
          workspacePath = path.join(sessionRoot, String(input.generation));
        }
        return await execNodeWorkerWorkspace({
          input,
          root: this.root,
          sessionRoot,
          workspacePath,
          generationKey,
          seedsRoot: this.seedsRoot,
          env: this.env,
          workspaceHashMemos: this.workspaceHashMemos,
          latestTransferredManifest: this.latestTransferredManifest,
          ...(prepared && this.prepared
            ? { prepared: { row: prepared, store: this.prepared } }
            : {}),
          signal,
          gateway,
        });
      });
    } finally {
      finishOperation();
    }
  }
}
