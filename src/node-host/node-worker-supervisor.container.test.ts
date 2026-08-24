import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { WorkerConnectionEndpoint } from "../worker/worker-connection-endpoint.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import { requireNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const endpoint: WorkerConnectionEndpoint = {
  kind: "websocket",
  url: "wss://gateway.example/__openclaw__/worker",
};
const hostLabel = "openclaw.node-worker.host";
const gatewayLabel = "openclaw.node-worker.gateway";
const launchLabel = "openclaw.node-worker.launch";

const stdioWorkerSource = String.raw`
import fs from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const descriptor = JSON.parse(input);
if (process.connected || process.argv.includes("--internal-worker-ipc")) {
  process.stderr.write("container worker unexpectedly received Node IPC");
  process.exit(24);
}
if (descriptor.assignment.prompt === "wait") {
  fs.writeFileSync(descriptor.assignment.workspaceDir + "/worker-started", "started");
  setInterval(() => {}, 1000);
} else {
  await new Promise((resolve) => setTimeout(resolve, 35));
  process.stdout.write(JSON.stringify({
    status: "completed",
    argv: process.argv.slice(2),
    endpoint: descriptor.connectionEndpoint,
  }) + "\n");
}
`;

const fakeEngineSource = String.raw`
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const command = args[0];
const statePath = (id) => path.join(engineRoot, id + ".container.json");
const load = (id) => JSON.parse(fs.readFileSync(statePath(id), "utf8"));
const save = (container) => fs.writeFileSync(statePath(container.id), JSON.stringify(container));
const launchIdFor = (container) =>
  Buffer.from(container.labels["openclaw.node-worker.launch"], "base64url").toString("utf8");
const journalState = (launchId) => {
  try {
    const database = new DatabaseSync(path.join(stateRoot, "state", "openclaw.sqlite"), { readOnly: true });
    const row = database.prepare("SELECT state FROM node_worker_launches WHERE launch_id = ?").get(launchId);
    const hasContainerTable = database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'node_worker_launch_containers'",
    ).get();
    const container = hasContainerTable
      ? database.prepare(
        "SELECT container_json FROM node_worker_launch_containers WHERE launch_id = ?",
      ).get(launchId)
      : undefined;
    database.close();
    return row && { state: row.state, container_json: container?.container_json ?? null };
  } catch {
    return undefined;
  }
};
const record = (entry) => fs.appendFileSync(commandLog, JSON.stringify(entry) + "\n");
const releaseAfterMarker = (marker, operation) => {
  const markerPath = path.join(engineRoot, marker);
  if (!fs.existsSync(markerPath)) {
    operation();
    return;
  }
  const timer = setInterval(() => {
    if (!fs.existsSync(markerPath)) {
      clearInterval(timer);
      operation();
    }
  }, 10);
};
const missing = (id) => {
  process.stderr.write("Error: No such object: " + id + "\n");
  process.exit(1);
};
const readContainer = (id) => {
  if (!fs.existsSync(statePath(id))) missing(id);
  return load(id);
};

if (command === "version") {
  record({ argv: args });
  process.stdout.write("27.0.0\n");
} else if (command === "info") {
  const daemonId = fs.readFileSync(path.join(engineRoot, "daemon-id"), "utf8");
  record({ argv: args, daemonId });
  process.stdout.write(daemonId + "\n");
} else if (command === "create") {
  const id = createHash("sha256").update(JSON.stringify(args)).digest("hex");
  const labels = {};
  const env = {};
  const mounts = [];
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--label" || args[index] === "--env") {
      const value = args[++index];
      const separator = value.indexOf("=");
      (args[index - 1] === "--label" ? labels : env)[value.slice(0, separator)] = value.slice(separator + 1);
    } else if (args[index] === "--mount") {
      mounts.push(args[++index]);
    }
  }
  const entry = args.at(-1);
  const image = args.at(-2);
  const container = { id, labels, env, mounts, image, entry, running: false, pid: null };
  save(container);
  record({ argv: args, container, journal: journalState(launchIdFor(container)) });
  releaseAfterMarker("hold-create", () => process.stdout.write(id + "\n"));
} else if (command === "start") {
  void (async () => {
    let descriptor = "";
    for await (const chunk of process.stdin) descriptor += chunk;
    const container = readContainer(args.at(-1));
    const journal = journalState(launchIdFor(container));
    record({ argv: args, journal });
    const persisted = journal?.container_json && JSON.parse(journal.container_json);
    if (
      journal?.state !== "running" ||
      persisted?.containerId !== container.id ||
      persisted?.engineTarget !== expectedEngineTarget
    ) {
      process.stderr.write("container worker executed before its exact identity was journaled\n");
      process.exit(67);
    }
    const child = spawn(process.execPath, [container.entry], {
      detached: process.platform !== "win32",
      env: container.env,
      stdio: ["pipe", "inherit", "inherit"],
    });
    container.running = true;
    container.pid = child.pid;
    save(container);
    child.stdin.end(descriptor);
    child.once("error", (error) => {
      process.stderr.write(error.message + "\n");
      process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      if (fs.existsSync(statePath(container.id))) {
        const current = load(container.id);
        current.running = false;
        current.pid = null;
        save(current);
      }
      process.exitCode = code ?? (signal ? 137 : 0);
    });
  })().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
} else if (command === "inspect") {
  const id = args.at(-1);
  record({ argv: args });
  const container = readContainer(id);
  const format = args[args.indexOf("--format") + 1];
  const columns = [String(container.running)];
  if (format.includes("openclaw.node-worker.host")) {
    columns.push(
      container.labels["openclaw.node-worker.host"] ?? "",
      container.labels["openclaw.node-worker.gateway"] ?? "",
      container.labels["openclaw.node-worker.launch"] ?? "",
    );
  }
  process.stdout.write(columns.join("\t") + "\n");
} else if (command === "kill") {
  const container = readContainer(args.at(-1));
  record({ argv: args, journal: journalState(launchIdFor(container)) });
  if (!container.running) {
    process.stderr.write("container is not running\n");
    process.exit(1);
  }
  container.running = false;
  save(container);
  if (container.pid) {
    try {
      process.kill(process.platform === "win32" ? container.pid : -container.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  process.stdout.write(container.id + "\n");
} else if (command === "rm") {
  const container = readContainer(args.at(-1));
  record({ argv: args, journal: journalState(launchIdFor(container)) });
  if (fs.existsSync(path.join(engineRoot, "fail-removal"))) {
    process.stderr.write("injected container removal failure\n");
    process.exit(1);
  }
  releaseAfterMarker("hold-removal", () => {
    fs.unlinkSync(statePath(container.id));
    process.stdout.write(container.id + "\n");
  });
} else if (command === "ps") {
  record({ argv: args });
  const ownerFilter = args.find((arg) => arg.startsWith("label=openclaw.node-worker.host="));
  const owner = ownerFilter?.slice("label=openclaw.node-worker.host=".length);
  for (const file of fs.readdirSync(engineRoot).sort()) {
    if (!file.endsWith(".container.json")) continue;
    const container = JSON.parse(fs.readFileSync(path.join(engineRoot, file), "utf8"));
    if (container.labels["openclaw.node-worker.host"] !== owner) continue;
    process.stdout.write([
      container.id,
      container.labels["openclaw.node-worker.gateway"],
      container.labels["openclaw.node-worker.launch"],
    ].join("\t") + "\n");
  }
} else {
  record({ argv: args });
  process.stderr.write("unsupported fake engine command: " + command + "\n");
  process.exit(2);
}
`;

