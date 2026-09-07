export const stdioWorkerSource = String.raw`
import fs from "node:fs";
import { createInterface } from "node:readline";
let active;
let retained = false;
if (process.connected || process.argv.includes("--internal-worker-ipc") ||
    !process.argv.includes("--internal-worker-session")) {
  process.stderr.write("container worker unexpectedly received Node IPC");
  process.exit(24);
}
const completedResult = { status: "completed", transcriptLeafId: "leaf-1", transcriptNextSeq: 2 };
const finish = (descriptor, result = completedResult) => {
  if (active !== descriptor) return;
  fs.writeSync(1, JSON.stringify({
    type: "result", turnId: descriptor.assignment.turnId, result, retainWorker: retained,
  }) + "\n");
  active = undefined;
  if (!retained) process.exit(0);
};
const runTurn = async (descriptor) => {
fs.writeFileSync(descriptor.assignment.workspaceDir + "/" + descriptor.assignment.turnId + ".fixture.json", JSON.stringify({
  pid: process.pid, argv: process.argv.slice(2), endpoint: descriptor.connectionEndpoint,
}));
if (descriptor.assignment.prompt === "admission-failure") {
  throw new Error("worker admission deadline exceeded after 9 attempts to gateway.example:443: connect failed: Opening handshake has timed out " + descriptor.admission.credential);
} else if (descriptor.assignment.prompt === "wait") {
  fs.writeFileSync(descriptor.assignment.workspaceDir + "/worker-started", "started");
  return;
} else {
  retained ||= descriptor.assignment.prompt === "retain";
  await new Promise((resolve) => setTimeout(resolve, 35));
  finish(descriptor);
}
};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "cancel") {
    if (active?.assignment.turnId === request.turnId) {
      finish(active, { status: "failed", reason: "turn-failed", transcriptLeafId: null, transcriptNextSeq: 1 });
    }
    return;
  }
  if (active || request.type !== "turn" || request.turnId !== request.descriptor.assignment.turnId) process.exit(25);
  active = request.descriptor;
  void runTurn(active).catch((error) => { process.stderr.write(error.message + "\n"); process.exit(1); });
});
lines.once("close", () => process.exit(0));
`;

