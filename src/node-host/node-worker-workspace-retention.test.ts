import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { NodeWorkerWorkspaceRetainInput } from "../worker/node-workspace-retain-protocol.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  testNodeWorkerEnvironmentIdentity,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import * as workspaceTransfer from "./node-worker-transfer-client.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function hashPathComponent(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function sessionRoot(bundleRoot: string, input: ReturnType<typeof testWorkerLaunchInput>): string {
  return path.join(
    bundleRoot,
    input.gatewayNamespace,
    "workspaces",
    hashPathComponent(input.descriptor.admission.environmentId, 16),
    hashPathComponent(input.descriptor.admission.sessionId, 32),
  );
}

function generationPath(
  bundleRoot: string,
  input: ReturnType<typeof testWorkerLaunchInput>,
  generation: number,
): string {
  return path.join(sessionRoot(bundleRoot, input), String(generation));
}

function seedGeneration(
  bundleRoot: string,
  input: ReturnType<typeof testWorkerLaunchInput>,
  generation: number,
): string {
  const generationDir = generationPath(bundleRoot, input, generation);
  fs.mkdirSync(generationDir, { recursive: true });
  fs.writeFileSync(path.join(generationDir, "sentinel.txt"), String(generation));
  return generationDir;
}

function seedManifest(
  bundleRoot: string,
  input: ReturnType<typeof testWorkerLaunchInput>,
  digest: string,
): string {
  const manifest = path.join(
    sessionRoot(bundleRoot, input),
    ".openclaw-worker",
    "manifests",
    `${digest}.json`,
  );
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, "{}\n");
  return manifest;
}

