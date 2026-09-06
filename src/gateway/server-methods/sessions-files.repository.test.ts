import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
import { invokeNodeWorkerSupervisorCommand } from "../../node-host/node-worker-supervisor-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
} from "../../worker/node-workspace-protocol.js";
import { WORKSPACE_INSPECTION_COMMAND } from "../../worker/workspace-inspection-protocol.js";
import {
  readGitHubRepositoryPublicationBlob,
  readGitHubRepositoryPublicationMetadata,
  REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
} from "../github-repository-publication-snapshot.js";
import { nodeWorkerGatewayNamespace } from "../worker-environments/node-worker-gateway-namespace.js";
import { createNodeWorkerTunnelManager } from "../worker-environments/node-worker-tunnel.js";
import {
  BUILD,
  environment,
  transport,
  workspaceTransfer,
} from "../worker-environments/node-worker-tunnel.test-support.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { createRepositoryWorkspaceMutationService } from "../worker-environments/repository-workspace-mutation.js";
import type { WorkerEnvironmentService } from "../worker-environments/service.js";
import {
  readSessionRepositoryCheckpoint,
  stageSessionRepositoryCheckpoint,
  withSessionRepositoryCheckpoint,
} from "../worker-environments/session-repository-checkpoints.js";
import type {
  WorkerWorkspaceCommand,
  WorkerWorkspaceReconcileRequest,
} from "../worker-environments/tunnel-contract.js";
import { serializeWorkerWorkspaceManifest } from "../worker-environments/workspace-manifest.js";
import { createWorkerWorkspaceOperationCoordinator } from "../worker-environments/workspace-operation-coordinator.js";
import { readActualWorkspaceManifest } from "../worker-environments/workspace-reconcile-core.js";
import { loadSessionDiff } from "./sessions-diff.js";
import { resolveLocalSessionWorkspaceRoot, sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createWorkspaceFixture,
  expectError,
  expectOkPayload,
  hashContent,
  removeWorkspaceFixture,
} from "./sessions-files.test-support.js";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  workspace: vi.fn(),
  store: vi.fn(),
  open: vi.fn(),
  beforeWrite: vi.fn<() => Promise<void>>(),
}));
vi.mock("../session-utils.js", () => ({ loadGatewaySessionEntryReadOnly: mocks.load }));
vi.mock("../../config/sessions/session-accessor.js", async (original) => ({
  ...(await original<typeof import("../../config/sessions/session-accessor.js")>()),
  loadSessionEntryReadOnly: () => mocks.load().entry,
}));
vi.mock("../../infra/fs-safe.js", async (original) => {
  const actual = await original<typeof import("../../infra/fs-safe.js")>();
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const root = await actual.root(...args);
      const write = root.write.bind(root);
      root.write = async (...writeArgs) => {
        await mocks.beforeWrite();
        await write(...writeArgs);
      };
      return root;
    },
  };
});
vi.mock("../../agents/agent-scope.js", async (original) => ({
  ...(await original<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: mocks.workspace,
}));
vi.mock("../../state/session-repository-workspaces.js", async (original) => ({
  ...(await original<typeof import("../../state/session-repository-workspaces.js")>()),
  getSessionRepositoryWorkspaceStore: mocks.store,
}));
vi.mock("./open-path.js", async (original) => ({
  ...(await original<typeof import("./open-path.js")>()),
  execOpenPath: mocks.open,
}));
vi.mock("../session-transcript-readers.js", async (original) => ({
  ...(await original<typeof import("../session-transcript-readers.js")>()),
  readSessionTranscriptVisibleMessageDeltaCore: () => ({ kind: "missing" }),
}));

const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const sessionKey = "agent:main:repository";
const gatewayDeviceId = "repository-gateway";
const identity = {
  gatewayNamespace: nodeWorkerGatewayNamespace(gatewayDeviceId),
  environmentId: "test-environment",
  sessionId: "test-session",
  generation: 1,
};
let gatewayRoot: string;
let nodeRoot: string;
let workspace: string;
let store: ReturnType<typeof createSessionRepositoryWorkspaceStore>;
let source: ReturnType<typeof store.create>;
let runtime: NodeWorkerWorkspaceRuntime;
let generation: number;
let active: boolean;
let onTunnel: (() => void) | undefined;
let onResult: (() => void) | undefined;
let sessionId: string;
let lifecycleRevision: number;
let archivedAt: number | undefined;
let run: ReturnType<
  typeof vi.fn<(command: WorkerWorkspaceCommand) => ReturnType<NodeWorkerWorkspaceRuntime["exec"]>>
>;
let context: ReturnType<typeof requestContext>;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8" }).trim();
}

