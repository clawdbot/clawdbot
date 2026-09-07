import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { testApi as logTestApi } from "../logging/logger.test-support.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  NODE_WORKER_STARTUP_MESSAGE_TYPE,
  parseNodeWorkerStartupMessage,
} from "../worker/node-supervisor-protocol.js";
import { inspectNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import {
  createNodeWorkerSupervisorFixture,
  waitForNodeWorkerTerminal,
} from "./node-worker-supervisor.fixture.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await logTestApi.flushFileLogQueueForTests();
  resetLogger();
  setLoggerOverride(null);
  resetSecretRedactionRegistryForTest();
  closeOpenClawStateDatabaseForTest();
});

it("accepts only bounded closed startup frames", () => {
  const message = {
    type: NODE_WORKER_STARTUP_MESSAGE_TYPE,
    runId: "r".repeat(256),
    turnId: "t".repeat(256),
    phase: "hello-ready",
    workerTimeMs: 1.5,
  };
  for (const phase of ["connection-start", "transport-open", "hello-ready", "first-inference"]) {
    expect(parseNodeWorkerStartupMessage({ ...message, phase })).toEqual({ ...message, phase });
  }
  for (const invalid of [
    { ...message, runId: "r".repeat(257) },
    { ...message, turnId: "t".repeat(257) },
    { ...message, runId: "" },
    { ...message, turnId: "turn\0" },
    { ...message, phase: "arbitrary-detail" },
    { ...message, credential: "must-not-project" },
  ]) {
    expect(parseNodeWorkerStartupMessage(invalid)).toBeNull();
  }
  for (const workerTimeMs of [-1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    expect(parseNodeWorkerStartupMessage({ ...message, workerTimeMs })).toBeNull();
  }
});

it("correlates real IPC with the current turn, bounds duplicates, and keeps cancellation authoritative", async () => {
  const root = tempDirs.make("node-startup-");
  const { supervisor, bundleRoot, workspaceDir } = createNodeWorkerSupervisorFixture(root);
  const logFile = path.join(root, "startup.log");
  setLoggerOverride({ level: "debug", file: logFile, consoleLevel: "silent" });
  const input = testWorkerLaunchInput(workspaceDir, "startup-first", "startup");
  const workerFile = path.join(
    bundleRoot,
    input.gatewayNamespace,
    "bundles",
    input.expectedBundleHash,
    "worker.mjs",
  );
  // Exercise the real supervisor, process gate, IPC adapter, stores and log sink.
  // Only the worker workload is synthetic; it deliberately sends hostile telemetry.
  fs.writeFileSync(
    workerFile,
    TEST_WORKER_SOURCE.replace("let currentTurn;", "let currentTurn; let previousStartup;").replace(
      'if (mode === "admission-rearm") {',
      String.raw`if (mode === "startup" || mode === "startup-hold") {
  const send = (message) => new Promise((resolve) => process.send(message, resolve));
  const frame = {
    type: "openclaw-worker-startup-v1", runId: descriptor.assignment.runId,
    turnId: descriptor.assignment.turnId, phase: "connection-start", workerTimeMs: 2,
  };
  if (previousStartup) await send(previousStartup);
  await send({ ...frame, phase: "first-inference", workerTimeMs: 20 });
  await send({ ...frame, phase: "hello-ready", workerTimeMs: 10 });
  await send({ ...frame, phase: "transport-open", workerTimeMs: 5 });
  await send({ ...frame, runId: "wrong-run", workerTimeMs: 100 });
  await send({ ...frame, turnId: "wrong-turn", workerTimeMs: 101 });
  await send({ ...frame, extra: descriptor.admission.credential, workerTimeMs: 102 });
  await send(frame);
  for (let count = 0; count < 20; count++) await send(frame);
  await send({ ...frame, phase: "hello-ready", workerTimeMs: 10 });
  await send({ ...frame, phase: "transport-open", workerTimeMs: 1 });
  const opened = { ...frame, phase: "transport-open", workerTimeMs: 5 };
  for (let count = 0; count < 20; count++) await send(opened);
  await send({ ...frame, phase: "hello-ready", workerTimeMs: 4 });
  const hello = { ...frame, phase: "hello-ready", workerTimeMs: 10 };
  for (let count = 0; count < 20; count++) await send(hello);
  await send(opened);
  await send({ ...frame, phase: "first-inference", workerTimeMs: 9 });
  if (mode === "startup-hold") return;
  previousStartup = { ...frame, phase: "first-inference", workerTimeMs: 20 };
  for (let count = 0; count < 20; count++) await send(previousStartup);
  const releasePath = path.join(descriptor.assignment.workspaceDir, descriptor.assignment.turnId + ".startup-release");
  const releaseDeadline = Date.now() + 5_000;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() >= releaseDeadline) throw new Error("startup release timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  finish(descriptor, completedResult, true);
} else if (mode === "admission-rearm") {`,
    ),
  );
  const events = async () => {
    await logTestApi.flushFileLogQueueForTests();
    return fs
      .readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => row["2"] === "node worker startup")
      .map((row) => row["1"] as Record<string, unknown>);
  };
  const next = (turnId: string, prompt = "startup") => {
    const launch = testWorkerLaunchInput(workspaceDir, turnId, prompt);
    launch.descriptor.assignment.runId = `run-${turnId}`;
    launch.descriptor.assignment.operationalRunInstance = {
      ...launch.descriptor.assignment.operationalRunInstance,
      runId: launch.descriptor.assignment.runId,
    };
    return launch;
  };
  const waitForStartup = (launchId: string, phase: string) =>
    vi.waitFor(async () =>
      expect(await events()).toContainEqual(expect.objectContaining({ launchId, phase })),
    );
  const completeTurn = async (launchId: string) => {
    // IPC send completion does not acknowledge parent receipt. Keep this synthetic
    // turn live until its telemetry arrives; stdout completion closes the observer.
    await waitForStartup(launchId, "first-inference");
    fs.writeFileSync(path.join(workspaceDir, `${launchId}.startup-release`), "");
    return await waitForNodeWorkerTerminal(supervisor, launchId);
  };
  let owner: Awaited<ReturnType<typeof supervisor.launch>> | undefined;
  try {
    owner = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    expect((await completeTurn(input.launchId)).state).toBe("completed");
    const count = (await events()).length;
    await supervisor.launch(input, TEST_WORKER_ENDPOINT);
    expect(await events()).toHaveLength(count);
    const second = next("startup-second");
    expect(await supervisor.launch(second, TEST_WORKER_ENDPOINT)).toMatchObject({
      worker: owner.worker,
    });
    await completeTurn(second.launchId);
    const cancelled = next("startup-cancelled", "startup-hold");
    await supervisor.launch(cancelled, TEST_WORKER_ENDPOINT);
    await waitForStartup(cancelled.launchId, "hello-ready");
    expect(await supervisor.cancel(testNodeWorkerLaunchIdentity(cancelled))).toMatchObject({
      state: "cancelled",
    });
    const final = next("startup-final");
    const replacement = await supervisor.launch(final, TEST_WORKER_ENDPOINT);
    expect(replacement.worker).not.toEqual(owner.worker);
    await completeTurn(final.launchId);

    for (const launch of [input, second, cancelled, final]) {
      const observed = (await events()).filter((event) => event.launchId === launch.launchId);
      expect(observed.map((event) => event.phase)).toEqual([
        "launch-received",
        ...(launch === input || launch === final ? ["start-gate-opened"] : []),
        "connection-start",
        "transport-open",
        "hello-ready",
        ...(launch === cancelled ? [] : ["first-inference"]),
      ]);
      for (const event of observed) {
        expect(event).toMatchObject({
          ...testNodeWorkerLaunchIdentity(launch),
          turnId: launch.launchId,
        });
        expect(event.nodeElapsedMs).toBeGreaterThanOrEqual(0);
      }
      const nodeTimes = observed.map((event) => Number(event.nodeTimeMs));
      expect(nodeTimes).toEqual(nodeTimes.toSorted((a, b) => a - b));
      expect(observed.flatMap((event) => event.workerTimeMs ?? [])).toEqual(
        launch === cancelled ? [2, 5, 10] : [2, 5, 10, 20],
      );
    }
    expect(fs.readFileSync(logFile, "utf8")).not.toContain(input.descriptor.admission.credential);
  } finally {
    await supervisor.close();
  }
  expect(owner?.worker).toBeDefined();
  expect(inspectNodeWorkerProcessIdentity(owner!.worker!)).toMatch(/^(dead|reused)$/u);
});
