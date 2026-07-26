import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkerInferenceStartParams,
  WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { stableStringify } from "../../agents/stable-stringify.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerInferenceStore,
  type WorkerInferenceStore,
  type WorkerInferenceTurnInput,
} from "./inference-store.js";
import {
  createWorkerInferenceManager,
  type WorkerInferenceExecutor,
  type WorkerInferenceSink,
} from "./inference.js";
import { createWorkerEnvironmentStore } from "./store.js";

const ENVIRONMENT_ID = "environment-inference-store";
const REQUEST: WorkerInferenceStartParams = {
  runEpoch: 3,
  sessionId: "session-inference-store",
  runId: "run-inference-store",
  turnId: "turn-inference-store",
  modelRef: { provider: "fixture-provider", model: "fixture-model" },
  context: { messages: [] },
  options: {},
};
const IDENTITY: WorkerConnectionIdentity = {
  environmentId: ENVIRONMENT_ID,
  credentialHash: ["fixture", "digest"].join("-"),
  bundleHash: ["fixture", "bundle", "digest"].join("-"),
  sessionId: REQUEST.sessionId,
  runId: REQUEST.runId,
  ownerEpoch: REQUEST.runEpoch,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-inference-v1"],
  credentialExpiresAtMs: 10_000,
};
const PROVIDER_ERROR: WorkerInferenceTerminalOutcome = {
  type: "error",
  reason: "provider-error",
  message: "Provider request failed",
};

function hashRequest(request: WorkerInferenceStartParams): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

const BASE_INPUT: WorkerInferenceTurnInput = {
  environmentId: ENVIRONMENT_ID,
  sessionId: REQUEST.sessionId,
  runEpoch: REQUEST.runEpoch,
  runId: REQUEST.runId,
  turnId: REQUEST.turnId,
  requestHash: hashRequest(REQUEST),
};

function createSink() {
  const frames: Parameters<WorkerInferenceSink["send"]>[0][] = [];
  const sink: WorkerInferenceSink = {
    connectionId: "connection-inference-store",
    send: (frame) => frames.push(frame),
  };
  return { frames, sink };
}

describe("worker inference SQLite store", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let nowMs: number;
  let store: WorkerInferenceStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-inference-store-"));
    nowMs = 1_000;
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    createWorkerEnvironmentStore({ database, now: () => nowMs }).createIntent({
      environmentId: ENVIRONMENT_ID,
      providerId: "fixture-provider",
      profileId: "fixture-profile",
      profileSnapshot: { settings: {}, lifetime: { idleMinutes: 10 } },
      provisionOperationId: "fixture-operation",
    });
    store = createWorkerInferenceStore({ database, now: () => nowMs });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function reopenStore(): WorkerInferenceStore {
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    return createWorkerInferenceStore({ database, now: () => nowMs });
  }

  function terminalRunIds(): string[] {
    const rows = database.db
      .prepare("SELECT run_id FROM worker_inference_turns WHERE state = 'terminal' ORDER BY run_id")
      .all() as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
  }

  function completeTurn(runId: string): WorkerInferenceTurnInput {
    const input = {
      ...BASE_INPUT,
      runId,
      turnId: `turn-${runId}`,
    };
    expect(store.begin(input)).toEqual({ kind: "claimed" });
    expect(store.complete({ ...input, outcome: PROVIDER_ERROR })).toEqual(PROVIDER_ERROR);
    return input;
  }

  function expectReplayWithoutExecution(managerStore: WorkerInferenceStore) {
    const execute = vi.fn<WorkerInferenceExecutor>(async () => PROVIDER_ERROR);
    const manager = createWorkerInferenceManager({
      execute,
      store: managerStore,
      now: () => nowMs,
    });
    const { frames, sink } = createSink();
    const result = manager.start({ identity: IDENTITY, request: REQUEST, sink });
    if (!result.ok) {
      throw new Error(`start failed: ${result.reason}`);
    }
    expect(result.result).toEqual({ status: "replayed" });
    result.launch();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      event: "worker.inference.terminal",
      payload: { outcome: PROVIDER_ERROR },
    });
    expect(execute).not.toHaveBeenCalled();
    return manager;
  }

  it("rejects a terminal identity with a different request hash as a conflict", () => {
    expect(store.begin(BASE_INPUT)).toEqual({ kind: "claimed" });
    store.complete({ ...BASE_INPUT, outcome: PROVIDER_ERROR });

    expect(store.begin({ ...BASE_INPUT, requestHash: "b".repeat(64) })).toEqual({
      kind: "rejected",
      reason: "conflict",
    });
  });

  it("replays a cached terminal outcome without executing the provider again", async () => {
    expect(store.begin(BASE_INPUT)).toEqual({ kind: "claimed" });
    store.complete({ ...BASE_INPUT, outcome: PROVIDER_ERROR });

    const manager = expectReplayWithoutExecution(reopenStore());
    await manager.stop();
  });

  it("recovers a crashed pending turn as provider-error without executing the provider", async () => {
    expect(store.begin(BASE_INPUT)).toEqual({ kind: "claimed" });
    const reopened = reopenStore();
    expect(reopened.begin(BASE_INPUT)).toEqual({ kind: "recover" });

    const manager = expectReplayWithoutExecution(reopened);
    await manager.stop();
  });

  it("rejects another pending turn for the same session epoch and run", () => {
    expect(store.begin(BASE_INPUT)).toEqual({ kind: "claimed" });

    expect(
      store.begin({
        ...BASE_INPUT,
        turnId: "turn-conflict",
        requestHash: "b".repeat(64),
      }),
    ).toEqual({ kind: "rejected", reason: "conflict" });
  });

  it("prunes terminal turns older than maxAge", () => {
    completeTurn("run-old");
    nowMs += 1_000;
    store = createWorkerInferenceStore({
      database,
      now: () => nowMs,
      retention: { maxAgeMs: 500, maxRows: 10, maxBytes: 1_000_000 },
    });

    completeTurn("run-current");
    expect(terminalRunIds()).toEqual(["run-current"]);
  });

  it("prunes terminal turns beyond maxRows", () => {
    completeTurn("run-first");
    nowMs += 1;
    store = createWorkerInferenceStore({
      database,
      now: () => nowMs,
      retention: { maxAgeMs: 10_000, maxRows: 1, maxBytes: 1_000_000 },
    });

    completeTurn("run-second");
    expect(terminalRunIds()).toEqual(["run-second"]);
  });

  it("prunes terminal turns beyond maxBytes", () => {
    completeTurn("run-first");
    nowMs += 1;
    store = createWorkerInferenceStore({
      database,
      now: () => nowMs,
      retention: {
        maxAgeMs: 10_000,
        maxRows: 10,
        maxBytes: Buffer.byteLength(JSON.stringify(PROVIDER_ERROR), "utf8"),
      },
    });

    completeTurn("run-second");
    expect(terminalRunIds()).toEqual(["run-second"]);
  });

  it("preserves the active identity while pruning after completion", () => {
    store = createWorkerInferenceStore({
      database,
      now: () => nowMs,
      retention: { maxAgeMs: 0, maxRows: 0, maxBytes: 0 },
    });

    completeTurn("run-active");
    expect(terminalRunIds()).toEqual(["run-active"]);
  });
});