function requestContext() {
  return {
    getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    workerRepositoryWorkspaceMutationService: {
      mutate: async <T>(params: {
        assertCurrent: () => void;
        mutate: (assertCurrent: () => void) => Promise<{ changed: boolean; value: T }>;
      }): Promise<T> => (await params.mutate(params.assertCurrent)).value,
    },
    workerSessionPlacementService: {
      getMany: () =>
        new Map([
          [
            identity.sessionId,
            {
              sessionId: identity.sessionId,
              sessionKey,
              agentId: "main",
              state: active ? "active" : "reclaimed",
              generation,
              environmentId: identity.environmentId,
              activeOwnerEpoch: 1,
              remoteWorkspaceDir: workspace,
            },
          ],
        ]),
    },
    workerEnvironmentService: {
      get: () => ({ state: "attached", ownerEpoch: 1, attachedSessionIds: [identity.sessionId] }),
      startTunnel: async () => {
        onTunnel?.();
        return { environmentId: identity.environmentId, ownerEpoch: 1, runWorkspaceCommand: run };
      },
    },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.beforeWrite.mockReset();
  gatewayRoot = createWorkspaceFixture("repository-files-gateway-");
  nodeRoot = createWorkspaceFixture("repository-files-node-");
  generation = 1;
  active = true;
  sessionId = identity.sessionId;
  lifecycleRevision = 0;
  archivedAt = undefined;
  onTunnel = undefined;
  onResult = undefined;
  runtime = new NodeWorkerWorkspaceRuntime({
    root: path.join(nodeRoot, "runtime"),
    env: { PATH: process.env.PATH, HOME: nodeRoot },
  });
  workspace = (await runtime.exec({ ...identity, argv: ["git", "init", "-q", "-b", "main"] }))
    .workspaceDir;
  git("config", "user.name", "Repository Test");
  git("config", "user.email", "repository@example.test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(workspace, "README"), "untouched source\n");
  fs.writeFileSync(path.join(workspace, "changed.txt"), "before\n");
  git("add", ".");
  git("commit", "-qm", "base");
  store = createSessionRepositoryWorkspaceStore({
    database: openOpenClawStateDatabase({ path: path.join(gatewayRoot, "state.sqlite") }),
  });
  source = store.create({
    agentId: "main",
    sessionKey,
    url: "https://example.test/repository.git",
    assertCurrent: () => {},
  });
  const base = await readActualWorkspaceManifest({
    root: workspace,
    baseCommit: git("rev-parse", "HEAD"),
  });
  source = store.bindBase({
    workspaceId: source.workspaceId,
    expectedRevision: source.revision,
    baseCommit: base.manifest.baseCommit!,
    baseManifestHash: base.manifestRef,
    assertCurrent: () => {},
  });
  // Repository startup accepts its first checkpoint before exposing an active editor.
  const initial = await stageSessionRepositoryCheckpoint({
    store,
    workspaceId: source.workspaceId,
    expectedRevision: source.revision,
    stagingRoot: workspace,
    baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
    currentManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
    baseManifestRef: base.manifestRef,
    currentManifestRef: base.manifestRef,
    assertCurrent: () => {},
  });
  source = await initial.publish();
  mocks.store.mockReturnValue(store);
  mocks.workspace.mockReturnValue(gatewayRoot);
  mocks.load.mockImplementation(() => ({
    agentId: "main",
    canonicalKey: sessionKey,
    cfg: {},
    storePath: path.join(gatewayRoot, "sessions.sqlite"),
    storeKeys: [sessionKey],
    entry: { sessionId, repositoryWorkspaceId: source.workspaceId, lifecycleRevision, archivedAt },
  }));
  run = vi.fn(async (command: WorkerWorkspaceCommand) => {
    command.assertCurrent?.();
    const input = parseNodeWorkerWorkspaceExecInput(
      JSON.stringify({ ...identity, argv: command.argv, input: command.input }),
    );
    const result = await runtime.exec(input);
    onResult?.();
    return result;
  });
  context = requestContext();
});

afterEach(() => {
  closeOpenClawStateDatabaseByPath(path.join(gatewayRoot, "state.sqlite"));
  removeWorkspaceFixture(nodeRoot);
  removeWorkspaceFixture(gatewayRoot);
});

async function withCheckpointAcceptance(failCapture = false) {
  const placements = createWorkerSessionPlacementStore({
    database: openOpenClawStateDatabase({ path: path.join(gatewayRoot, "state.sqlite") }),
  });
  let placement = placements.startDispatch({
    sessionId: identity.sessionId,
    sessionKey,
    agentId: "main",
    executionMode: "remote-exec",
  });
  for (const [from, to, patch] of [
    ["requested", "provisioning", { environmentId: identity.environmentId }],
    ["provisioning", "syncing", { workerBundleHash: BUILD.bundleHash }],
    [
      "syncing",
      "starting",
      { workspaceBaseManifestRef: source.baseManifestHash, remoteWorkspaceDir: workspace },
    ],
    ["starting", "active", { activeOwnerEpoch: identity.generation }],
  ] as const) {
    placement = placements.transition({
      sessionId: identity.sessionId,
      from,
      to,
      expectedGeneration: placement.generation,
      patch,
    });
  }
  generation = placement.generation;
  const base = await readActualWorkspaceManifest({
    root: workspace,
    baseCommit: source.baseCommit,
  });
  const environments = {
    get: (): ReturnType<WorkerEnvironmentService["get"]> => ({
      ...environment(),
      environmentId: identity.environmentId,
      ownerEpoch: identity.generation,
      attachedSessionIds: [identity.sessionId],
      desktopAvailable: false,
      desktopApps: [],
      tunnelStatus: "connected",
    }),
    startTunnel: async () => ({
      ...(await context.workerEnvironmentService.startTunnel()),
      stop: async () => {},
      syncWorkspace: vi.fn(),
      quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
      reconcileWorkspace: async (request: WorkerWorkspaceReconcileRequest) => {
        if (failCapture) {
          throw new Error("checkpoint capture failed");
        }
        if (request.source.kind !== "repository") {
          throw new Error("expected repository capture");
        }
        const current = await readActualWorkspaceManifest({
          root: workspace,
          baseCommit: source.baseCommit,
        });
        const publicationStagingRoot = path.join(nodeRoot, "publication");
        const publicationDigest = execFileSync(
          process.execPath,
          [
            "-e",
            REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS,
            workspace,
            source.baseCommit!,
            publicationStagingRoot,
          ],
          { encoding: "utf8" },
        ).trim();
        const prepared = await request.source.prepareCheckpoint({
          stagingRoot: workspace,
          publicationStagingRoot,
          publicationDigest,
          baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
          currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
          baseManifestRef: base.manifestRef,
          currentManifestRef: current.manifestRef,
        });
        return {
          manifestRef: current.manifestRef,
          changed: current.manifestRef !== base.manifestRef,
          verifyStable: async () => {
            expect(
              (
                await readActualWorkspaceManifest({
                  root: workspace,
                  baseCommit: source.baseCommit,
                })
              ).manifestRef,
            ).toBe(current.manifestRef);
          },
          verifyLocalStable: () => prepared.verify(),
          publishStagedResult: async () => {
            await prepared.publish();
          },
          discardPreparedStagedResult: () => prepared.discard(),
        };
      },
    }),
  };
  const service = createRepositoryWorkspaceMutationService({
    placements,
    environments,
    workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
    resolveWorkspace: async () => ({
      kind: "repository",
      repository: store.get(source.workspaceId)!,
    }),
  });
  return { placements, context: { ...context, workerRepositoryWorkspaceMutationService: service } };
}

it("accepts editor bytes and Git-normalized publication before acknowledging the save", async () => {
  const accepted = await withCheckpointAcceptance();
  fs.writeFileSync(path.join(workspace, ".gitattributes"), "changed.txt text eol=lf\n");
  expectOkPayload(
    await invoke(
      "sessions.files.set",
      {
        sessionKey,
        path: "changed.txt",
        content: "saved\r\n",
        expectedHash: hashContent("before\n"),
      },
      accepted.context,
    ),
  );
  const checkpoint = await readSessionRepositoryCheckpoint({
    store,
    workspaceId: source.workspaceId,
  });
  const changed = checkpoint.changedEntries.find((entry) => entry.path === "changed.txt")!;
  expect((await checkpoint.readEntry(changed)).toString()).toBe("saved\r\n");
  await withSessionRepositoryCheckpoint(
    { store, workspaceId: source.workspaceId, includePublication: true },
    async (snapshot) => {
      expect(snapshot.publicationDigest).toBeDefined();
      const { snapshot: publication } = await readGitHubRepositoryPublicationMetadata(
        snapshot.publicationStagingRoot!,
        snapshot.publicationDigest!,
      );
      const published = publication.entries.find((entry) => entry.path === "changed.txt")!;
      expect(
        (
          await readGitHubRepositoryPublicationBlob(
            snapshot.publicationStagingRoot!,
            published.sha!,
          )
        ).toString(),
      ).toBe("saved\n");
    },
  );
  expect(accepted.placements.listPendingWorkspaceResults()).toEqual([]);
  expect(accepted.placements.get(identity.sessionId)?.turnClaim).toBeNull();
});

it("reports failed editor checkpoint capture and retains the durable recovery owner", async () => {
  const accepted = await withCheckpointAcceptance(true);
  await expect(
    invoke(
      "sessions.files.set",
      {
        sessionKey,
        path: "changed.txt",
        content: "saved\n",
        expectedHash: hashContent("before\n"),
      },
      accepted.context,
    ),
  ).rejects.toThrow("checkpoint capture failed");
  expect(fs.readFileSync(path.join(workspace, "changed.txt"), "utf8")).toBe("saved\n");
  expect(store.get(source.workspaceId)).toMatchObject({
    checkpointRef: source.checkpointRef,
    manifestHash: source.manifestHash,
  });
  expect(accepted.placements.listPendingWorkspaceResults()).toEqual([
    expect.objectContaining({
      sessionId: identity.sessionId,
      workspaceAcceptedAtMs: null,
      recoveryRequestedAtMs: expect.any(Number),
    }),
  ]);
});

it("browses, previews, edits and diffs only the live repository without a Gateway checkout", async () => {
  const list = expectOkPayload(await invoke("sessions.files.list", { sessionKey }, context));
  expect(list.browser.entries.map((entry: { path: string }) => entry.path)).toContain("README");
  expect(list.browser.entries.map((entry: { path: string }) => entry.path)).not.toContain(
    "package.json",
  );
  expect(list.root).toBeUndefined();
  expect(resolveLocalSessionWorkspaceRoot({ sessionKey })).toBeUndefined();
  const before = expectOkPayload(
    await invoke("sessions.files.get", { sessionKey, path: "changed.txt" }, context),
  );
  const content = "x".repeat(192 * 1024);
  expectOkPayload(
    await invoke(
      "sessions.files.set",
      { sessionKey, path: "changed.txt", content, expectedHash: before.file.hash },
      context,
    ),
  );
  const saved = expectOkPayload(
    await invoke("sessions.files.get", { sessionKey, path: "changed.txt" }, context),
  );
  expect(saved.file.content).toBe(content);
  expect(saved.file.hash).toBe(hashContent(content));
  expect(saved.root).toBeUndefined();
  const stale = expectError(
    await invoke(
      "sessions.files.set",
      { sessionKey, path: "changed.txt", content: "stale", expectedHash: before.file.hash },
      context,
    ),
  );
  expect(stale.details.type).toBe("session_file_conflict");
  fs.writeFileSync(path.join(workspace, "changed.txt"), "after\n");
  git("add", ".");
  git("commit", "-qm", "session change");
  fs.writeFileSync(path.join(workspace, "second.txt"), "second edit\n");
  const diff = await loadSessionDiff({ sessionKey }, context as never);
  expect(diff.root).toBeUndefined();
  expect(diff.files.map((file) => file.path)).toEqual(["changed.txt", "second.txt"]);
  expect(diff.files[0]?.patch).toContain("+after");
  expect(diff.files[1]?.patch).toContain("+second edit");
  const reveal = expectOkPayload(
    await invoke("sessions.files.reveal", { key: sessionKey }, context),
  );
  expect(reveal).toMatchObject({
    ok: false,
    error: expect.stringContaining("no Gateway checkout"),
  });
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.workspace).not.toHaveBeenCalled();
});

