import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createWorkerTranscriptCommitStore,
  type WorkerTranscriptCommitInput,
  type WorkerTranscriptCommitOutcome,
  type WorkerTranscriptCommitStore,
} from "./transcript-commit-store.js";

const SUCCESS_OUTCOME: WorkerTranscriptCommitOutcome = {
  ok: true,
  result: { entryIds: ["entry-a", "entry-b"], newLeafId: "entry-b" },
};
const ERROR_OUTCOME: WorkerTranscriptCommitOutcome = {
  ok: false,
  reason: "stale-base-leaf",
};
const BASE_INPUT: WorkerTranscriptCommitInput = {
  environmentId: "worker-a",
  sessionId: "session-a",
  runEpoch: 4,
  seq: 1,
  requestHash: "a".repeat(64),
};

describe("worker transcript commit store", () => {
  let root: string;
  let nowMs: number;
  let store: WorkerTranscriptCommitStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-commit-"));
    nowMs = 1_000;
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerTranscriptCommitStore({ database, now: () => nowMs });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("recovers pending work and replays a terminal result across reopen", () => {
    expect(store.begin(BASE_INPUT)).toEqual({ kind: "claimed" });
    expect(store.begin(BASE_INPUT)).toEqual({ kind: "recover" });

    nowMs = 1_010;
    expect(store.complete({ ...BASE_INPUT, outcome: SUCCESS_OUTCOME })).toEqual(SUCCESS_OUTCOME);
    expect(store.begin(BASE_INPUT)).toEqual({ kind: "replay", outcome: SUCCESS_OUTCOME });

    closeOpenClawStateDatabaseForTest();
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerTranscriptCommitStore({ database, now: () => nowMs });
    expect(store.begin(BASE_INPUT)).toEqual({ kind: "replay", outcome: SUCCESS_OUTCOME });
  });

  it("rejects a tuple replayed with a different payload or environment", () => {
    expect(store.begin(BASE_INPUT)).toEqual({ kind: "claimed" });
    expect(store.begin({ ...BASE_INPUT, requestHash: "b".repeat(64) })).toEqual({
      kind: "rejected",
      reason: "conflict",
    });
    store.complete({ ...BASE_INPUT, outcome: SUCCESS_OUTCOME });
    expect(store.begin({ ...BASE_INPUT, requestHash: "b".repeat(64) })).toEqual({
      kind: "rejected",
      reason: "conflict",
    });
    expect(store.begin({ ...BASE_INPUT, environmentId: "worker-b" })).toEqual({
      kind: "rejected",
      reason: "conflict",
    });
  });

  it("advances one ordered sequence only after terminal completion", () => {
    const second = { ...BASE_INPUT, seq: 2, requestHash: "b".repeat(64) };
    const third = { ...BASE_INPUT, seq: 3, requestHash: "c".repeat(64) };

    expect(store.begin(second)).toEqual({
      kind: "rejected",
      reason: "out-of-order",
      expectedSeq: 1,
    });
    expect(store.begin(BASE_INPUT)).toEqual({ kind: "claimed" });
    expect(store.begin(second)).toEqual({
      kind: "rejected",
      reason: "out-of-order",
      expectedSeq: 1,
    });
    store.complete({ ...BASE_INPUT, outcome: SUCCESS_OUTCOME });
    expect(store.begin(third)).toEqual({
      kind: "rejected",
      reason: "out-of-order",
      expectedSeq: 2,
    });
    expect(store.begin(second)).toEqual({ kind: "claimed" });
    expect(store.complete({ ...second, outcome: ERROR_OUTCOME })).toEqual(ERROR_OUTCOME);
    expect(store.begin(second)).toEqual({ kind: "replay", outcome: ERROR_OUTCOME });
    expect(store.begin(third)).toEqual({ kind: "claimed" });
  });

  it("keeps the first cached terminal outcome", () => {
    expect(() => store.complete({ ...BASE_INPUT, outcome: SUCCESS_OUTCOME })).toThrow(
      "must begin before terminal completion",
    );
    store.begin(BASE_INPUT);
    expect(store.complete({ ...BASE_INPUT, outcome: SUCCESS_OUTCOME })).toEqual(SUCCESS_OUTCOME);
    expect(store.complete({ ...BASE_INPUT, outcome: ERROR_OUTCOME })).toEqual(SUCCESS_OUTCOME);
  });

  it("starts an independent sequence for a later owner epoch", () => {
    expect(store.begin(BASE_INPUT)).toEqual({ kind: "claimed" });
    store.complete({ ...BASE_INPUT, outcome: SUCCESS_OUTCOME });
    const replacement = {
      ...BASE_INPUT,
      environmentId: "worker-b",
      runEpoch: BASE_INPUT.runEpoch + 1,
    };

    expect(store.begin(replacement)).toEqual({ kind: "claimed" });
    expect(store.complete({ ...replacement, outcome: SUCCESS_OUTCOME })).toEqual(SUCCESS_OUTCOME);
  });
});
