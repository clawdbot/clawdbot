import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getSessionRepositoryWorkspaceStore,
  type SessionRepositoryWorkspaceRecord,
  type SessionRepositoryWorkspaceStore,
} from "../../state/session-repository-workspaces.js";
import {
  readGitHubRepositoryPublicationBlob,
  readGitHubRepositoryPublicationMetadata,
} from "../github-repository-publication-snapshot.js";
import { boundedWorkerError } from "./worker-error.js";
import {
  MAX_RECONCILIATION_TOTAL_BYTES,
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile-core.js";
import {
  requireWorkspaceResultGit,
  withWorkspaceResultRefMutation,
} from "./workspace-result-git.js";
import {
  deleteStagedWorkerWorkspaceResult,
  preparedWorkerWorkspaceResultRef,
  readStagedWorkerWorkspaceResult,
  withStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

type CheckpointOwner = { workspaceId: string; store?: SessionRepositoryWorkspaceStore };
type CheckpointSource = CheckpointOwner & { checkpointRef?: string };
type CheckpointSnapshot = Awaited<ReturnType<typeof readStagedWorkerWorkspaceResult>>;
export type SessionRepositoryCheckpointPayload = CheckpointSnapshot & {
  stagingRoot: string;
  publicationStagingRoot?: string;
  publicationDigest?: string;
};
const digest = (raw: string) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
const publicationRef = (ref: string) =>
  workerWorkspaceResultRef(`publication-${createHash("sha256").update(ref).digest("hex")}`);
const workspaceLog = createSubsystemLogger("gateway/worker-workspace");

function owner(params: CheckpointOwner) {
  const store = params.store ?? getSessionRepositoryWorkspaceStore();
  const workspace = store.get(params.workspaceId);
  if (!workspace) {
    throw new Error("Repository workspace no longer exists");
  }
  return { store, workspace, root: store.artifactPath(params.workspaceId) };
}

function checkpointRef(workspace: SessionRepositoryWorkspaceRecord, ref?: string): string {
  const selected = ref ?? workspace.checkpointRef;
  if (!selected || !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(selected)) {
    throw new Error("Repository workspace has no valid checkpoint");
  }
  return selected;
}

function assertBase(
  workspace: SessionRepositoryWorkspaceRecord,
  snapshot: Pick<CheckpointSnapshot, "base" | "current" | "baseManifestRef">,
) {
  if (
    !workspace.baseCommit ||
    snapshot.base.baseCommit !== workspace.baseCommit ||
    snapshot.current.baseCommit !== workspace.baseCommit ||
    snapshot.baseManifestRef !== workspace.baseManifestHash
  ) {
    throw new Error("Repository checkpoint does not match its pinned base");
  }
  return workspace.baseCommit;
}

async function refObject(
  root: string,
  ref: string,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const output = await requireWorkspaceResultGit(
    root,
    ["for-each-ref", "--format=%(refname) %(objectname)", ref],
    { baseEnv },
  );
  return output
    .split("\n")
    .find((line) => line.startsWith(`${ref} `))
    ?.slice(ref.length + 1);
}

export async function readSessionRepositoryCheckpoint(params: CheckpointSource) {
  const { workspace, root } = owner(params);
  const ref = checkpointRef(workspace, params.checkpointRef);
  const snapshot = await readStagedWorkerWorkspaceResult(root, ref);
  assertBase(workspace, snapshot);
  if (ref === workspace.checkpointRef && snapshot.currentManifestRef !== workspace.manifestHash) {
    throw new Error("Repository checkpoint differs from its accepted manifest");
  }
  return { ...snapshot, checkpointRef: ref };
}

async function publicationBinding(root: string, currentManifestRef: string) {
  const raw = await fs.readFile(path.join(root, "binding.json"), "utf8");
  const binding: unknown = JSON.parse(raw);
  if (
    !isRecord(binding) ||
    binding.currentManifestRef !== currentManifestRef ||
    typeof binding.publicationDigest !== "string"
  ) {
    throw new Error("Repository publication checkpoint binding changed");
  }
  const { snapshot } = await readGitHubRepositoryPublicationMetadata(
    root,
    binding.publicationDigest,
  );
  return { publicationDigest: binding.publicationDigest, snapshot };
}

export async function withSessionRepositoryCheckpoint<T>(
  params: CheckpointSource & { includePublication?: boolean },
  use: (snapshot: SessionRepositoryCheckpointPayload) => Promise<T>,
): Promise<T> {
  const { workspace, root } = owner(params);
  const ref = checkpointRef(workspace, params.checkpointRef);
  return await withStagedWorkerWorkspaceResult({ root, stagedResultRef: ref }, async (snapshot) => {
    assertBase(workspace, snapshot);
    if (ref === workspace.checkpointRef && snapshot.currentManifestRef !== workspace.manifestHash) {
      throw new Error("Repository checkpoint differs from its accepted manifest");
    }
    if (!params.includePublication) {
      return await use(snapshot);
    }
    let useStarted = false;
    try {
      const companion = publicationRef(ref);
      if (!(await refObject(root, companion))) {
        useStarted = true;
        return await use(snapshot);
      }
      return await withStagedWorkerWorkspaceResult(
        { root, stagedResultRef: companion },
        async (publication) => {
          const binding = await publicationBinding(
            publication.stagingRoot,
            snapshot.currentManifestRef,
          );
          if (binding.snapshot.baseCommit !== workspace.baseCommit) {
            throw new Error("Repository publication checkpoint base changed");
          }
          useStarted = true;
          return await use({
            ...snapshot,
            publicationStagingRoot: publication.stagingRoot,
            publicationDigest: binding.publicationDigest,
          });
        },
      );
    } catch (error) {
      // Optional publication corruption cannot discard verified recovery bytes.
      // Once the consumer starts, its failures and effects must propagate unchanged.
      if (useStarted) {
        throw error;
      }
      workspaceLog.warn(
        `Repository publication checkpoint unavailable: ${boundedWorkerError(error)}`,
      );
      return await use(snapshot);
    }
  });
}

async function stagePublication(params: {
  root: string;
  candidateRef: string;
  publicationStagingRoot: string;
  publicationDigest: string;
  currentManifestRef: string;
  baseCommit: string;
}) {
  const { raw: metadata, snapshot } = await readGitHubRepositoryPublicationMetadata(
    params.publicationStagingRoot,
    params.publicationDigest,
  );
  if (snapshot.baseCommit !== params.baseCommit) {
    throw new Error("Repository publication checkpoint base changed");
  }
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-publication-payload-"));
  try {
    await fs.mkdir(path.join(stagingRoot, "blobs"), { mode: 0o700 });
    await fs.writeFile(path.join(stagingRoot, "snapshot.json"), metadata, { mode: 0o600 });
    await fs.writeFile(
      path.join(stagingRoot, "binding.json"),
      JSON.stringify({
        currentManifestRef: params.currentManifestRef,
        publicationDigest: params.publicationDigest,
      }),
      { mode: 0o600 },
    );
    let bytes = Buffer.byteLength(metadata);
    const blobs = new Set(
      snapshot.entries
        .filter((entry) => entry.sha && entry.mode !== "160000")
        .map((entry) => entry.sha!),
    );
    for (const sha of blobs) {
      const content = await readGitHubRepositoryPublicationBlob(params.publicationStagingRoot, sha);
      bytes += content.byteLength;
      if (bytes > MAX_RECONCILIATION_TOTAL_BYTES) {
        throw new Error("Repository publication checkpoint exceeds its byte budget");
      }
      await fs.writeFile(path.join(stagingRoot, "blobs", sha), content, { mode: 0o600 });
    }
    const baseManifestRaw = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: null,
      entries: [],
    });
    const current = await readActualWorkspaceManifest({ root: stagingRoot, baseCommit: null });
    const currentManifestRaw = serializeWorkerWorkspaceManifest(current.manifest);
    await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
      root: params.root,
      stagingRoot,
      stagedResultRef: params.candidateRef,
      baseManifestRaw,
      baseManifestRef: digest(baseManifestRaw),
      currentManifestRaw,
      currentManifestRef: current.manifestRef,
    });
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function recoverSessionRepositoryCheckpoint(
  params: CheckpointOwner & {
    checkpointRef: string;
    expectedRevision?: number;
    assertCurrent: () => void;
  },
): Promise<SessionRepositoryWorkspaceRecord> {
  const { store, workspace } = owner(params);
  const snapshot = await readSessionRepositoryCheckpoint(params);
  params.assertCurrent();
  const current = store.get(params.workspaceId);
  if (
    current?.checkpointRef === params.checkpointRef &&
    current.manifestHash === snapshot.currentManifestRef
  ) {
    return current;
  }
  return store.acceptCheckpoint({
    workspaceId: params.workspaceId,
    expectedRevision: params.expectedRevision ?? workspace.revision,
    checkpointRef: params.checkpointRef,
    manifestHash: snapshot.currentManifestRef,
    assertCurrent: params.assertCurrent,
  });
}

