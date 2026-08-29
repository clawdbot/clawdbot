import fs from "node:fs";
import path from "node:path";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerLaunchPlan } from "../worker/launch-descriptor.js";
import type { WorkerConnectionEndpoint } from "../worker/worker-connection-endpoint.js";
import {
  nodeWorkerPlanHash,
  type NodeWorkerLaunchInput,
  type NodeWorkerSupervisorIdentity,
} from "./node-worker-supervisor-contract.js";

const TEST_BUNDLE_HASH = "a".repeat(64);
export const TEST_WORKER_CREDENTIAL = 'node worker/"credential\\secret?';
export const TEST_WORKER_ENDPOINT: WorkerConnectionEndpoint = {
  kind: "unix",
  socketPath: "/tmp/openclaw-worker/gateway.sock",
};

export const TEST_WORKER_SOURCE = String.raw`
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
if (!process.connected || !process.channel ||
    !process.argv.includes("--internal-worker-ipc") ||
    !process.argv.includes("--internal-worker-session")) {
  process.exit(24);
}
let grandchild;
let background;
let retained = false;
let currentTurn;
let disposed = false;
let started = false;
let resolveStart;
const start = new Promise((resolve) => { resolveStart = resolve; });
const hardTerminate = () => {
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(process.pid)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  process.kill(-process.pid, "SIGKILL");
};
const onMessage = (message) => {
  if (
    started ||
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message) ||
    Object.keys(message).length !== 1 ||
    message.type !== "openclaw-worker-start-v1"
  ) {
    hardTerminate();
    return;
  }
  started = true;
  resolveStart();
};
const onDisconnect = () => {
  if (disposed) return;
  if (!started) process.exit(0);
  hardTerminate();
};
process.on("message", onMessage);
process.once("disconnect", onDisconnect);
await start;
const exitWorker = (code) => {
  disposed = true;
  process.off("message", onMessage);
  process.off("disconnect", onDisconnect);
  if (process.connected) process.disconnect();
  process.exit(code);
};
const completedResult = { status: "completed", transcriptLeafId: "leaf-1", transcriptNextSeq: 2 };
const finish = (descriptor, result = completedResult, retainWorker = retained) => {
  if (currentTurn !== descriptor) return;
  fs.writeSync(1, JSON.stringify({
    type: "result", turnId: descriptor.assignment.turnId, result, retainWorker,
  }) + "\n");
  currentTurn = undefined;
  retained = retainWorker;
  if (!retainWorker && descriptor.assignment.prompt !== "retire-stall") exitWorker(0);
};
const writeArtifact = (descriptor, name, value) => fs.writeFileSync(
  path.join(descriptor.assignment.workspaceDir, descriptor.assignment.turnId + "." + name + ".json"),
  JSON.stringify(value),
);
const runTurn = async (descriptor) => {
const startedPath = path.join(descriptor.assignment.workspaceDir, descriptor.assignment.turnId + ".started.json");
const starts = fs.existsSync(startedPath) ? JSON.parse(fs.readFileSync(startedPath, "utf8")).starts + 1 : 1;
writeArtifact(descriptor, "started", { pid: process.pid, starts });
const mode = descriptor.assignment.prompt;
if (mode === "admission-rearm") {
  const marker = path.join(descriptor.assignment.workspaceDir, "admission-attempt");
  const first = !fs.existsSync(marker);
  fs.writeFileSync(marker, descriptor.assignment.turnId);
  finish(descriptor, first
    ? { status: "not-started", reason: "admission-deadline", errorText: "gateway unreachable " + descriptor.admission.credential }
    : completedResult);
} else if (mode === "connection-failure" || mode === "connection-deadline") {
  const target = new URL(descriptor.connectionEndpoint.url).host;
  const report = (cause) => new Promise((resolve) => process.send(
    { type: "openclaw-worker-connection-failure-v1", cause }, resolve,
  ));
  await report("worker could not reach gateway " + target + ": certificate rejected " +
    descriptor.admission.credential + "; check TLS pin/publicUrl configuration");
  if (mode === "connection-deadline") {
    await report("worker admission deadline exceeded after 3 attempts to " + target +
      ": connect failed: Opening handshake has timed out " + descriptor.admission.credential);
    process.stderr.write("worker admission deadline exceeded\n");
    exitWorker(7);
  } else {
    fs.writeFileSync(path.join(descriptor.assignment.workspaceDir, "connection-failure-reported"), "reported");
    setInterval(() => {}, 1000);
  }
} else if (mode === "wait") {
  return;
} else if (mode === "tree") {
  grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(descriptor.assignment.workspaceDir, "grandchild.pid"), String(grandchild.pid));
} else if (mode === "background-start") {
  grandchild = spawn(process.execPath, ["-e", [
    "const server = require('node:http').createServer((req, res) => res.end('preview-ready'));",
    "server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({",
    "pid: process.pid, url: 'http://127.0.0.1:' + server.address().port,",
    "}) + '\\n'));",
  ].join("\n")], { stdio: ["ignore", "pipe", "inherit"] });
  background = await new Promise((resolve, reject) => {
    grandchild.once("error", reject);
    const output = createInterface({ input: grandchild.stdout });
    output.once("line", (line) => { output.close(); resolve(JSON.parse(line)); });
  });
  writeArtifact(descriptor, "background", background);
  finish(descriptor, completedResult, true);
} else if (mode === "background-poll") {
  if (!background) throw new Error("background process was not retained");
  const response = await fetch(background.url);
  writeArtifact(descriptor, "background", { ...background, response: await response.text() });
  finish(descriptor, completedResult, true);
} else if (mode === "background-wait") {
  if (!background) throw new Error("background process was not retained");
  return;
} else if (mode === "diagnostic-retain") {
  fs.writeSync(2, "previous turn stderr " + descriptor.admission.credential + "\n");
  await new Promise((resolve) => process.send({
    type: "openclaw-worker-connection-failure-v1",
    cause: "previous turn connection " + descriptor.admission.credential,
  }, resolve));
  finish(descriptor, completedResult, true);
} else if (mode === "quiet-fail") {
  exitWorker(7);
} else if (mode === "secret-fail") {
  const credential = descriptor.admission.credential;
  const escaped = JSON.stringify(credential).slice(1, -1);
  process.stderr.write(
    "failure " + "x".repeat(5000) + " " + credential + " " + encodeURIComponent(credential) + " " + escaped,
  );
  exitWorker(7);
} else if (mode.startsWith("secret-cutoff-")) {
  const credential = descriptor.admission.credential;
  const representations = {
    "secret-cutoff-raw": credential,
    "secret-cutoff-url": encodeURIComponent(credential),
    "secret-cutoff-json": JSON.stringify(credential).slice(1, -1),
  };
  const representation = representations[mode];
  const suffixBytes = 4096 - Math.floor(Buffer.byteLength(representation, "utf8") / 2);
  process.stderr.write("x".repeat(5000) + representation + "y".repeat(suffixBytes));
  exitWorker(7);
} else if (mode === "secret-success") {
  const credential = descriptor.admission.credential;
  finish(descriptor, {
    ...completedResult,
    transcriptLeafId: "raw " + credential + " encoded " + encodeURIComponent(credential),
  });
} else if (mode === "overflow") {
  fs.writeSync(1, "x".repeat(70 * 1024));
  exitWorker(0);
} else if (mode === "fast-terminal") {
  const marker = path.join(descriptor.assignment.workspaceDir, "fast-terminal-marker");
  process.once("SIGTERM", () => {
    fs.writeFileSync(marker, "signal");
    process.exit(143);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(marker, "normal");
  finish(descriptor);
} else if (mode === "env") {
  writeArtifact(descriptor, "env", process.env);
  finish(descriptor);
} else {
  await new Promise((resolve) => setTimeout(resolve, 25));
  writeArtifact(descriptor, "argv", process.argv.slice(2));
  finish(descriptor);
}
};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "cancel") {
    const descriptor = currentTurn;
    if (!descriptor || descriptor.assignment.turnId !== request.turnId) return;
    const settle = () => finish(descriptor, {
      status: "failed", reason: "turn-failed", transcriptLeafId: null, transcriptNextSeq: 1,
    }, Boolean(background));
    if (grandchild && !background) {
      grandchild.once("exit", settle);
      grandchild.kill("SIGKILL");
    } else {
      settle();
    }
    return;
  }
  if (currentTurn || request.type !== "turn" ||
      request.turnId !== request.descriptor.assignment.turnId) {
    process.stderr.write("invalid or concurrent managed turn\n");
    exitWorker(25);
  }
  currentTurn = request.descriptor;
  void runTurn(currentTurn).catch((error) => {
    process.stderr.write(error.message + "\n");
    hardTerminate();
  });
});
lines.once("close", () => { if (!disposed) hardTerminate(); });
`;