it.each(["tunnel", "result"])("rejects a replaced placement after %s work", async (phase) => {
  if (phase === "tunnel") {
    onTunnel = () => {
      generation++;
    };
  } else {
    onResult = () => {
      generation++;
    };
  }
  await expect(
    invoke("sessions.files.get", { sessionKey, path: "README" }, context),
  ).rejects.toThrow("placement changed");
  expect(mocks.workspace).not.toHaveBeenCalled();
});

it.each(["reset", "archive", "lifecycle revision"])(
  "rejects a session %s before dispatching an editor write",
  async (change) => {
    onTunnel = () => {
      if (change === "reset") {
        sessionId = "replacement";
      } else if (change === "archive") {
        archivedAt = Date.now();
      } else {
        lifecycleRevision++;
      }
    };
    await expect(
      invoke(
        "sessions.files.set",
        {
          sessionKey,
          path: "changed.txt",
          content: "unowned",
          expectedHash: hashContent("before\n"),
        },
        context,
      ),
    ).rejects.toThrow("owner changed");
    expect(run).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(workspace, "changed.txt"), "utf8")).toBe("before\n");
  },
);

it.each(["stop", "reset"])(
  "retains the editor owner through a delayed file commit before %s",
  async (mutation) => {
    const writing = createDeferredCore();
    const releaseWrite = createDeferredCore();
    mocks.beforeWrite.mockImplementationOnce(async () => {
      writing.resolve();
      await releaseWrite.promise;
    });
    const saving = invoke(
      "sessions.files.set",
      {
        sessionKey,
        path: "changed.txt",
        content: "saved\n",
        expectedHash: hashContent("before\n"),
      },
      context,
    );
    await writing.promise;
    let mutationEntered = false;
    let contentAtMutation: string | undefined;
    const mutating = runExclusiveSessionLifecycleMutation({
      scope: path.join(gatewayRoot, "sessions.sqlite"),
      identities: [sessionKey, identity.sessionId],
      run: async () => {
        mutationEntered = true;
        contentAtMutation = fs.readFileSync(path.join(workspace, "changed.txt"), "utf8");
        if (mutation === "stop") {
          active = false;
        } else {
          sessionId = "replacement";
        }
      },
    });
    // Observe the independently queued lifecycle operation after its microtasks drain.
    // The filesystem delay is explicit; no elapsed-time assumption controls the race.
    try {
      await setImmediate();
      expect(mutationEntered).toBe(false);
    } finally {
      releaseWrite.resolve();
      await Promise.allSettled([saving, mutating]);
    }
    expectOkPayload(await saving);
    await mutating;
    expect(mutationEntered).toBe(true);
    expect(contentAtMutation).toBe("saved\n");
  },
);

