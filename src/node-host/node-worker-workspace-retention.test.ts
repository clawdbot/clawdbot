import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { NodeWorkerWorkspaceRetainInput } from "../worker/node-workspace-retain-protocol.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
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

async function waitForTerminal(
  supervisor: ReturnType<typeof createNodeWorkerSupervisor>,
  launchId: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await supervisor.status(launchId))?.state).not.toMatch(/^(?:pending|running)$/u);
    },
    { timeout: 5_000 },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("node worker workspace retention", () => {
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

  it("keeps a nonterminal launch until a later authoritative snapshot", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-active-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const input = testWorkerLaunchInput(workspaceDir, "active-retention", "wait");
    const active = seedGeneration(bundleRoot, input, input.descriptor.admission.ownerEpoch);
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });

    await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    await supervisor.retainWorkspaces(retainInput(input, 1, []));
    expect(fs.existsSync(active)).toBe(true);

    await supervisor.cancel(testNodeWorkerLaunchIdentity(input));
    await waitForTerminal(supervisor, input.launchId);
    await supervisor.retainWorkspaces(retainInput(input, 2, []));
    expect(fs.existsSync(active)).toBe(false);
    await supervisor.close();
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