export async function stageSessionRepositoryCheckpoint(
  params: CheckpointOwner & {
    expectedRevision: number;
    checkpointRef?: string;
    stagingRoot: string;
    baseManifestRaw: string;
    currentManifestRaw: string;
    baseManifestRef: string;
    currentManifestRef: string;
    publicationStagingRoot?: string;
    publicationDigest?: string;
    assertCurrent: () => void;
  },
) {
  const { store, workspace, root } = owner(params);
  params.assertCurrent();
  const ref = checkpointRef(
    workspace,
    params.checkpointRef ?? workerWorkspaceResultRef(randomUUID()),
  );
  const candidateRef = preparedWorkerWorkspaceResultRef(workerWorkspaceResultRef(randomUUID()));
  const companionCandidate = preparedWorkerWorkspaceResultRef(
    workerWorkspaceResultRef(randomUUID()),
  );
  const base = parseWorkerWorkspaceManifest(params.baseManifestRaw, params.baseManifestRef);
  const current = parseWorkerWorkspaceManifest(
    params.currentManifestRaw,
    params.currentManifestRef,
  );
  const baseCommit = assertBase(workspace, {
    base,
    current,
    baseManifestRef: params.baseManifestRef,
  });
  const assertRevision = () => {
    params.assertCurrent();
    const latest = store.get(params.workspaceId);
    if (
      !latest ||
      (latest.revision !== params.expectedRevision &&
        !(latest.checkpointRef === ref && latest.manifestHash === params.currentManifestRef))
    ) {
      throw new Error("Repository workspace revision changed");
    }
  };
  assertRevision();
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await requireWorkspaceResultGit(root, ["init", "--quiet", "--bare", "--object-format=sha1"]);
  const discard = async () => {
    await deleteStagedWorkerWorkspaceResult({ root, stagedResultRef: candidateRef });
    await deleteStagedWorkerWorkspaceResult({ root, stagedResultRef: companionCandidate });
  };
  try {
    await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
      ...params,
      root,
      stagedResultRef: candidateRef,
    });
    let companionId: string | undefined;
    if (params.publicationStagingRoot || params.publicationDigest) {
      try {
        if (!params.publicationStagingRoot || !params.publicationDigest) {
          throw new Error("Repository publication checkpoint is incomplete");
        }
        await stagePublication({
          root,
          candidateRef: companionCandidate,
          publicationStagingRoot: params.publicationStagingRoot,
          publicationDigest: params.publicationDigest,
          currentManifestRef: params.currentManifestRef,
          baseCommit,
        });
        companionId = await requireWorkspaceResultGit(root, [
          "rev-parse",
          `${companionCandidate}^{commit}`,
        ]);
      } catch (error) {
        // A rejected publication payload cannot discard independently validated
        // recovery bytes. Remove only its candidate, then recheck live authority.
        await deleteStagedWorkerWorkspaceResult({ root, stagedResultRef: companionCandidate });
        assertRevision();
        workspaceLog.warn(
          `Repository publication checkpoint unavailable: ${boundedWorkerError(error)}`,
        );
      }
    }
    const objectId = await requireWorkspaceResultGit(root, [
      "rev-parse",
      `${candidateRef}^{commit}`,
    ]);
    const verify = async () => {
      if (
        (await requireWorkspaceResultGit(root, ["rev-parse", `${candidateRef}^{commit}`])) !==
        objectId
      ) {
        throw new Error("Repository checkpoint preparation changed");
      }
      if (
        companionId &&
        (await requireWorkspaceResultGit(root, ["rev-parse", `${companionCandidate}^{commit}`])) !==
          companionId
      ) {
        throw new Error("Repository publication preparation changed");
      }
      assertRevision();
    };
    await verify();
    return {
      checkpointRef: ref,
      verify,
      discard,
      publish: async () => {
        await withWorkspaceResultRefMutation(root, async (baseEnv) => {
          const updates: string[] = [];
          for (const [target, expected] of [
            [ref, objectId],
            [publicationRef(ref), companionId],
          ] as const) {
            const existing = await refObject(root, target, baseEnv);
            if (existing !== undefined && existing !== expected) {
              throw new Error("Repository checkpoint identity already contains a different result");
            }
            if (expected !== undefined && existing === undefined) {
              updates.push(`create ${target}\0${expected}\0`);
            }
          }
          assertRevision();
          if (updates.length) {
            await requireWorkspaceResultGit(root, ["update-ref", "--stdin", "-z"], {
              input: Buffer.from(updates.join("")),
              baseEnv,
            });
          }
        });
        // Publish immutable artifacts before the SQLite pointer: if the commit
        // fence fails or the Gateway exits, the pending turn can recover this ref.
        const accepted = await recoverSessionRepositoryCheckpoint({
          ...params,
          store,
          checkpointRef: ref,
        });
        await discard();
        return accepted;
      },
    };
  } catch (error) {
    await discard();
    throw error;
  }
}

