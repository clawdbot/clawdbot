import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";

type NodeWorkerSupervisor = ReturnType<typeof createNodeWorkerSupervisor>;

const BUNDLE_HASH = "a".repeat(64);
const CREDENTIAL = 'node worker/"credential\\secret?';
const CHILD_SOURCE = String.raw`
import fs from "node:fs";
import path from "node:path";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const descriptor = JSON.parse(input);
const mode = descriptor.assignment.prompt;
if (mode === "wait") {
  setInterval(() => {}, 1000);
} else if (mode === "secret-fail") {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const credential = descriptor.admission.credential;
  const escaped = JSON.stringify(credential).slice(1, -1);
  process.stderr.write(
    "failure " + "x".repeat(5000) + " " + credential + " " + encodeURIComponent(credential) + " " + escaped,
  );
  process.exit(7);
} else if (mode === "secret-success") {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const credential = descriptor.admission.credential;
  process.stdout.write(
    JSON.stringify({ raw: credential, encoded: encodeURIComponent(credential), status: "completed" }) + "\n",
  );
} else if (mode === "overflow") {
  process.stdout.write("x".repeat(70 * 1024));
} else if (mode === "fast-terminal") {
  const marker = path.join(descriptor.assignment.workspaceDir, "fast-terminal-marker");
  process.once("SIGTERM", () => {
    fs.writeFileSync(marker, "signal");
    process.exit(143);
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(marker, "normal");
  process.stdout.write(JSON.stringify({ status: "completed" }) + "\n");
} else {
  await new Promise((resolve) => setTimeout(resolve, 25));
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), status: "completed" }) + "\n");
}
`;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
  closeOpenClawStateDatabaseForTest();
});