it("keeps stopped inspection limited to verified changed artifacts", async () => {
  const base = await readActualWorkspaceManifest({
    root: workspace,
    baseCommit: source.baseCommit,
  });
  fs.writeFileSync(path.join(workspace, "changed.txt"), "retained first\n");
  fs.writeFileSync(path.join(workspace, "second.txt"), "retained second\n");
  const current = await readActualWorkspaceManifest({
    root: workspace,
    baseCommit: source.baseCommit,
  });
  const staged = await stageSessionRepositoryCheckpoint({
    store,
    workspaceId: source.workspaceId,
    expectedRevision: source.revision,
    stagingRoot: workspace,
    baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
    currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
    baseManifestRef: base.manifestRef,
    currentManifestRef: current.manifestRef,
    assertCurrent: () => {},
  });
  source = await staged.publish();
  active = false;
  const list = expectOkPayload(await invoke("sessions.files.list", { sessionKey }, context));
  expect(list.browser.entries.map((entry: { path: string }) => entry.path)).toEqual([
    "changed.txt",
    "second.txt",
  ]);
  const retained = expectOkPayload(
    await invoke("sessions.files.get", { sessionKey, path: "second.txt" }, context),
  );
  expect(retained.file.content).toBe("retained second\n");
  expect(retained.file.hash).toBeUndefined();
  expect(retained.root).toBeUndefined();
  await expect(
    invoke("sessions.files.get", { sessionKey, path: "README" }, context),
  ).rejects.toThrow("not a retained changed artifact");
  const diff = await loadSessionDiff({ sessionKey }, context as never);
  expect(diff.unavailableReason).toBe("workspace_stopped");
  expect(diff.files.map((file) => file.path)).toEqual(["changed.txt", "second.txt"]);
  expect(run).not.toHaveBeenCalled();
  expect(mocks.workspace).not.toHaveBeenCalled();
});