export async function forkSessionRepositoryWorkspace(params: {
  sourceWorkspaceId: string;
  agentId: string;
  sessionKey: string;
  assertCurrent: () => void;
  store?: SessionRepositoryWorkspaceStore;
}): Promise<SessionRepositoryWorkspaceRecord> {
  const store = params.store ?? getSessionRepositoryWorkspaceStore();
  const source = owner({ workspaceId: params.sourceWorkspaceId, store }).workspace;
  const existing = store.find(params);
  if (existing !== undefined) {
    throw new Error("Fork session already owns a repository workspace");
  }
  let target = store.create({
    ...params,
    url: source.url,
    requestedRef: source.requestedRef ?? undefined,
    runSetupScript: source.runSetupScript,
  });
  try {
    if (source.baseCommit) {
      target = store.bindBase({
        workspaceId: target.workspaceId,
        expectedRevision: target.revision,
        baseCommit: source.baseCommit,
        baseManifestHash: source.baseManifestHash ?? undefined,
        assertCurrent: params.assertCurrent,
      });
    }
    if (source.checkpointRef) {
      target = await withSessionRepositoryCheckpoint(
        { workspaceId: source.workspaceId, store, includePublication: true },
        async (snapshot) => {
          const prepared = await stageSessionRepositoryCheckpoint({
            ...snapshot,
            store,
            workspaceId: target.workspaceId,
            expectedRevision: target.revision,
            assertCurrent: params.assertCurrent,
          });
          try {
            return await prepared.publish();
          } finally {
            await prepared.discard();
          }
        },
      );
    }
    return target;
  } catch (error) {
    // This unexposed owner belongs exclusively to this failed fork operation.
    await store.delete({ workspaceId: target.workspaceId, assertCurrent: () => {} });
    throw error;
  }
}