function retainInput(
  input: ReturnType<typeof testWorkerLaunchInput>,
  sequence: number,
  retain: NodeWorkerWorkspaceRetainInput["retain"],
): NodeWorkerWorkspaceRetainInput {
  return {
    version: 1,
    gatewayNamespace: input.gatewayNamespace,
    controllerId: "gateway-controller-1",
    sequence,
    retain,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("node worker workspace retention", () => {
  it("claims only the exact canonical placement workspace identity", () => {
    const root = fs.realpathSync.native(tempDirs.make("node-worker-workspace-managed-identity-"));
    const workspace = new NodeWorkerWorkspaceRuntime({ root });
    const input = testWorkerLaunchInput("/unused", "managed-identity");
    const ownerEpoch = input.descriptor.admission.ownerEpoch;
    const workspaceDir = seedGeneration(root, input, ownerEpoch);
    const request = {
      workspaceDir,
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch,
      sessionKey: "agent:main:managed",
    };

    const claim = workspace.acquireManagedWorkspace(request);
    expect(claim.workspaceDir).toBe(workspaceDir);
    claim.release();
    claim.release();

    for (const changed of [
      { workspaceDir: root },
      { environmentId: "different-environment" },
      { sessionId: "different-session" },
      { ownerEpoch: ownerEpoch + 1 },
      { sessionKey: "" },
    ]) {
      expect(() => workspace.acquireManagedWorkspace({ ...request, ...changed })).toThrow(
        "does not own the requested workspace",
      );
    }

    const linked = path.join(path.dirname(workspaceDir), "linked-workspace");
    fs.symlinkSync(workspaceDir, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => workspace.acquireManagedWorkspace({ ...request, workspaceDir: linked })).toThrow(
      "does not own the requested workspace",
    );
  });

  it("protects a claimed placement workspace until its owner releases it", async () => {
    const root = fs.realpathSync.native(tempDirs.make("node-worker-workspace-managed-retention-"));
    const workspace = new NodeWorkerWorkspaceRuntime({ root });
    const input = testWorkerLaunchInput("/unused", "managed-retention");
    const ownerEpoch = input.descriptor.admission.ownerEpoch;
    const workspaceDir = seedGeneration(root, input, ownerEpoch);
    const claim = workspace.acquireManagedWorkspace({
      workspaceDir,
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch,
      sessionKey: "agent:main:managed",
    });

    await workspace.applyRetainSnapshot(retainInput(input, 1, []), () => []);
    expect(fs.existsSync(workspaceDir)).toBe(true);

    claim.release();
    claim.release();
    await workspace.applyRetainSnapshot(retainInput(input, 2, []), () => []);
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });

  it("rejects a placement claim once workspace removal is already in flight", async () => {
    const root = fs.realpathSync.native(tempDirs.make("node-worker-workspace-removal-race-"));
    const workspace = new NodeWorkerWorkspaceRuntime({ root });
    const input = testWorkerLaunchInput("/unused", "managed-removal-race");
    const ownerEpoch = input.descriptor.admission.ownerEpoch;
    const workspaceDir = seedGeneration(root, input, ownerEpoch);
    const request = {
      workspaceDir,
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      ownerEpoch,
      sessionKey: "agent:main:managed",
    };
    let started!: () => void;
    let finish!: () => void;
    const removalStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finishRemoval = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const remove = fsp.rm.bind(fsp);
    vi.spyOn(fsp, "rm").mockImplementation(async (target, options) => {
      if (String(target) === workspaceDir) {
        started();
        await finishRemoval;
      }
      return await remove(target, options);
    });
    const retention = workspace.applyRetainSnapshot(retainInput(input, 1, []), () => []);

    try {
      await removalStarted;
      expect(fs.existsSync(workspaceDir)).toBe(true);
      expect(() => workspace.acquireManagedWorkspace(request)).toThrow(
        "workspace is being removed",
      );
    } finally {
      finish();
      await retention;
    }
    expect(fs.existsSync(workspaceDir)).toBe(false);
  });

  it("does not delete workspaces before the first Gateway snapshot", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-startup-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const input = testWorkerLaunchInput(workspaceDir, "startup-retention");
    const first = seedGeneration(bundleRoot, input, 1);
    const second = seedGeneration(bundleRoot, input, 2);
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });

    await supervisor.initialize();

    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
    await supervisor.close();
  });

  it("replaces the full retain set and deletes the latest orphan", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-snapshot-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const input = testWorkerLaunchInput(workspaceDir, "snapshot-retention");
    const first = seedGeneration(bundleRoot, input, 1);
    const latest = seedGeneration(bundleRoot, input, 2);
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });

    await expect(
      supervisor.retainWorkspaces(
        retainInput(input, 1, [
          {
            environmentId: input.descriptor.admission.environmentId,
            sessionId: input.descriptor.admission.sessionId,
            generation: 1,
            manifestRefs: null,
          },
        ]),
      ),
    ).resolves.toMatchObject({ applied: true, hasMore: false });

    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(latest)).toBe(false);

    await expect(supervisor.retainWorkspaces(retainInput(input, 2, []))).resolves.toMatchObject({
      applied: true,
      hasMore: false,
    });
    expect(fs.existsSync(first)).toBe(false);
    await supervisor.close();
  });

  it("continues a bounded backlog with an idempotent snapshot replay", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-backlog-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const input = testWorkerLaunchInput(workspaceDir, "backlog-retention");
    for (let generation = 0; generation <= 260; generation += 1) {
      seedGeneration(bundleRoot, input, generation);
    }
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });
    const snapshot = retainInput(input, 1, []);

    const first = await supervisor.retainWorkspaces(snapshot);
    const second = await supervisor.retainWorkspaces(snapshot);

    expect(first).toMatchObject({ applied: true, deleted: 256, hasMore: true });
    expect(second).toMatchObject({ applied: true, hasMore: false });
    expect(fs.existsSync(sessionRoot(bundleRoot, input))).toBe(false);
    await supervisor.close();
  });

  it("cleans transfer siblings, unreachable manifests, and empty parents", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-artifacts-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const input = testWorkerLaunchInput(workspaceDir, "artifact-retention");
    const generation = seedGeneration(bundleRoot, input, 3);
    const rootForSession = sessionRoot(bundleRoot, input);
    const staging = path.join(rootForSession, ".3.workspace-transfer-stale");
    const backup = path.join(rootForSession, "3.previous-123-stale");
    fs.mkdirSync(staging);
    fs.mkdirSync(backup);
    const manifest = seedManifest(bundleRoot, input, "a".repeat(64));
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });

    await supervisor.retainWorkspaces(retainInput(input, 1, []));

    for (const target of [generation, staging, backup, manifest, rootForSession]) {
      expect(fs.existsSync(target)).toBe(false);
    }
    await supervisor.close();
  });

  it("keeps only reachable manifests for a retained workspace", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-manifests-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const input = testWorkerLaunchInput(workspaceDir, "manifest-retention");
    seedGeneration(bundleRoot, input, 4);
    const retainedDigest = "b".repeat(64);
    const retained = seedManifest(bundleRoot, input, retainedDigest);
    const stale = seedManifest(bundleRoot, input, "c".repeat(64));
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });

    await supervisor.retainWorkspaces(
      retainInput(input, 1, [
        {
          environmentId: input.descriptor.admission.environmentId,
          sessionId: input.descriptor.admission.sessionId,
          generation: 4,
          manifestRefs: [`sha256:${retainedDigest}`],
        },
      ]),
    );

    expect(fs.existsSync(retained)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    await supervisor.close();
  });

  it.each(["upload", "download"] as const)(
    "retains the latest %s manifest across command gaps until superseded or retired",
    async (direction) => {
      const root = fs.realpathSync.native(tempDirs.make("node-worker-workspace-transfer-retain-"));
      const workspace = new NodeWorkerWorkspaceRuntime({ root });
      const input = testWorkerLaunchInput("/unused", "transfer-retention");
      const generation = input.descriptor.admission.ownerEpoch;
      const workspaceDir = seedGeneration(root, input, generation);
      const baseDigest = "b".repeat(64);
      const baseManifest = seedManifest(root, input, baseDigest);
      const retainedEntry = {
        environmentId: input.descriptor.admission.environmentId,
        sessionId: input.descriptor.admission.sessionId,
        generation,
        manifestRefs: [`sha256:${baseDigest}`],
      };
      const runTransfer = vi.spyOn(workspaceTransfer, "runNodeWorkerWorkspaceTransfer");
      const transferManifest = async (digest: string) => {
        const manifestRef = `sha256:${digest}`;
        const manifest = seedManifest(root, input, digest);
        runTransfer.mockResolvedValueOnce(manifestRef);
        await workspace.exec(
          {
            gatewayNamespace: input.gatewayNamespace,
            environmentId: retainedEntry.environmentId,
            sessionId: retainedEntry.sessionId,
            generation,
            argv: ["node"],
            transfer:
              direction === "upload"
                ? { direction, token: "test-token", baseManifestRef: `sha256:${baseDigest}` }
                : { direction, token: "test-token", manifestRef },
          },
          undefined,
          { url: "http://127.0.0.1:1" },
        );
        return manifest;
      };

      const first = await transferManifest("c".repeat(64));
      const artifacts = [
        `.${generation}.workspace-transfer-stale`,
        `${generation}.previous-123-stale`,
      ].map((name) => path.join(sessionRoot(root, input), name));
      for (const artifact of artifacts) {
        fs.mkdirSync(artifact);
      }
      await workspace.applyRetainSnapshot(retainInput(input, 1, [retainedEntry]), () => []);

      expect(fs.existsSync(first)).toBe(true);
      expect(artifacts.every((artifact) => !fs.existsSync(artifact))).toBe(true);

      const latest = await transferManifest("d".repeat(64));
      await workspace.applyRetainSnapshot(retainInput(input, 2, [retainedEntry]), () => []);

      expect(fs.existsSync(first)).toBe(false);
      expect(fs.existsSync(latest)).toBe(true);
      expect(fs.existsSync(baseManifest)).toBe(true);

      const sibling = seedGeneration(root, input, generation + 1);
      await workspace.applyRetainSnapshot(
        retainInput(input, 3, [{ ...retainedEntry, generation: generation + 1 }]),
        () => [],
      );

      expect(fs.existsSync(workspaceDir)).toBe(false);
      expect(fs.existsSync(latest)).toBe(false);
      expect(fs.existsSync(sibling)).toBe(true);
    },
  );

  it("keeps a retained worker workspace after turn completion until environment teardown", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-active-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const input = testWorkerLaunchInput(workspaceDir, "active-retention", "background-start");
    const active = seedGeneration(bundleRoot, input, input.descriptor.admission.ownerEpoch);
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });

    try {
      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      await vi.waitFor(
        async () => expect((await supervisor.status(input.launchId))?.state).toBe("completed"),
        { timeout: 5_000 },
      );
      await supervisor.retainWorkspaces(retainInput(input, 1, []));
      expect(fs.existsSync(active)).toBe(true);

      await supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(input));
      await supervisor.retainWorkspaces(retainInput(input, 2, []));
      expect(fs.existsSync(active)).toBe(false);
    } finally {
      await supervisor.close();
    }
  });

  it("rereads a launch reservation immediately before deleting", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-race-");
    const workspace = new NodeWorkerWorkspaceRuntime({ root });
    const input = testWorkerLaunchInput("/unused", "reservation-race");
    const generation = seedGeneration(root, input, input.descriptor.admission.ownerEpoch);
    let reservations: Array<{
      gatewayNamespace: string;
      environmentId: string;
      sessionId: string;
      ownerEpoch: number;
    }> = [];
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    let blocked = false;
    vi.spyOn(fs.promises, "lstat").mockImplementation(async (target) => {
      if (!blocked && String(target) === generation) {
        blocked = true;
        markStarted();
        await released;
      }
      return await originalLstat(target);
    });
    const retention = workspace.applyRetainSnapshot(retainInput(input, 1, []), () => reservations);
    await started;
    reservations = [
      {
        gatewayNamespace: input.gatewayNamespace,
        environmentId: input.descriptor.admission.environmentId,
        sessionId: input.descriptor.admission.sessionId,
        ownerEpoch: input.descriptor.admission.ownerEpoch,
      },
    ];
    release();

    await retention;

    expect(fs.existsSync(generation)).toBe(true);
  });

  it("protects an in-flight workspace command admitted during collection", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-command-");
    const workspace = new NodeWorkerWorkspaceRuntime({ root });
    const input = testWorkerLaunchInput("/unused", "command-retention");
    const started = path.join(
      generationPath(root, input, input.descriptor.admission.ownerEpoch),
      "started",
    );
    const release = path.join(path.dirname(started), "release");
    const command = workspace.exec({
      gatewayNamespace: input.gatewayNamespace,
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      generation: input.descriptor.admission.ownerEpoch,
      argv: [
        "node",
        "-e",
        `const fs=require("node:fs");fs.writeFileSync("started","");const gate="release";const until=Date.now()+5000;while(!fs.existsSync(gate)&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);`,
      ],
    });
    await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true));
    const retention = workspace.applyRetainSnapshot(retainInput(input, 1, []), () => []);
    fs.writeFileSync(release, "release");

    await command;
    await retention;
    expect(fs.existsSync(path.dirname(started))).toBe(true);

    await workspace.applyRetainSnapshot(retainInput(input, 2, []), () => []);
    expect(fs.existsSync(path.dirname(started))).toBe(false);
  });

  it("rejects conflicting replay and ignores an older sequence", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-sequence-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const input = testWorkerLaunchInput(workspaceDir, "sequence-retention");
    const generation = seedGeneration(bundleRoot, input, 5);
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });
    const retainedEntry = {
      environmentId: input.descriptor.admission.environmentId,
      sessionId: input.descriptor.admission.sessionId,
      generation: 5,
      manifestRefs: null,
    } as const;

    await supervisor.retainWorkspaces(retainInput(input, 2, [retainedEntry]));
    await expect(supervisor.retainWorkspaces(retainInput(input, 1, []))).resolves.toEqual({
      applied: false,
      deleted: 0,
      hasMore: false,
    });
    await expect(supervisor.retainWorkspaces(retainInput(input, 2, []))).rejects.toThrow(
      "sequence changed contents",
    );
    expect(fs.existsSync(generation)).toBe(true);
    await supervisor.close();
  });

  it("keeps other Gateway namespaces isolated", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-namespace-");
    const workspace = new NodeWorkerWorkspaceRuntime({ root });
    const first = testWorkerLaunchInput("/unused", "namespace-a");
    const second = testWorkerLaunchInput("/unused", "namespace-b");
    second.gatewayNamespace = "gateway-other";
    seedGeneration(root, first, 1);
    const other = seedGeneration(root, second, 1);

    await workspace.applyRetainSnapshot(retainInput(first, 1, []), () => []);

    expect(fs.existsSync(other)).toBe(true);
  });
});