export const fakeEngineSource = String.raw`
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const { withFileLockSync } = require(fileLockModule);
const path = require("node:path");
const args = process.argv.slice(2);
const command = args[0];
const statePath = (id) => path.join(engineRoot, id + ".container.json");
const load = (id) => JSON.parse(fs.readFileSync(statePath(id), "utf8"));
// Separate CLI processes share one fake daemon. Serialize state transitions so
// a delayed start or exit callback cannot recreate a removed container.
const withContainerLock = (id, operation) => withFileLockSync(statePath(id), {
  payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
  timeoutMs: 5_000,
}, operation);
const save = (container) => fs.writeFileSync(statePath(container.id), JSON.stringify(container));
const killWorker = (container) => {
  if (container.pid) {
    try {
      process.kill(process.platform === "win32" ? container.pid : -container.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
};
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
const waitForRunningJournal = async (container) => {
  let journal;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    journal = journalState(launchIdFor(container));
    const persisted = journal?.container_json && JSON.parse(journal.container_json);
    if (
      journal?.state === "running" &&
      persisted?.containerId === container.id &&
      persisted?.engineTarget === expectedEngineTarget
    ) {
      return journal;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return journal;
};
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
  const delayFile = path.join(engineRoot, "info-delay-ms");
  const delayMs = fs.existsSync(delayFile) ? Number(fs.readFileSync(delayFile, "utf8")) : 0;
  setTimeout(() => process.stdout.write(daemonId + "\n"), delayMs);
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
  const entrypoint = args.indexOf("--entrypoint");
  const image = args[entrypoint + 2];
  const entry = args[entrypoint + 3];
  const workerArgs = args.slice(entrypoint + 4);
  const container = { id, labels, env, mounts, image, entry, workerArgs, status: "created", pid: null };
  withContainerLock(id, () => save(container));
  record({ argv: args, container, journal: journalState(launchIdFor(container)) });
  releaseAfterMarker("hold-create", () => process.stdout.write(id + "\n"));
} else if (command === "start") {
  void (async () => {
    const id = args.at(-1);
    let container = withContainerLock(id, () => readContainer(id));
    const journal = await waitForRunningJournal(container);
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
    // A real engine leaves the container "created" until its start request lands,
    // so the marker lets a test hold the launch inside that startup window.
    await new Promise((resolve) => releaseAfterMarker("hold-start", resolve));
    const child = withContainerLock(id, () => {
      container = readContainer(id);
      const child = spawn(process.execPath, [container.entry, ...container.workerArgs], {
        detached: process.platform !== "win32",
        env: container.env,
        stdio: ["pipe", "inherit", "inherit"],
      });
      container.status = "running";
      container.pid = child.pid;
      save(container);
      return child;
    });
    process.stdin.pipe(child.stdin);
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") throw error;
    });
    child.once("error", (error) => {
      process.stderr.write(error.message + "\n");
      process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      withContainerLock(container.id, () => {
        if (fs.existsSync(statePath(container.id))) {
          const current = load(container.id);
          current.status = "exited";
          current.pid = null;
          save(current);
        }
      });
      process.exit(code ?? (signal ? 137 : 0));
    });
  })().catch((error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 1;
  });
} else if (command === "inspect") {
  const id = args.at(-1);
  record({ argv: args });
  const container = withContainerLock(id, () => readContainer(id));
  const format = args[args.indexOf("--format") + 1];
  const columns = [container.status];
  // Releasing the startup hold here proves the supervisor observed the container
  // while it was still created: the launch only proceeds after that observation.
  const startHold = path.join(engineRoot, "hold-start");
  if (fs.existsSync(startHold)) fs.unlinkSync(startHold);
  if (format.includes("openclaw.node-worker.host")) {
    columns.push(
      container.labels["openclaw.node-worker.host"] ?? "",
      container.labels["openclaw.node-worker.gateway"] ?? "",
      container.labels["openclaw.node-worker.launch"] ?? "",
    );
  }
  process.stdout.write(columns.join("\t") + "\n");
} else if (command === "kill") {
  const id = args.at(-1);
  withContainerLock(id, () => {
    const container = readContainer(id);
    record({ argv: args, journal: journalState(launchIdFor(container)) });
    if (container.status !== "running") {
      process.stderr.write("container is not running\n");
      process.exit(1);
    }
    container.status = "exited";
    save(container);
    killWorker(container);
    process.stdout.write(container.id + "\n");
  });
} else if (command === "rm") {
  const id = args.at(-1);
  const container = withContainerLock(id, () => readContainer(id));
  record({ argv: args, journal: journalState(launchIdFor(container)) });
  if (fs.existsSync(path.join(engineRoot, "fail-removal"))) {
    process.stderr.write("injected container removal failure\n");
    process.exit(1);
  }
  releaseAfterMarker("hold-removal", () => withContainerLock(id, () => {
    const current = readContainer(id);
    killWorker(current);
    fs.unlinkSync(statePath(id));
    process.stdout.write(id + "\n");
  }));
} else if (command === "ps") {
  record({ argv: args });
  const ownerFilter = args.find((arg) => arg.startsWith("label=openclaw.node-worker.host="));
  const owner = ownerFilter?.slice("label=openclaw.node-worker.host=".length);
  for (const file of fs.readdirSync(engineRoot).sort()) {
    if (!file.endsWith(".container.json")) continue;
    const id = file.slice(0, -".container.json".length);
    const container = withContainerLock(id, () => fs.existsSync(statePath(id)) ? load(id) : undefined);
    if (!container || container.labels["openclaw.node-worker.host"] !== owner) continue;
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
