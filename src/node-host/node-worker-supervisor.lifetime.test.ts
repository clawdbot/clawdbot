import { once } from "node:events";
import fs from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import * as processTree from "../process/kill-tree.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { completeWorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import {
  buildWorkerProcessTurn,
  serializeWorkerProcessInput,
} from "../worker/worker-process-protocol.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "./node-worker-process-identity.js";
import {
  createNodeWorkerSupervisorFixture,
  waitForNodeWorkerTerminal as waitForTerminal,
} from "./node-worker-supervisor.fixture.test-support.js";
import type { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testNodeWorkerEnvironmentIdentity,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

type NodeWorkerSupervisor = ReturnType<typeof createNodeWorkerSupervisor>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
  closeOpenClawStateDatabaseForTest();
});

function fixture(options: Parameters<typeof createNodeWorkerSupervisor>[0] = {}) {
  return createNodeWorkerSupervisorFixture(tempDirs.make("node-worker-supervisor-"), options);
}

function launchInput(workspaceDir: string, launchId: string, prompt = "success") {
  const input = testWorkerLaunchInput(workspaceDir, launchId, prompt);
  input.descriptor.admission.environmentId = `environment-${launchId}`;
  input.descriptor.admission.sessionId = `session-${launchId}`;
  return input;
}

async function observeBackgroundConnection(url: string) {
  const address = new URL(url);
  const socket = createConnection({ host: address.hostname, port: Number(address.port) });
  let error: NodeJS.ErrnoException | undefined;
  let didClose = false;
  socket.on("error", (value) => {
    error = value;
  });
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => {
      didClose = true;
      resolve();
    });
  });
  const dispose = async () => {
    socket.destroy();
    await closed;
  };
  try {
    await once(socket, "connect");
    socket.resume();
  } catch (cause) {
    await dispose();
    throw cause;
  }
  return {
    socket,
    closed,
    dispose,
    get didClose() {
      return didClose;
    },
    get error() {
      return error;
    },
  };
}

type BackgroundConnection = Awaited<ReturnType<typeof observeBackgroundConnection>>;

function expectBackgroundRetired(
  connection: BackgroundConnection,
  ...owners: NodeWorkerProcessIdentity[]
) {
  // A freed listening port may belong to a replacement. This connection remains
  // bound to the original server, and unknown process identity is not death.
  expect(connection.didClose).toBe(true);
  if (connection.error && connection.error.code !== "ECONNRESET") {
    throw connection.error;
  }
  for (const owner of owners) {
    expect(inspectNodeWorkerProcessIdentity(owner)).toMatch(/^(dead|reused)$/u);
  }
}