it.each(["symlink", "hardlink"])(
  "does not expose an outside %s through remote preview or diff",
  async (kind) => {
    const outside = path.join(nodeRoot, "outside.txt");
    fs.writeFileSync(outside, "outside marker\n");
    if (kind === "symlink") {
      fs.symlinkSync(outside, path.join(workspace, "link.txt"));
    } else {
      fs.linkSync(outside, path.join(workspace, "link.txt"));
    }
    expectError(await invoke("sessions.files.get", { sessionKey, path: "link.txt" }, context));
    expectError(
      await invoke("sessions.files.get", { sessionKey, path: "../outside.txt" }, context),
    );
    const diff = await loadSessionDiff({ sessionKey }, context as never);
    expect(JSON.stringify(diff)).not.toContain("outside marker");
  },
);

it.each(["invalid input", "missing workspace"])(
  "classifies %s as permanent inspection failure",
  async (failure) => {
    if (failure === "missing workspace") {
      fs.rmSync(workspace, { recursive: true });
    }
    const input =
      failure === "invalid input"
        ? "{invalid"
        : JSON.stringify({ operation: "get", sessionKey, path: "README", files: [] });
    const response = await invokeNodeWorkerSupervisorCommand({
      command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
      paramsJSON: JSON.stringify({ ...identity, argv: [WORKSPACE_INSPECTION_COMMAND], input }),
      workspace: runtime,
    });
    expect(response).toMatchObject({ handled: true, ok: false, code: "INVALID_REQUEST" });
  },
);

