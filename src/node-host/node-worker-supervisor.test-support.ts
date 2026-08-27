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
let input = "";
for await (const chunk of process.stdin) input += chunk;
const descriptor = JSON.parse(input);
if (descriptor.assignment.prompt === "exit-before-start") {
  fs.writeFileSync(path.join(descriptor.assignment.workspaceDir, "prestart-exited"), "exited");
  process.exit(23);
}
if (!process.connected || !process.channel || !process.argv.includes("--internal-worker-ipc")) {
  process.exit(24);
}
let grandchild;
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
const writeResultAndExit = (value) => {
  fs.writeSync(1, value);
  exitWorker(0);
};
const mode = descriptor.assignment.prompt;
if (mode === "admission-rearm") {
  const marker = path.join(descriptor.assignment.workspaceDir, "admission-attempt");
  const first = !fs.existsSync(marker);
  fs.writeFileSync(marker, descriptor.assignment.turnId);
  writeResultAndExit(JSON.stringify(first
    ? { status: "not-started", reason: "admission-deadline", errorText: "gateway unreachable " + descriptor.admission.credential }
    : { status: "completed", transcriptLeafId: "leaf-1", transcriptNextSeq: 2 }) + "\n");
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
  setInterval(() => {}, 1000);
} else if (mode === "tree") {
  grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(descriptor.assignment.workspaceDir, "grandchild.pid"), String(grandchild.pid));
  setInterval(() => {}, 1000);
} else if (mode === "secret-fail") {
  await new Promise((resolve) => setTimeout(resolve, 500));
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
  await new Promise((resolve) => setTimeout(resolve, 500));
  const credential = descriptor.admission.credential;
  writeResultAndExit(
    JSON.stringify({ raw: credential, encoded: encodeURIComponent(credential), status: "completed" }) + "\n",
  );
} else if (mode === "overflow") {
  writeResultAndExit("x".repeat(70 * 1024));
} else if (mode === "fast-terminal") {
  const marker = path.join(descriptor.assignment.workspaceDir, "fast-terminal-marker");
  process.once("SIGTERM", () => {
    fs.writeFileSync(marker, "signal");
    process.exit(143);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(marker, "normal");
  writeResultAndExit(JSON.stringify({ status: "completed" }) + "\n");
} else if (mode === "env") {
  writeResultAndExit(JSON.stringify(process.env) + "\n");
} else {
  await new Promise((resolve) => setTimeout(resolve, 25));
  writeResultAndExit(JSON.stringify({ argv: process.argv.slice(2), status: "completed" }) + "\n");
}
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
    launchId,
    gatewayNamespace: "gateway-1",
    expectedBundleHash: TEST_BUNDLE_HASH,
    placementGeneration: 4,
    descriptor: testWorkerDescriptor(workspaceDir, prompt, launchId),
  };
}