describe("node worker environment lifetime", () => {
  it("reuses a retained worker at capacity across turns and cancellation until its environment stops", async () => {
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const { env, supervisor, workspaceDir } = fixture({
      capacity: 1,
      capacityWaitMs: 25,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    const first = testWorkerLaunchInput(workspaceDir, "preview-start", "background-start");
    const nextTurn = (turnId: string, prompt: string) => {
      const input = testWorkerLaunchInput(workspaceDir, turnId, prompt);
      input.descriptor.admission.credential = `credential-${turnId}`;
      input.descriptor.assignment.runId = `run-${turnId}`;
      input.descriptor.assignment.operationalRunInstance = {
        instanceId: `instance-${turnId}`,
        runId: input.descriptor.assignment.runId,
      };
      input.descriptor.assignment.agentRuntimeIdentityToken = `signed-token-${turnId}`;
      return input;
    };
    const environment = testNodeWorkerEnvironmentIdentity(first);
    const store = new NodeWorkerLaunchStore({ env });
    let connection: BackgroundConnection | undefined;

    try {
      const running = await supervisor.launch(first, TEST_WORKER_ENDPOINT);
      const completed = await waitForTerminal(supervisor, first.launchId);
      const background = JSON.parse(
        fs.readFileSync(path.join(workspaceDir, `${first.launchId}.background.json`), "utf8"),
      ) as { pid: number; url: string };
      const server = requireNodeWorkerProcessIdentity(background.pid);
      connection = await observeBackgroundConnection(background.url);
      expect(completed.state).toBe("completed");
      expect(store.get(first.launchId)).toMatchObject({ state: "running", worker: running.worker });
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });
      expect(await (await fetch(background.url)).text()).toBe("preview-ready");

      expect(await supervisor.launch(first, TEST_WORKER_ENDPOINT)).toEqual(completed);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(workspaceDir, `${first.launchId}.started.json`), "utf8"),
        ),
      ).toEqual({ pid: running.worker!.pid, starts: 1 });

      const poll = nextTurn("preview-poll", "background-poll");
      poll.descriptor.assignment.systemPrompt = '"\\\0\n漢😀';
      const encodePoll = () =>
        serializeWorkerProcessInput(
          buildWorkerProcessTurn(
            completeWorkerLaunchDescriptor(poll.descriptor, TEST_WORKER_ENDPOINT),
          ),
        );
      poll.descriptor.assignment.systemPrompt += "x".repeat(
        WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES - (Buffer.byteLength(encodePoll()) - 1),
      );
      expect(Buffer.byteLength(encodePoll()) - 1).toBe(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES);
      expect(await supervisor.launch(poll, TEST_WORKER_ENDPOINT)).toMatchObject({
        state: "running",
        worker: running.worker,
      });
      expect((await waitForTerminal(supervisor, poll.launchId)).state).toBe("completed");
      expect(
        JSON.parse(
          fs.readFileSync(path.join(workspaceDir, `${poll.launchId}.background.json`), "utf8"),
        ),
      ).toEqual({ ...background, response: "preview-ready" });

      const waiting = nextTurn("preview-cancel", "background-wait");
      await supervisor.launch(waiting, TEST_WORKER_ENDPOINT);
      await vi.waitFor(() =>
        expect(fs.existsSync(path.join(workspaceDir, `${waiting.launchId}.started.json`))).toBe(
          true,
        ),
      );
      expect(await supervisor.cancel(testNodeWorkerLaunchIdentity(first))).toEqual(completed);
      expect((await supervisor.status(waiting.launchId))?.state).toBe("running");
      await expect(
        supervisor.launch(nextTurn("preview-concurrent", "background-poll"), TEST_WORKER_ENDPOINT),
      ).rejects.toThrow("already has an active turn");
      expect(await supervisor.cancel(testNodeWorkerLaunchIdentity(waiting))).toMatchObject({
        state: "cancelled",
        worker: running.worker,
      });
      expect(inspectNodeWorkerProcessIdentity(server)).toBe("live");
      expect(await (await fetch(background.url)).text()).toBe("preview-ready");

      const afterCancel = nextTurn("preview-after-cancel", "background-poll");
      expect(await supervisor.launch(afterCancel, TEST_WORKER_ENDPOINT)).toMatchObject({
        worker: running.worker,
      });
      expect((await waitForTerminal(supervisor, afterCancel.launchId)).state).toBe("completed");
      expect(store.listNonterminal()).toHaveLength(1);
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      for (const mismatch of [
        { ...environment, gatewayNamespace: "other-gateway" },
        { ...environment, sessionId: "other-session" },
        { ...environment, ownerEpoch: environment.ownerEpoch + 1 },
      ]) {
        await supervisor.stopEnvironment(mismatch);
        expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
      }
      await supervisor.stopEnvironment(environment);
      await vi.waitFor(() => expectBackgroundRetired(connection!, running.worker!, server));
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 1 });
      expect(await supervisor.status(first.launchId)).toEqual(completed);
      expect((await supervisor.status(waiting.launchId))?.state).toBe("cancelled");
    } finally {
      try {
        await supervisor.close();
      } finally {
        await connection?.dispose();
      }
    }
  });

  it("closes a retained worker and its server after its turn receipt is already complete", async () => {
    const { supervisor, workspaceDir } = fixture({ capacity: 1 });
    const input = testWorkerLaunchInput(workspaceDir, "preview-close", "background-start");
    let connection: BackgroundConnection | undefined;
    try {
      const running = await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      const completed = await waitForTerminal(supervisor, input.launchId);
      const background = JSON.parse(
        fs.readFileSync(path.join(workspaceDir, `${input.launchId}.background.json`), "utf8"),
      ) as { pid: number; url: string };
      const server = requireNodeWorkerProcessIdentity(background.pid);
      connection = await observeBackgroundConnection(background.url);
      expect(await (await fetch(background.url)).text()).toBe("preview-ready");

      await supervisor.close();

      expect(await supervisor.status(input.launchId)).toEqual(completed);
      await vi.waitFor(() => expectBackgroundRetired(connection!, running.worker!, server));
    } finally {
      try {
        await supervisor.close();
      } finally {
        await connection?.dispose();
      }
    }
  });

  it("does not use a pruned first-turn receipt as authority over a later retained turn", async () => {
    const { env, supervisor, workspaceDir } = fixture({ capacity: 1 });
    const first = testWorkerLaunchInput(workspaceDir, "pruned-first", "background-start");
    const next = testWorkerLaunchInput(workspaceDir, "current-second", "background-wait");
    const turns = new NodeWorkerTurnStore({ env });
    try {
      await supervisor.launch(first, TEST_WORKER_ENDPOINT);
      const completed = await waitForTerminal(supervisor, first.launchId);
      const running = await supervisor.launch(next, TEST_WORKER_ENDPOINT);
      await vi.waitFor(() =>
        expect(fs.existsSync(path.join(workspaceDir, `${next.launchId}.started.json`))).toBe(true),
      );
      turns.claim({
        claim: { ...testNodeWorkerLaunchIdentity(next), gatewayNamespace: next.gatewayNamespace },
        ownerLaunchId: first.launchId,
        supervisor: running.supervisor,
        worker: running.worker,
        nowMs: completed.completedAtMs! + 24 * 60 * 60 * 1_000 + 1,
      });

      expect(turns.get(first.launchId)).toBeUndefined();
      expect(new NodeWorkerLaunchStore({ env }).get(first.launchId)).toMatchObject({
        state: "running",
        worker: running.worker,
      });
      expect(await supervisor.status(first.launchId)).toBeUndefined();
      expect(await supervisor.cancel(testNodeWorkerLaunchIdentity(first))).toBeUndefined();
      expect(await supervisor.status(next.launchId)).toMatchObject({ state: "running" });
      expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
      const background = JSON.parse(
        fs.readFileSync(path.join(workspaceDir, `${first.launchId}.background.json`), "utf8"),
      ) as { url: string };
      expect(await (await fetch(background.url)).text()).toBe("preview-ready");

      await supervisor.cancel(testNodeWorkerLaunchIdentity(next));
      await expect(supervisor.launch(first, TEST_WORKER_ENDPOINT)).rejects.toThrow();
      expect(turns.get(first.launchId)).toBeUndefined();
      expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
    } finally {
      await supervisor.close();
    }
  });

  it.each([
    "session",
    "owner epoch",
    "placement generation",
    "agent",
    "workspace",
    "containment",
    "permissions",
    "bundle",
  ] as const)("retires a retained worker before replacing its %s binding", async (binding) => {
    const { bundleRoot, root, supervisor, workspaceDir } = fixture({ capacity: 1 });
    const first = testWorkerLaunchInput(workspaceDir, "binding-first", "background-start");
    first.descriptor.assignment = {
      ...first.descriptor.assignment,
      permissionMode: "full",
      workerContainmentRoot: workspaceDir,
    };
    const next = structuredClone(first);
    next.launchId = "binding-next";
    next.descriptor.assignment.turnId = next.launchId;
    switch (binding) {
      case "session":
        next.descriptor.admission.sessionId = "replacement-session";
        break;
      case "owner epoch":
        next.descriptor.admission.ownerEpoch += 1;
        break;
      case "placement generation":
        next.placementGeneration += 1;
        break;
      case "agent":
        next.descriptor.assignment.agentId = "replacement-agent";
        break;
      case "workspace": {
        const replacement = path.join(workspaceDir, "replacement");
        fs.mkdirSync(replacement);
        next.descriptor.assignment.workspaceDir = replacement;
        break;
      }
      case "containment":
        next.descriptor.assignment.workerContainmentRoot = root;
        break;
      case "permissions":
        next.descriptor.assignment.permissionMode = "guarded";
        break;
      case "bundle": {
        const hash = "b".repeat(64);
        const bundle = path.join(bundleRoot, first.gatewayNamespace, "bundles", hash);
        fs.mkdirSync(bundle);
        fs.writeFileSync(path.join(bundle, "worker.mjs"), TEST_WORKER_SOURCE);
        next.expectedBundleHash = hash;
        next.descriptor.admission.handshake.bundleHash = hash;
        break;
      }
    }
    let connection: BackgroundConnection | undefined;
    try {
      const original = await supervisor.launch(first, TEST_WORKER_ENDPOINT);
      const completed = await waitForTerminal(supervisor, first.launchId);
      const background = JSON.parse(
        fs.readFileSync(path.join(workspaceDir, `${first.launchId}.background.json`), "utf8"),
      ) as { pid: number; url: string };
      const server = requireNodeWorkerProcessIdentity(background.pid);
      connection = await observeBackgroundConnection(background.url);
      next.descriptor.assignment.prompt = `background-start:${new URL(background.url).port}`;

      const replacement = await supervisor.launch(next, TEST_WORKER_ENDPOINT);
      expect(replacement.worker).not.toEqual(original.worker);
      expect((await waitForTerminal(supervisor, next.launchId)).state).toBe("completed");
      await vi.waitFor(() => expectBackgroundRetired(connection!, original.worker!, server));
      const replacementBackground = JSON.parse(
        fs.readFileSync(
          path.join(next.descriptor.assignment.workspaceDir, `${next.launchId}.background.json`),
          "utf8",
        ),
      ) as { pid: number; url: string };
      expect(replacementBackground.url).toBe(background.url);
      expect(inspectNodeWorkerProcessIdentity(replacement.worker!)).toBe("live");
      expect(
        inspectNodeWorkerProcessIdentity(
          requireNodeWorkerProcessIdentity(replacementBackground.pid),
        ),
      ).toBe("live");
      expect(await (await fetch(background.url)).text()).toBe("preview-ready");
      expect(await supervisor.status(first.launchId)).toEqual(completed);
      if (binding === "owner epoch" || binding === "session") {
        await supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(first));
        expect(inspectNodeWorkerProcessIdentity(replacement.worker!)).toBe("live");
      }
    } finally {
      try {
        await supervisor.close();
      } finally {
        await connection?.dispose();
      }
    }
  });

  it("does not observe retirement before teardown, connection close, and definitive identity", async () => {
    const { supervisor, workspaceDir } = fixture({ capacity: 1 });
    const first = testWorkerLaunchInput(workspaceDir, "held-first", "background-start");
    const next = structuredClone(first);
    next.launchId = next.descriptor.assignment.turnId = "held-next";
    next.descriptor.admission.ownerEpoch += 1;
    const signalTree = processTree.signalProcessTree;
    const heldSignals: Array<Parameters<typeof signalTree>> = [];
    let connection: BackgroundConnection | undefined;
    let restoreSignals: (() => void) | undefined;
    let restoreClose: (() => void) | undefined;
    let restoreIdentity: (() => void) | undefined;
    let releaseClose: (() => void) | undefined;
    let replacement: ReturnType<NodeWorkerSupervisor["launch"]> | undefined;
    const releaseSignals = () => {
      restoreSignals?.();
      restoreSignals = undefined;
      for (const args of heldSignals.splice(0)) {
        signalTree(...args);
      }
    };
    try {
      const original = await supervisor.launch(first, TEST_WORKER_ENDPOINT);
      await waitForTerminal(supervisor, first.launchId);
      const background = JSON.parse(
        fs.readFileSync(path.join(workspaceDir, `${first.launchId}.background.json`), "utf8"),
      ) as { pid: number; url: string };
      const server = requireNodeWorkerProcessIdentity(background.pid);
      connection = await observeBackgroundConnection(background.url);
      next.descriptor.assignment.prompt = `background-start:${new URL(background.url).port}`;
      const socket = connection.socket;
      const emit = socket.emit.bind(socket);
      // Withhold only this owned socket's close delivery, after the real OS close.
      const close = vi.spyOn(socket, "emit").mockImplementation((event, ...args) => {
        if (event === "close") {
          releaseClose = () => emit(event, ...args);
          return true;
        }
        return emit(event, ...args);
      });
      restoreClose = () => close.mockRestore();
      const signals = vi.spyOn(processTree, "signalProcessTree").mockImplementation((...args) => {
        if (args[0] !== original.worker!.pid) {
          signalTree(...args);
          return;
        }
        heldSignals.push(args);
      });
      restoreSignals = () => signals.mockRestore();
      const assertRetired = () => expectBackgroundRetired(connection!, original.worker!, server);
      replacement = supervisor.launch(next, TEST_WORKER_ENDPOINT);
      void replacement.catch(() => undefined);
      await vi.waitFor(() => expect(heldSignals.length).toBeGreaterThan(0));
      expect(await (await fetch(background.url)).text()).toBe("preview-ready");
      expect(inspectNodeWorkerProcessIdentity(original.worker!)).toBe("live");
      expect(inspectNodeWorkerProcessIdentity(server)).toBe("live");
      expect(socket.closed).toBe(false);
      expect(assertRetired).toThrow();

      releaseSignals();
      await vi.waitFor(() => expect(releaseClose).toBeDefined());
      await replacement;
      await waitForTerminal(supervisor, next.launchId);
      await vi.waitFor(() => {
        expect(inspectNodeWorkerProcessIdentity(original.worker!)).toMatch(/^(dead|reused)$/u);
        expect(inspectNodeWorkerProcessIdentity(server)).toMatch(/^(dead|reused)$/u);
      });
      expect(assertRetired).toThrow();

      const identity = await import("./node-worker-process-identity.js");
      const inspect = identity.inspectNodeWorkerProcessIdentity;
      const unknown = vi
        .spyOn(identity, "inspectNodeWorkerProcessIdentity")
        .mockImplementation((owner) =>
          owner.pid === server.pid && owner.startTime === server.startTime
            ? "unknown"
            : inspect(owner),
        );
      restoreIdentity = () => unknown.mockRestore();
      restoreClose();
      restoreClose = undefined;
      releaseClose!();
      releaseClose = undefined;
      await connection.closed;
      expect(await (await fetch(background.url)).text()).toBe("preview-ready");
      expect(inspectNodeWorkerProcessIdentity(server)).toBe("unknown");
      expect(assertRetired).toThrow();

      restoreIdentity();
      restoreIdentity = undefined;
      assertRetired();
    } finally {
      restoreIdentity?.();
      releaseSignals();
      restoreClose?.();
      releaseClose?.();
      try {
        await supervisor.close();
      } finally {
        await connection?.dispose();
        await Promise.allSettled([replacement]);
      }
    }
  });

  it.each(["owner epoch", "placement generation"] as const)(
    "rejects an older %s without disturbing the retained worker",
    async (binding) => {
      const { supervisor, workspaceDir } = fixture({ capacity: 1 });
      const first = testWorkerLaunchInput(workspaceDir, "current-owner", "background-start");
      const stale = testWorkerLaunchInput(workspaceDir, "stale-owner", "background-poll");
      if (binding === "owner epoch") {
        stale.descriptor.admission.ownerEpoch -= 1;
      } else {
        stale.placementGeneration -= 1;
      }
      try {
        const running = await supervisor.launch(first, TEST_WORKER_ENDPOINT);
        await waitForTerminal(supervisor, first.launchId);
        await expect(supervisor.launch(stale, TEST_WORKER_ENDPOINT)).rejects.toThrow(
          "belongs to a replaced environment",
        );
        expect(inspectNodeWorkerProcessIdentity(running.worker!)).toBe("live");
        const background = JSON.parse(
          fs.readFileSync(path.join(workspaceDir, `${first.launchId}.background.json`), "utf8"),
        ) as { url: string };
        expect(await (await fetch(background.url)).text()).toBe("preview-ready");
      } finally {
        await supervisor.close();
      }
    },
  );

  it.each(["environment stop", "supervisor close"] as const)(
    "%s aborts admission behind a stalled retiring worker",
    async (operation) => {
      const { env, supervisor, workspaceDir } = fixture({ capacity: 2 });
      const first = testWorkerLaunchInput(workspaceDir, "retiring-owner", "retire-stall");
      const next = testWorkerLaunchInput(workspaceDir, "waiting-for-retirement", "wait");
      const sibling = launchInput(workspaceDir, "outside-retiring-environment", "wait");
      const store = new NodeWorkerLaunchStore({ env });
      let owner: Awaited<ReturnType<NodeWorkerSupervisor["launch"]>> | undefined;
      let admission: Promise<unknown> | undefined;
      let shutdown: Promise<unknown> | undefined;
      let admissionError: unknown;
      let shutdownError: unknown;
      let stopped = false;
      try {
        owner = await supervisor.launch(first, TEST_WORKER_ENDPOINT);
        const completed = await waitForTerminal(supervisor, first.launchId);
        const unrelated = await supervisor.launch(sibling, TEST_WORKER_ENDPOINT);
        expect(store.get(first.launchId)?.state).toBe("running");
        expect(inspectNodeWorkerProcessIdentity(owner.worker!)).toBe("live");

        const readOwner = vi.spyOn(NodeWorkerLaunchStore.prototype, "get");
        admission = supervisor.launch(next, TEST_WORKER_ENDPOINT).catch((error: unknown) => {
          admissionError = error;
        });
        await vi.waitFor(() => expect(readOwner).toHaveBeenCalledWith(first.launchId));
        readOwner.mockRestore();
        const stopping =
          operation === "environment stop"
            ? supervisor.stopEnvironment(testNodeWorkerEnvironmentIdentity(first))
            : supervisor.close();
        shutdown = stopping.then(
          () => {
            stopped = true;
          },
          (error: unknown) => {
            shutdownError = error;
          },
        );

        await vi.waitFor(
          () => {
            expect(admissionError).toMatchObject({
              message:
                operation === "environment stop"
                  ? "node worker environment stopped"
                  : "node worker supervisor is closed",
            });
            expect(shutdownError).toBeUndefined();
            expect(stopped).toBe(true);
            expect(inspectNodeWorkerProcessIdentity(owner!.worker!)).not.toBe("live");
          },
          { timeout: 3_000 },
        );
        expect(store.get(first.launchId)?.state).toBe("interrupted");
        expect(await supervisor.status(first.launchId)).toEqual(completed);
        expect(await supervisor.status(next.launchId)).toBeUndefined();
        expect(fs.existsSync(path.join(workspaceDir, `${next.launchId}.started.json`))).toBe(false);
        if (operation === "environment stop") {
          expect(inspectNodeWorkerProcessIdentity(unrelated.worker!)).toBe("live");
          expect(await supervisor.status(sibling.launchId)).toMatchObject({ state: "running" });
          await expect(supervisor.launch(next, TEST_WORKER_ENDPOINT)).resolves.toMatchObject({
            state: "running",
          });
        } else {
          expect(inspectNodeWorkerProcessIdentity(unrelated.worker!)).not.toBe("live");
          expect(store.listNonterminal()).toEqual([]);
        }
      } finally {
        // Break the injected retirement stall even when the pre-fix admission never aborts.
        if (owner?.worker && inspectNodeWorkerProcessIdentity(owner.worker) === "live") {
          process.kill(owner.worker.pid, "SIGKILL");
        }
        await Promise.allSettled([admission, shutdown]);
        await supervisor.close();
      }
    },
  );
});