it("keeps a timed-out remote save owned until its physical write drains before Stop", async () => {
  const writing = createDeferredCore();
  const releaseWrite = createDeferredCore();
  const draining = createDeferredCore();
  mocks.beforeWrite.mockImplementationOnce(async () => {
    writing.resolve();
    await releaseWrite.promise;
  });
  const record = {
    ...environment(),
    environmentId: identity.environmentId,
    ownerEpoch: identity.generation,
    attachedSessionIds: [identity.sessionId],
  };
  const nodeTransport = transport();
  let physicalWrite: Promise<unknown> | undefined;
  nodeTransport.invoke = async (request) => {
    expect(request.isDispatchAuthorized()).toBe(true);
    request.onDispatchReady?.("editor-timeout-invoke");
    const input = parseNodeWorkerWorkspaceExecInput(JSON.stringify(request.params));
    if (input.argv[0] === WORKSPACE_INSPECTION_COMMAND) {
      const cancelled = new AbortController();
      physicalWrite = runtime.exec(input, cancelled.signal);
      void physicalWrite.catch(() => undefined);
      await writing.promise;
      // The real transport sends cancellation and returns before the node write joins.
      cancelled.abort();
      return { ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } };
    }
    expect(input.argv).toEqual([NODE_WORKSPACE_DRAIN_COMMAND]);
    if (physicalWrite) {
      draining.resolve();
    }
    return { ok: true, payloadJSON: JSON.stringify(await runtime.exec(input, request.signal)) };
  };
  const manager = createNodeWorkerTunnelManager({
    gatewayDeviceId,
    getEnvironment: () => record,
    listEnvironments: () => [record],
    getTransport: () => nodeTransport,
    launchNodeWorker: vi.fn(),
    validateWorkerTurn: () => true,
    workspaceTransfer: {
      ...workspaceTransfer(),
      prepareRepository: vi.fn(async () => {}),
    },
  });
  manager.bindWorkspaceBindingResolver(async () => ({
    source: {
      kind: "repository",
      baseCommit: source.baseCommit!,
      baseManifestRef: source.baseManifestHash!,
    },
    manifestRef: source.baseManifestHash!,
    remoteWorkspaceDir: workspace,
  }));
  const managerContext = {
    ...context,
    workerEnvironmentService: {
      ...context.workerEnvironmentService,
      startTunnel: () =>
        manager.start({
          executionMode: "remote-exec",
          environmentId: identity.environmentId,
          ownerEpoch: identity.generation,
          sessionId: identity.sessionId,
          deviceId: record.nodeDeviceId!,
          expectedBuild: BUILD,
        }),
    },
  };
  let saveSettled = false;
  const saving = invoke(
    "sessions.files.set",
    { sessionKey, path: "changed.txt", content: "saved\n", expectedHash: hashContent("before\n") },
    managerContext,
  ).then(
    () => {
      saveSettled = true;
      return undefined;
    },
    (error: unknown) => {
      saveSettled = true;
      return error;
    },
  );
  await draining.promise;
  let stopEntered = false;
  let contentAtStop: string | undefined;
  const stopping = runExclusiveSessionLifecycleMutation({
    scope: path.join(gatewayRoot, "sessions.sqlite"),
    identities: [sessionKey, identity.sessionId],
    run: async () => {
      stopEntered = true;
      await manager.stop(identity.environmentId, identity.generation);
      contentAtStop = fs.readFileSync(path.join(workspace, "changed.txt"), "utf8");
      active = false;
    },
  });
  try {
    await setImmediate();
    expect(saveSettled).toBe(false);
    expect(stopEntered).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "changed.txt"), "utf8")).toBe("before\n");
  } finally {
    releaseWrite.resolve();
    await Promise.allSettled([saving, stopping, physicalWrite]);
  }
  expect(await saving).toEqual(
    expect.objectContaining({ message: expect.stringContaining("TIMEOUT") }),
  );
  await stopping;
  expect(contentAtStop).toBe("saved\n");
  expect(manager.status(identity.environmentId)).toBe("stopped");
});