type FakeContainer = {
  id: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  mounts: string[];
  image: string;
  entry: string;
  running: boolean;
  pid: number | null;
};

type EngineEvent = {
  argv: string[];
  container?: FakeContainer;
  daemonId?: string;
  journal?: { state: string; container_json: string | null };
};

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

function containerFixture(
  options: {
    image?: string;
    env?: NodeJS.ProcessEnv;
    capacity?: number;
    onCapacityChanged?: (capacity: { total: number; available: number }) => void;
  } = {},
) {
  const root = tempDirs.make("node-worker-container-");
  const { bundleRoot, env, stateDir, workspaceDir } = writeNodeWorkerFixture(root);
  const bundleEntry = path.join(bundleRoot, "gateway-1", "bundles", "a".repeat(64), "worker.mjs");
  fs.writeFileSync(bundleEntry, stdioWorkerSource);
  const engineRoot = path.join(root, "fake-engine");
  const commandLog = path.join(engineRoot, "commands.jsonl");
  const command = path.join(engineRoot, "docker");
  const daemonId = "fake-original-daemon";
  const engineTarget = createHash("sha256").update(`docker\0${daemonId}`).digest("hex");
  fs.mkdirSync(engineRoot);
  fs.writeFileSync(path.join(engineRoot, "daemon-id"), daemonId);
  fs.writeFileSync(
    command,
    `#!${process.execPath}\nconst engineRoot = ${JSON.stringify(engineRoot)};\nconst stateRoot = ${JSON.stringify(stateDir)};\nconst commandLog = ${JSON.stringify(commandLog)};\nconst expectedEngineTarget = ${JSON.stringify(engineTarget)};\n${fakeEngineSource}`,
    { mode: 0o755 },
  );
  const containerEngine = {
    id: "docker" as const,
    command,
    target: engineTarget,
    env: { PATH: process.env.PATH, DOCKER_HOST: "unix:///fake-node-worker-daemon.sock" },
  };
  const workerEnv = { ...env, ...options.env };
  const supervisor = createNodeWorkerSupervisor({
    bundleRoot,
    env: workerEnv,
    containerEngine,
    ...(options.image ? { containerImage: options.image } : {}),
    ...(options.capacity ? { capacity: options.capacity } : {}),
    ...(options.onCapacityChanged ? { onCapacityChanged: options.onCapacityChanged } : {}),
  });
  const owner = createHash("sha256").update(bundleRoot).digest("hex").slice(0, 32);
  return {
    bundleEntry,
    bundleRoot,
    containerEngine,
    engineRoot,
    env: workerEnv,
    owner,
    stateDir,
    supervisor,
    workspaceDir,
    events(): EngineEvent[] {
      if (!fs.existsSync(commandLog)) {
        return [];
      }
      return fs
        .readFileSync(commandLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as EngineEvent);
    },
    seed(params: { id: string; launchId: string; owner?: string; running?: boolean }) {
      const container: FakeContainer = {
        id: params.id,
        labels: {
          [hostLabel]: params.owner ?? owner,
          [gatewayLabel]: "gateway-1",
          [launchLabel]: Buffer.from(params.launchId).toString("base64url"),
        },
        env: {},
        mounts: [],
        image: "node:22-slim",
        entry: bundleEntry,
        running: params.running ?? true,
        pid: null,
      };
      fs.writeFileSync(
        path.join(engineRoot, `${params.id}.container.json`),
        JSON.stringify(container),
      );
      return container;
    },
    exists(id: string) {
      return fs.existsSync(path.join(engineRoot, `${id}.container.json`));
    },
  };
}