export function testWorkerDescriptor(
  workspaceDir: string,
  prompt = "success",
  turnId = "turn-1",
): WorkerLaunchPlan {
  return {
    version: 4,
    admission: {
      environmentId: "environment-1",
      credential: TEST_WORKER_CREDENTIAL,
      sessionId: "session-1",
      ownerEpoch: 3,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      handshake: {
        bundleHash: TEST_BUNDLE_HASH,
        openclawVersion: "2026.8.1",
        protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
      },
    },
    assignment: {
      agentId: "agent-1",
      operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
      agentRuntimeIdentityToken: "signed-runtime-token",
      runId: "run-1",
      turnId,
      prompt,
      suppressPromptTranscript: false,
      workspaceDir,
      modelRef: { provider: "provider-1", model: "model-1" },
      inferenceOptions: {},
      initialMessages: [],
      transcript: { baseLeafId: null, nextSeq: 1 },
      liveEvents: { ackedSeq: 0, nextSeq: 1 },
      toolAuthority: { allowedToolNames: [] },
    },
  };
}

export function testNodeWorkerLaunchIdentity(
  input: NodeWorkerLaunchInput,
): NodeWorkerSupervisorIdentity {
  return {
    launchId: input.launchId,
    planHash: nodeWorkerPlanHash(input),
    environmentId: input.descriptor.admission.environmentId,
    sessionId: input.descriptor.admission.sessionId,
    ownerEpoch: input.descriptor.admission.ownerEpoch,
    placementGeneration: input.placementGeneration,
    runId: input.descriptor.assignment.runId,
  };
}

