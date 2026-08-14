import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";

type Supervisor = ReturnType<typeof createNodeWorkerSupervisor>;
type LaunchInput = ReturnType<typeof testWorkerLaunchInput>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

function hashPathComponent(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function sessionRoot(bundleRoot: string, input: LaunchInput): string {
  return path.join(
    bundleRoot,
    input.gatewayNamespace,
    "workspaces",
    hashPathComponent(input.descriptor.admission.environmentId, 16),
    hashPathComponent(input.descriptor.admission.sessionId, 32),
  );
}

function seedGeneration(bundleRoot: string, input: LaunchInput, generation: number): string {
  const generationDir = path.join(sessionRoot(bundleRoot, input), String(generation));
  fs.mkdirSync(generationDir, { recursive: true });
  fs.writeFileSync(path.join(generationDir, "sentinel.txt"), String(generation));
  return generationDir;
}

function generationNames(bundleRoot: string, input: LaunchInput): string[] {
  return fs
    .readdirSync(sessionRoot(bundleRoot, input), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => Number(left) - Number(right));
}

async function waitForTerminal(supervisor: Supervisor, launchId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await supervisor.status(launchId))?.state).not.toMatch(/^(?:pending|running)$/u);
    },
    { timeout: 5_000 },
  );
}

describe("node worker workspace retention", () => {
  it("prunes superseded workspace generations on supervisor startup", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-startup-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const input = testWorkerLaunchInput(workspaceDir, "startup-retention");
    const latestInput = structuredClone(input);
    latestInput.descriptor.admission.environmentId = "environment-2";
    seedGeneration(bundleRoot, input, 1);
    seedGeneration(bundleRoot, latestInput, 2);
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });

    await supervisor.initialize();

    expect(generationNames(bundleRoot, input)).toEqual([]);
    expect(generationNames(bundleRoot, latestInput)).toEqual(["2"]);
    await supervisor.close();
  });

  it("drains a workspace backlog across bounded startup passes", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-backlog-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const input = testWorkerLaunchInput(workspaceDir, "startup-backlog-retention");
    for (let generation = 0; generation <= 260; generation += 1) {
      seedGeneration(bundleRoot, input, generation);
    }
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });

    await supervisor.initialize();

    expect(generationNames(bundleRoot, input)).toEqual(["260"]);
    await supervisor.close();
  });

  it("keeps an active launch generation until its terminal transition", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-active-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const activeInput = testWorkerLaunchInput(workspaceDir, "active-retention", "wait");
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });
    await supervisor.initialize();
    const activeGeneration = seedGeneration(
      bundleRoot,
      activeInput,
      activeInput.descriptor.admission.ownerEpoch,
    );
    const latestGeneration = seedGeneration(
      bundleRoot,
      activeInput,
      activeInput.descriptor.admission.ownerEpoch + 1,
    );
    const triggerInput = testWorkerLaunchInput(workspaceDir, "retention-trigger");
    triggerInput.descriptor.admission.sessionId = "session-2";
    triggerInput.descriptor.assignment.runId = "run-2";
    triggerInput.descriptor.assignment.operationalRunInstance = {
      instanceId: "instance-2",
      runId: "run-2",
    };
    seedGeneration(bundleRoot, triggerInput, triggerInput.placementGeneration);

    await supervisor.launch(activeInput, TEST_WORKER_ENDPOINT);
    await supervisor.launch(triggerInput, TEST_WORKER_ENDPOINT);
    await waitForTerminal(supervisor, triggerInput.launchId);

    expect(fs.existsSync(activeGeneration)).toBe(true);
    expect(fs.existsSync(latestGeneration)).toBe(true);

    await supervisor.cancel(testNodeWorkerLaunchIdentity(activeInput));

    await vi.waitFor(() => expect(fs.existsSync(activeGeneration)).toBe(false));
    expect(fs.existsSync(latestGeneration)).toBe(true);
    await supervisor.close();
  });

  it("keeps workspace generation count bounded across sustained turns", async () => {
    const root = tempDirs.make("node-worker-workspace-retention-growth-");
    const { bundleRoot, env, workspaceDir } = writeNodeWorkerFixture(root);
    const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });
    const observedCounts: number[] = [];

    for (let generation = 1; generation <= 8; generation += 1) {
      const input = testWorkerLaunchInput(workspaceDir, `retention-turn-${generation}`);
      input.placementGeneration = generation;
      input.descriptor.admission.ownerEpoch = generation;
      seedGeneration(bundleRoot, input, generation);
      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      await waitForTerminal(supervisor, input.launchId);
      await vi.waitFor(() => expect(generationNames(bundleRoot, input)).toHaveLength(1));
      observedCounts.push(generationNames(bundleRoot, input).length);
    }

    expect(observedCounts).toEqual(Array.from({ length: 8 }, () => 1));
    await supervisor.close();
  });
});