async function waitForTerminal(
  supervisor: ReturnType<typeof createNodeWorkerSupervisor>,
  launchId: string,
) {
  await vi.waitFor(
    async () => {
      expect((await supervisor.status(launchId))?.state).not.toMatch(/^(?:pending|running)$/u);
    },
    { timeout: 5_000 },
  );
  return await supervisor.status(launchId);
}

async function waitForWorkerStarted(workspaceDir: string): Promise<void> {
  await vi.waitFor(
    () => expect(fs.existsSync(path.join(workspaceDir, "worker-started"))).toBe(true),
    { timeout: 5_000 },
  );
}

function claimFixtureLaunch(
  fixture: ReturnType<typeof containerFixture>,
  launchId: string,
  containerId?: string,
) {
  const input = testWorkerLaunchInput(fixture.workspaceDir, launchId, "wait");
  const identity = testNodeWorkerLaunchIdentity(input);
  const supervisor = { pid: 2_147_483_647, startTime: 1 };
  const worker = { pid: 2_147_483_646, startTime: 1 };
  const store = new NodeWorkerLaunchStore({ env: fixture.env });
  store.claim({ ...identity, gatewayNamespace: input.gatewayNamespace }, supervisor, 8);
  if (containerId) {
    store.markRunning({
      launchId,
      planHash: identity.planHash,
      supervisor,
      worker,
      container: { engine: "docker", engineTarget: fixture.containerEngine.target, containerId },
    });
  }
  return { input, store };
}