export function testNodeWorkerEnvironmentIdentity(input: NodeWorkerLaunchInput) {
  return {
    gatewayNamespace: input.gatewayNamespace,
    environmentId: input.descriptor.admission.environmentId,
    sessionId: input.descriptor.admission.sessionId,
    ownerEpoch: input.descriptor.admission.ownerEpoch,
  };
}

export function writeNodeWorkerFixture(root: string) {
  const stateDir = path.join(root, "state-root");
  const bundleRoot = path.join(root, "bundles-root");
  const workspaceDir = path.join(root, "workspace");
  const bundleDir = path.join(bundleRoot, "gateway-1", "bundles", TEST_BUNDLE_HASH);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "worker.mjs"), TEST_WORKER_SOURCE);
  return { bundleRoot, env: { OPENCLAW_STATE_DIR: stateDir }, root, stateDir, workspaceDir };
}

export function testWorkerLaunchInput(
  workspaceDir: string,
  launchId: string,
  prompt = "success",
): NodeWorkerLaunchInput {
  return {
    environmentSession: 1,
    launchId,
    gatewayNamespace: "gateway-1",
    expectedBundleHash: TEST_BUNDLE_HASH,
    placementGeneration: 4,
    descriptor: testWorkerDescriptor(workspaceDir, prompt, launchId),
  };
}