function descriptor(workspaceDir: string, prompt = "success"): WorkerLaunchDescriptor {
  return {
    version: 3,
    connectionEndpoint: { kind: "unix", socketPath: "/tmp/openclaw-worker/gateway.sock" },
    admission: {
      environmentId: "environment-1",
      credential: CREDENTIAL,
      sessionId: "session-1",
      ownerEpoch: 3,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      handshake: {
        bundleHash: BUNDLE_HASH,
        openclawVersion: "2026.8.1",
        protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
      },
    },
    assignment: {
      agentId: "agent-1",
      operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
      agentRuntimeIdentityToken: "signed-runtime-token",
      runId: "run-1",
      turnId: "turn-1",
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

function fixture() {
  const root = tempDirs.make("node-worker-supervisor-");
  const stateDir = path.join(root, "state-root");
  const bundleRoot = path.join(root, "bundles-root");
  const workspaceDir = path.join(root, "workspace");
  const bundleDir = path.join(bundleRoot, "gateway-1", "bundles", BUNDLE_HASH);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "openclaw.mjs"), CHILD_SOURCE);
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const supervisor = createNodeWorkerSupervisor({ bundleRoot, env });
  return { bundleRoot, env, root, stateDir, supervisor, workspaceDir };
}

function launchInput(workspaceDir: string, launchId: string, prompt = "success") {
  return {
    launchId,
    gatewayNamespace: "gateway-1",
    bundleHash: BUNDLE_HASH,
    placementGeneration: 4,
    descriptor: descriptor(workspaceDir, prompt),
  };
}

async function waitForTerminal(supervisor: NodeWorkerSupervisor, launchId: string) {
  await vi.waitFor(
    () => {
      expect(supervisor.status(launchId)?.state).not.toMatch(/^(?:pending|running)$/u);
    },
    { timeout: 5_000 },
  );
  const receipt = supervisor.status(launchId);
  if (!receipt) {
    throw new Error(`missing launch receipt ${launchId}`);
  }
  return receipt;
}

describe("node worker supervisor", () => {
  it("keeps the additive table absent until the first stateful operation", async () => {
    const { bundleRoot, env, supervisor } = fixture();
    const database = openOpenClawStateDatabase({ env });
    const findTable = () =>
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("node_worker_launches");

    expect(findTable()).toBeUndefined();
    await supervisor.close();
    expect(findTable()).toBeUndefined();

    const active = createNodeWorkerSupervisor({ bundleRoot, env });
    expect(active.status("missing-launch")).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT strict FROM pragma_table_list WHERE name = ?")
        .get("node_worker_launches"),
    ).toEqual({ strict: 1 });
    await active.close();
  });

  it("recovers pending and running launches once per live database handle", async () => {
    const { bundleRoot, env, supervisor } = fixture();
    supervisor.status("schema-probe");
    const database = openOpenClawStateDatabase({ env }).db;
    const insert = database.prepare(`
      INSERT INTO node_worker_launches (
        launch_id, plan_hash, gateway_namespace, environment_id, session_id,
        owner_epoch, placement_generation, run_id, state, pid,
        result_json, error_text, completed_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'gateway-1', 'environment-1', 'session-1', 3, 4, 'run-1', ?, ?, NULL, NULL, NULL, 1, 1)
    `);
    insert.run("pending-launch", "b".repeat(64), "pending", null);
    insert.run("running-launch", "c".repeat(64), "running", 4321);

    const sameHandle = createNodeWorkerSupervisor({ bundleRoot, env });
    expect(sameHandle.status("pending-launch")).toMatchObject({ state: "pending", pid: null });
    expect(sameHandle.status("running-launch")).toMatchObject({ state: "running", pid: 4321 });
    await supervisor.close();
    await sameHandle.close();
    closeOpenClawStateDatabaseForTest();

    const reopened = openOpenClawStateDatabase({ env }).db;
    const recovered = createNodeWorkerSupervisor({ bundleRoot, env });
    expect(recovered.status("pending-launch")).toMatchObject({ state: "interrupted", pid: null });
    expect(recovered.status("running-launch")).toMatchObject({ state: "interrupted", pid: null });
    expect(() =>
      reopened
        .prepare("UPDATE node_worker_launches SET state = 'completed' WHERE launch_id = ?")
        .run("pending-launch"),
    ).toThrow();
    await recovered.close();
  });

  it("launches idempotently and persists only bounded non-secret facts", async () => {
    const { env, supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "success-launch");

    expect(await supervisor.launch(input)).toMatchObject({
      launchId: "success-launch",
      state: "running",
      environmentId: "environment-1",
      sessionId: "session-1",
      ownerEpoch: 3,
      placementGeneration: 4,
      runId: "run-1",
    });
    const completed = await waitForTerminal(supervisor, input.launchId);
    expect(completed).toMatchObject({ state: "completed", errorText: null });
    expect(JSON.parse(completed.resultJson ?? "null")).toEqual({
      argv: ["worker"],
      status: "completed",
    });
    expect(await supervisor.launch(input)).toEqual(completed);
    await expect(
      supervisor.launch({
        ...input,
        descriptor: descriptor(workspaceDir, "different-plan"),
      }),
    ).rejects.toThrow("replayed with a different plan");

    const row = openOpenClawStateDatabase({ env })
      .db.prepare("SELECT * FROM node_worker_launches WHERE launch_id = ?")
      .get(input.launchId);
    expect(JSON.stringify(row)).not.toContain(CREDENTIAL);
    await supervisor.close();
  });

  it("bounds output and scrubs launch credentials after registry eviction", async () => {
    const { supervisor, workspaceDir } = fixture();
    const successInput = launchInput(workspaceDir, "secret-success-launch", "secret-success");
    const failureInput = launchInput(workspaceDir, "failure-launch", "secret-fail");
    const overflowInput = launchInput(workspaceDir, "overflow-launch", "overflow");

    await supervisor.launch(successInput);
    await supervisor.launch(failureInput);
    await supervisor.launch(overflowInput);
    for (let index = 0; index < 600; index += 1) {
      registerSecretValueForRedaction(`eviction-secret-${index}`);
    }
    const success = await waitForTerminal(supervisor, successInput.launchId);
    const failure = await waitForTerminal(supervisor, failureInput.launchId);
    const overflow = await waitForTerminal(supervisor, overflowInput.launchId);
    const representations = [
      CREDENTIAL,
      encodeURIComponent(CREDENTIAL),
      JSON.stringify(CREDENTIAL).slice(1, -1),
    ];
    expect(success.state).toBe("completed");
    expect(JSON.parse(success.resultJson ?? "null")).toEqual({
      raw: "[REDACTED]",
      encoded: "[REDACTED]",
      status: "completed",
    });
    expect(failure.state).toBe("failed");
    expect(Buffer.byteLength(failure.errorText ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
    for (const representation of representations) {
      expect(success.resultJson).not.toContain(representation);
      expect(failure.errorText).not.toContain(representation);
    }
    expect(overflow).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("stdout exceeded 65536 bytes"),
    });
    await supervisor.close();
  });

  it("does not signal a child after markRunning observes its terminal receipt", async () => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, "fast-terminal-launch", "fast-terminal");
    vi.spyOn(NodeWorkerLaunchStore.prototype, "markRunning").mockImplementation(
      function (this: NodeWorkerLaunchStore, params) {
        return this.finish({
          launchId: params.launchId,
          planHash: params.planHash,
          state: "completed",
          resultJson: '{"status":"completed"}',
        });
      },
    );

    expect(await supervisor.launch(input)).toMatchObject({ state: "completed" });
    const marker = path.join(workspaceDir, "fast-terminal-marker");
    await vi.waitFor(() => expect(fs.readFileSync(marker, "utf8")).toBe("normal"));
    await supervisor.close();
  });

  it.each([
    ["cancel", "cancelled"],
    ["close", "interrupted"],
  ] as const)("records %s while awaiting the attached child", async (operation, state) => {
    const { supervisor, workspaceDir } = fixture();
    const input = launchInput(workspaceDir, `${operation}-launch`, "wait");
    expect(await supervisor.launch(input)).toMatchObject({ state: "running" });

    if (operation === "cancel") {
      await supervisor.cancel(input.launchId);
    } else {
      await supervisor.close();
    }

    expect(supervisor.status(input.launchId)).toMatchObject({ state, pid: null });
    await supervisor.close();
  });

  it("fails closed when the bundle entry resolves outside its namespaced bundle", async () => {
    const { bundleRoot, root, supervisor, workspaceDir } = fixture();
    const escapedHash = "b".repeat(64);
    const escapedBundle = path.join(bundleRoot, "gateway-1", "bundles", escapedHash);
    const outsideEntry = path.join(root, "outside.mjs");
    fs.mkdirSync(escapedBundle, { recursive: true });
    fs.writeFileSync(outsideEntry, CHILD_SOURCE);
    fs.symlinkSync(outsideEntry, path.join(escapedBundle, "openclaw.mjs"));
    const input = launchInput(workspaceDir, "escaped-entry");
    input.bundleHash = escapedHash;
    input.descriptor.admission.handshake.bundleHash = escapedHash;

    expect(await supervisor.launch(input)).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("inside its bundle"),
    });
    await supervisor.close();
  });
});