describe("node worker supervisor container isolation", () => {
  it("mounts only the admitted bundle and workspace and round-trips the stdio result", async () => {
    const fixture = containerFixture({
      image: "node:24-slim@sha256:" + "f".repeat(64),
      env: {
        HOME: "/private/operator-home",
        LANG: "en_US.UTF-8",
        PATH: "/private/operator-bin",
        TMPDIR: "/private/operator-temp",
        NODE_OPTIONS: "--title=forbidden-worker-title",
        SUPPLIED_SECRET: "must-not-enter-container",
      },
    });
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-success");

    try {
      const running = await fixture.supervisor.launch(input, endpoint);
      expect(running).toMatchObject({
        state: "running",
        container: {
          engine: "docker",
          engineTarget: fixture.containerEngine.target,
          containerId: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      const completed = await waitForTerminal(fixture.supervisor, input.launchId);
      expect(completed?.state).toBe("completed");
      expect(JSON.parse(completed?.resultJson ?? "null")).toEqual({
        status: "completed",
        argv: [],
        endpoint,
      });

      const create = fixture.events().find((event) => event.argv[0] === "create");
      expect(create?.container?.labels).toEqual({
        [hostLabel]: fixture.owner,
        [gatewayLabel]: "gateway-1",
        [launchLabel]: Buffer.from(input.launchId).toString("base64url"),
      });
      const bundleDir = path.dirname(fixture.bundleEntry);
      expect(create?.container?.mounts).toEqual([
        `type=bind,source=${bundleDir},target=${bundleDir},readonly`,
        `type=bind,source=${fixture.workspaceDir},target=${fixture.workspaceDir}`,
      ]);
      expect(create?.argv).toContain("--interactive");
      expect(create?.argv).toContain("--workdir");
      expect(create?.argv).toContain(fixture.workspaceDir);
      expect(create?.container?.image).toBe("node:24-slim@sha256:" + "f".repeat(64));
      expect(create?.container?.env).toMatchObject({
        HOME: fixture.workspaceDir,
        LANG: "en_US.UTF-8",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        TMPDIR: "/tmp",
        NODE_COMPILE_CACHE: "/tmp/openclaw-node-worker-compile-cache",
        OPENCLAW_NO_RESPAWN: "1",
      });
      expect(create?.container?.env).not.toHaveProperty("NODE_OPTIONS");
      expect(create?.container?.env).not.toHaveProperty("SUPPLIED_SECRET");
      expect(create?.container?.env).not.toHaveProperty("OPENCLAW_STATE_DIR");
      const started = fixture.events().find((event) => event.argv[0] === "start");
      expect(started?.argv).toEqual([
        "start",
        "--attach",
        "--interactive",
        running.container!.containerId,
      ]);
      expect(started?.journal).toMatchObject({
        state: "running",
        container_json: JSON.stringify(running.container),
      });
    } finally {
      await fixture.supervisor.close();
    }
  });

  it("uses the documented Node 22 image when no override is configured", async () => {
    const fixture = containerFixture();
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-default-image");
    try {
      await fixture.supervisor.launch(input, endpoint);
      await waitForTerminal(fixture.supervisor, input.launchId);
      expect(fixture.events().find((event) => event.argv[0] === "create")?.container?.image).toBe(
        "node:22-slim",
      );
    } finally {
      await fixture.supervisor.close();
    }
  });

  it("rejects a daemon switch before launch so the replacement receives zero create or start requests", async () => {
    const fixture = containerFixture();
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-replacement-daemon");
    const replacementDaemonId = "fake-replacement-daemon";
    const replacementTarget = createHash("sha256")
      .update(`docker\0${replacementDaemonId}`)
      .digest("hex");

    try {
      await fixture.supervisor.initialize();
      const startupEventCount = fixture.events().length;
      fs.writeFileSync(path.join(fixture.engineRoot, "daemon-id"), replacementDaemonId);

      const failed = await fixture.supervisor.launch(input, endpoint);

      expect(failed).toMatchObject({ state: "failed" });
      expect(failed.errorText).toContain(fixture.containerEngine.target);
      expect(failed.errorText).toContain(replacementTarget);
      const replacementEvents = fixture.events().slice(startupEventCount);
      expect(replacementEvents.filter((event) => event.argv[0] === "info")).toHaveLength(1);
      expect(
        replacementEvents.filter(
          (event) => event.argv[0] === "create" || event.argv[0] === "start",
        ),
      ).toEqual([]);
    } finally {
      await fixture.supervisor.close();
    }
  });

  it("keeps a pending cancelled container slot occupied until the fake engine confirms removal", async () => {
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const fixture = containerFixture({
      capacity: 1,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-pending-cancel", "wait");
    const createMarker = path.join(fixture.engineRoot, "hold-create");
    const removalMarker = path.join(fixture.engineRoot, "hold-removal");
    const store = new NodeWorkerLaunchStore({ env: fixture.env });
    fs.writeFileSync(createMarker, "hold");
    fs.writeFileSync(removalMarker, "hold");

    try {
      const launch = fixture.supervisor.launch(input, endpoint);
      await vi.waitFor(
        () => expect(fixture.events().some((event) => event.argv[0] === "create")).toBe(true),
        { timeout: 5_000 },
      );
      expect(store.get(input.launchId)?.state).toBe("pending");

      const cancellation = fixture.supervisor.cancel(testNodeWorkerLaunchIdentity(input));
      await vi.waitFor(() => expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 }));
      expect(store.get(input.launchId)?.state).toBe("pending");

      fs.unlinkSync(createMarker);
      await vi.waitFor(
        () => expect(fixture.events().some((event) => event.argv[0] === "rm")).toBe(true),
        { timeout: 5_000 },
      );
      expect(store.get(input.launchId)?.state).toMatch(/^(?:pending|running)$/u);
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      fs.unlinkSync(removalMarker);
      await expect(cancellation).resolves.toMatchObject({ state: "cancelled" });
      await launch;
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 1 });
      expect(fixture.events().find((event) => event.argv[0] === "rm")?.journal?.state).toMatch(
        /^(?:pending|running)$/u,
      );
    } finally {
      for (const marker of [createMarker, removalMarker]) {
        if (fs.existsSync(marker)) {
          fs.unlinkSync(marker);
        }
      }
      await fixture.supervisor.close();
    }
  });

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)(
    "%s kills and removes the container before terminal persistence",
    async (operation, state) => {
      const fixture = containerFixture();
      const input = testWorkerLaunchInput(fixture.workspaceDir, `container-${operation}`, "wait");

      try {
        const running = await fixture.supervisor.launch(input, endpoint);
        await waitForWorkerStarted(fixture.workspaceDir);
        if (operation === "cancel") {
          await fixture.supervisor.cancel(testNodeWorkerLaunchIdentity(input));
        } else {
          await fixture.supervisor.close();
        }

        expect(await fixture.supervisor.status(input.launchId)).toMatchObject({
          state,
          container: running.container,
        });
        expect(fixture.exists(running.container!.containerId)).toBe(false);
        const kill = fixture.events().find((event) => event.argv[0] === "kill");
        const remove = fixture.events().find((event) => event.argv[0] === "rm");
        expect(kill?.argv).toEqual(["kill", running.container!.containerId]);
        expect(remove?.argv).toEqual(["rm", "--force", running.container!.containerId]);
        expect(kill?.journal?.state).toBe("running");
        expect(remove?.journal?.state).toBe("running");
      } finally {
        await fixture.supervisor.close();
      }
    },
  );

  it("sweeps owned orphan containers before finalizing stale pending launches", async () => {
    const fixture = containerFixture();
    const launchId = "container-pending\torphan\nline";
    const orphan = fixture.seed({ id: "a".repeat(64), launchId });
    const foreign = fixture.seed({
      id: "b".repeat(64),
      launchId: "other-node-host",
      owner: "f".repeat(32),
    });
    claimFixtureLaunch(fixture, launchId);

    try {
      await fixture.supervisor.initialize();

      expect(fixture.exists(orphan.id)).toBe(false);
      expect(fixture.exists(foreign.id)).toBe(true);
      expect(await fixture.supervisor.status(launchId)).toMatchObject({ state: "interrupted" });
      const orphanKill = fixture
        .events()
        .find((event) => event.argv[0] === "kill" && event.argv[1] === orphan.id);
      expect(orphanKill?.journal?.state).toBe("pending");
      expect(fixture.events().some((event) => event.argv.includes(foreign.id))).toBe(false);
    } finally {
      await fixture.supervisor.close();
    }
  });

  it("preserves a live foreign supervisor's pending container during reconciliation", async () => {
    const fixture = containerFixture();
    const launchId = "container-live-pending";
    const container = fixture.seed({ id: "e".repeat(64), launchId });
    const input = testWorkerLaunchInput(fixture.workspaceDir, launchId, "wait");
    const identity = testNodeWorkerLaunchIdentity(input);
    const store = new NodeWorkerLaunchStore({ env: fixture.env });
    store.claim(
      { ...identity, gatewayNamespace: input.gatewayNamespace },
      requireNodeWorkerProcessIdentity(process.pid),
      8,
    );

    try {
      await fixture.supervisor.initialize();

      expect(store.get(launchId)).toMatchObject({ state: "pending" });
      expect(fixture.exists(container.id)).toBe(true);
      expect(fixture.events().some((event) => event.argv[0] === "kill")).toBe(false);
    } finally {
      await fixture.supervisor.close();
    }
  });

  it("interrupts a stale running journal after verifying its dead container identity", async () => {
    const fixture = containerFixture();
    const launchId = "container-dead-recovery";
    const container = fixture.seed({ id: "c".repeat(64), launchId, running: false });
    claimFixtureLaunch(fixture, launchId, container.id);

    try {
      await fixture.supervisor.initialize();

      expect(await fixture.supervisor.status(launchId)).toMatchObject({
        state: "interrupted",
        container: {
          engine: "docker",
          engineTarget: fixture.containerEngine.target,
          containerId: container.id,
        },
      });
      expect(fixture.exists(container.id)).toBe(false);
      expect(
        fixture
          .events()
          .some((event) => event.argv[0] === "inspect" && event.argv.at(-1) === container.id),
      ).toBe(true);
      expect(fixture.events().find((event) => event.argv[0] === "rm")?.journal?.state).toBe(
        "running",
      );
    } finally {
      await fixture.supervisor.close();
    }
  });

  it("refuses recovery under a different engine and preserves its authoritative journal", async () => {
    const fixture = containerFixture();
    const launchId = "container-wrong-engine";
    const container = fixture.seed({ id: "d".repeat(64), launchId });
    const { store } = claimFixtureLaunch(fixture, launchId, container.id);
    const otherEngine = createNodeWorkerSupervisor({
      bundleRoot: fixture.bundleRoot,
      env: fixture.env,
      containerEngine: {
        id: "podman",
        command: fixture.containerEngine.command,
        target: fixture.containerEngine.target,
      },
    });

    try {
      await expect(otherEngine.initialize()).rejects.toThrow(/engine|docker|podman/iu);
      expect(store.get(launchId)).toMatchObject({
        state: "running",
        container: {
          engine: "docker",
          engineTarget: fixture.containerEngine.target,
          containerId: container.id,
        },
      });
      expect(fixture.exists(container.id)).toBe(true);
      expect(fixture.events().some((event) => event.argv[0] === "kill")).toBe(false);
    } finally {
      await otherEngine.close().catch(() => undefined);
      await fixture.supervisor.close();
    }
  });

  it("rejects a Docker daemon-target switch before inspecting or sweeping its journaled container", async () => {
    const fixture = containerFixture();
    const launchId = "container-wrong-daemon-target";
    const container = fixture.seed({ id: "f".repeat(64), launchId });
    const { store } = claimFixtureLaunch(fixture, launchId, container.id);
    const switchedTarget = createNodeWorkerSupervisor({
      bundleRoot: fixture.bundleRoot,
      env: fixture.env,
      containerEngine: {
        id: "docker",
        command: fixture.containerEngine.command,
        target: "d".repeat(64),
      },
    });

    try {
      await expect(switchedTarget.initialize()).rejects.toThrow(/target|daemon|context/iu);
      expect(store.get(launchId)).toMatchObject({
        state: "running",
        container: {
          engine: "docker",
          engineTarget: fixture.containerEngine.target,
          containerId: container.id,
        },
      });
      expect(fixture.exists(container.id)).toBe(true);
      expect(fixture.events()).toEqual([]);
    } finally {
      await switchedTarget.close().catch(() => undefined);
      await fixture.supervisor.close();
    }
  });

  it("keeps the launch and capacity occupied when removal fails until cancellation can retry", async () => {
    const capacitySnapshots: Array<{ total: number; available: number }> = [];
    const fixture = containerFixture({
      capacity: 1,
      onCapacityChanged: (capacity) => capacitySnapshots.push(capacity),
    });
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-removal-failure", "wait");
    const failureMarker = path.join(fixture.engineRoot, "fail-removal");
    const store = new NodeWorkerLaunchStore({ env: fixture.env });

    try {
      const running = await fixture.supervisor.launch(input, endpoint);
      await vi.waitFor(() =>
        expect(fs.existsSync(path.join(fixture.workspaceDir, "worker-started"))).toBe(true),
      );
      fs.writeFileSync(failureMarker, "fail");

      await expect(fixture.supervisor.cancel(testNodeWorkerLaunchIdentity(input))).rejects.toThrow(
        /removal|failed|injected/iu,
      );
      expect(store.get(input.launchId)).toMatchObject({
        state: "running",
        container: running.container,
      });
      expect(fixture.exists(running.container!.containerId)).toBe(true);
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 0 });

      fs.unlinkSync(failureMarker);
      await expect(
        fixture.supervisor.cancel(testNodeWorkerLaunchIdentity(input)),
      ).resolves.toMatchObject({ state: "cancelled" });
      expect(fixture.exists(running.container!.containerId)).toBe(false);
      expect(capacitySnapshots.at(-1)).toEqual({ total: 1, available: 1 });
    } finally {
      if (fs.existsSync(failureMarker)) {
        fs.unlinkSync(failureMarker);
      }
      await fixture.supervisor.close();
    }
  });

  it("never executes a container worker when its durable identity cannot be recorded", async () => {
    const fixture = containerFixture();
    const input = testWorkerLaunchInput(fixture.workspaceDir, "container-journal-failure", "wait");
    vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(() => {
      throw new Error("injected durable container identity failure");
    });

    try {
      await expect(fixture.supervisor.launch(input, endpoint)).rejects.toThrow(
        "injected durable container identity failure",
      );

      const create = fixture.events().find((event) => event.argv[0] === "create");
      expect(create?.container?.id).toMatch(/^[a-f0-9]{64}$/u);
      expect(fixture.events().some((event) => event.argv[0] === "start")).toBe(false);
      expect(fixture.events().some((event) => event.argv[0] === "rm")).toBe(true);
      expect(fixture.exists(create!.container!.id)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await fixture.supervisor.close();
    }
  });
});
