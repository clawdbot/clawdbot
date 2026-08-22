import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerLiveEventParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceStartParams,
  WorkerInferenceTerminalOutcome,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWorkerProviderReplayRoundTrip } from "../../test/helpers/worker-provider-replay-roundtrip.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
} from "../infra/agent-run-registry.js";
import { WorkerAdmissionError } from "./worker-connection-contract.js";
import { WorkerConnectionStoppedError } from "./worker-connection.js";
import {
  ComposedGatewayHarness,
  ENVIRONMENT_ID,
  RUN_ID,
  SESSION_ID,
  SESSION_KEY,
  doneMessage,
  doneOutcome,
  type WorkerClients,
} from "./worker-fault-injection.test-support.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const REPLACEMENT_CREDENTIAL = ["worker", "replacement", "fixture"].join("-");
const MODEL_REF = { provider: "fake", model: "fault-model" } as const;
const TERMINAL_EVENT = {
  kind: "lifecycle" as const,
  payload: { phase: "finishing" as const, startedAt: 1, endedAt: 2 },
};

function transcriptMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: 1,
  };
}

function inferenceRequest(epoch: number, turnId: string): WorkerInferenceStartParams {
  return {
    runEpoch: epoch,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    turnId,
    modelRef: MODEL_REF,
    context: { messages: [] },
    options: {},
  };
}

async function stopClients(clients: WorkerClients | undefined): Promise<void> {
  if (!clients) {
    return;
  }
  clients.inference.dispose();
  clients.live.dispose();
  await clients.connection.stop();
}

describe("cloud worker milestone 2 fault injection", () => {
  let harness: ComposedGatewayHarness;
  const clients: WorkerClients[] = [];

  beforeEach(async () => {
    harness = await ComposedGatewayHarness.create(tempDirs.make("openclaw-worker-fault-"));
    await harness.start();
  });

  afterEach(async () => {
    for (const current of clients.splice(0)) {
      await stopClients(current);
    }
    await harness.close();
  });

  it("replays captured compaction exactly after worker commit and canonical reopen", async () => {
    await runWorkerProviderReplayRoundTrip({
      createDescriptor: (options) => harness.createDescriptor(options),
      requestParams: (method) => harness.requestParams(method),
      sessionTarget: harness.sessionTarget,
      settleRun: (runId) => harness.settleRun(runId),
      setOutcome: (outcome) => {
        harness.providerPlan = { kind: "immediate", text: "roundtrip", outcome };
      },
    });
  });

  it.each([
    ["before service handling", "before-service"],
    ["after service handling", "after-service"],
  ] as const)(
    "does not pace provider preview production on a delayed first request %s",
    async (_label, previewStage) => {
      const nextProviderDelta = createDeferred();
      const providerProduced = createDeferred();
      const previewGate = harness.addLiveEventGate(previewStage, "preview");
      const finishingGate = harness.addLiveEventGate("after-service", "finishing");
      harness.providerPlan = {
        kind: "live-preview",
        nextRelease: nextProviderDelta,
        produced: providerProduced,
        text: "preview reply",
      };
      let settled = false;
      const result = runWorkerDescriptor(harness.createDescriptor()).finally(() => {
        settled = true;
      });
      void result.catch(() => undefined);

      await previewGate.entered.promise;
      nextProviderDelta.resolve();
      await providerProduced.promise;
      await vi.waitFor(() =>
        expect(
          harness.requestParams("worker.live-event").filter((params) => {
            const request = params as WorkerLiveEventParams;
            return request.event.kind === "assistant" || request.event.kind === "thinking";
          }),
        ).toHaveLength(2),
      );
      expect(settled).toBe(false);
      expect(harness.placementStore.get(SESSION_ID)?.lastLiveEventAckCursor).toBeNull();

      previewGate.release.resolve();
      await finishingGate.entered.promise;
      expect(settled).toBe(false);
      expect(SessionManager.open(harness.sessionTarget).getEntries()).toHaveLength(2);
      expect(harness.placementStore.get(SESSION_ID)?.lastLiveEventAckCursor).toBeGreaterThan(0);
      expect(harness.placementStore.listPendingWorkspaceResults()).toMatchObject([
        { sessionId: SESSION_ID, environmentId: ENVIRONMENT_ID, runId: RUN_ID },
      ]);

      finishingGate.release.resolve();
      await expect(result).resolves.toMatchObject({
        transcriptLeafId: expect.any(String),
        transcriptNextSeq: expect.any(Number),
      });
    },
  );

  it("survives repeated tunnel partitions without transcript duplication, live replay, or rebilling", async () => {
    const current = harness.createClients();
    clients.push(current);
    const firstRelease = createDeferred();
    const secondRelease = createDeferred();
    const started = createDeferred();
    harness.providerPlan = {
      kind: "partitioned",
      firstRelease,
      secondRelease,
      started,
      text: "partitioned reply",
    };
    harness.addFault({ kind: "partition-after-inference-event", seq: 1 });
    harness.addFault({ kind: "partition-after-inference-event", seq: 2 });
    harness.addFault({ kind: "drop-response", method: "worker.transcript.commit", restart: false });
    harness.addFault({ kind: "drop-response", method: "worker.live-event", restart: false });
    await current.connection.start();

    const inferenceSeqs: number[] = [];
    const inference = current.inference.start(inferenceRequest(harness.epoch, "partitioned-turn"), {
      onEvent: (event) => inferenceSeqs.push(event.seq),
    });
    await started.promise;
    await vi.waitFor(() => expect(harness.requestParams("worker.inference.start")).toHaveLength(2));
    firstRelease.resolve();
    await vi.waitFor(() => expect(harness.requestParams("worker.inference.start")).toHaveLength(3));
    secondRelease.resolve();
    await expect(inference).resolves.toEqual(doneOutcome("partitioned reply"));

    const committed = await current.transcript.commit([
      transcriptMessage("partitioned user"),
      { ...doneMessage("partitioned reply"), timestamp: 2 },
    ]);
    for (const delta of ["one", "two", "three"]) {
      current.live.enqueuePreview(RUN_ID, {
        kind: "assistant",
        payload: { text: delta, delta },
      });
    }
    await expect(current.live.emitTerminal(RUN_ID, TERMINAL_EVENT)).resolves.toBeUndefined();

    const transcriptRequests = harness.requestParams("worker.transcript.commit");
    expect(transcriptRequests).toHaveLength(2);
    expect(transcriptRequests[1]).toEqual(transcriptRequests[0]);
    expect(harness.requestParams("worker.inference.start")).toHaveLength(3);
    expect(harness.providerCalls).toBe(1);
    expect(inferenceSeqs).toEqual([1, 2]);
    expect(harness.liveDeltas).toEqual(["one", "two", "three"]);
    expect(
      harness
        .requestParams("worker.live-event")
        .map((request) => (request as WorkerLiveEventParams).seq),
    ).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
    const transcript = SessionManager.open(harness.sessionTarget).getEntries();
    expect(transcript).toHaveLength(2);
    expect(new Set(transcript.map((entry) => entry.id)).size).toBe(2);
    expect(SessionManager.open(harness.sessionTarget).getLeafId()).toBe(committed.newLeafId);
  });

  it("fences restart-inherited authority and recovers durable state on a fresh claim", async () => {
    const current = harness.createClients();
    clients.push(current);
    const providerRelease = createDeferred<WorkerInferenceTerminalOutcome>();
    const providerStarted = createDeferred();
    const commitEntered = createDeferred();
    const commitRelease = createDeferred();
    harness.providerPlan = { kind: "pending", release: providerRelease, started: providerStarted };
    harness.transcriptGate = {
      phase: "after-apply",
      entered: commitEntered,
      release: commitRelease,
    };
    harness.addFault({ kind: "drop-response", method: "worker.transcript.commit", restart: true });
    await current.connection.start();

    current.live.enqueuePreview(RUN_ID, {
      kind: "assistant",
      payload: { text: "acked", delta: "acked" },
    });
    await vi.waitFor(() => expect(harness.liveDeltas).toEqual(["acked"]));
    const inference = current.inference.start(inferenceRequest(harness.epoch, "restart-turn"));
    await providerStarted.promise;
    const commit = current.transcript.commit([transcriptMessage("restart transcript")]);
    const fencedCommit = expect(commit).rejects.toMatchObject({
      name: "WorkerAdmissionError",
      reason: "invalid-handshake",
    });
    const fencedInference = expect(inference).rejects.toMatchObject({
      name: "WorkerAdmissionError",
      reason: "invalid-handshake",
    });
    await commitEntered.promise;
    for (const delta of ["tail-a", "tail-b"]) {
      current.live.enqueuePreview(RUN_ID, {
        kind: "assistant",
        payload: { text: delta, delta },
      });
    }
    // Pin one live request in the pre-restart window before the commit response
    // triggers restart, so recovery proves that stale tail cannot retain authority.
    await vi.waitFor(() =>
      expect(harness.requestParams("worker.live-event").length).toBeGreaterThanOrEqual(3),
    );
    commitRelease.resolve();

    await fencedCommit;
    await fencedInference;
    await expect(current.connection.waitForExit()).resolves.toMatchObject({
      kind: "failed",
      error: expect.objectContaining({
        name: WorkerAdmissionError.name,
        reason: "invalid-handshake",
      }),
    });
    expect(harness.providerCalls).toBe(1);
    expect(harness.replacementProviderCalls).toBe(0);
    const staleIdentity = harness.admissions.at(-1);
    expect(staleIdentity).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: harness.epoch,
      sessionId: SESSION_ID,
      turnClaim: {
        runId: RUN_ID,
        owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: harness.epoch },
      },
    });
    expect(SessionManager.open(harness.sessionTarget).getEntries()).toHaveLength(1);

    const recoveryRunId = "restart-recovery-run";
    const oldEpoch = harness.epoch;
    const freshEpoch = harness.reclaimWithCredential(REPLACEMENT_CREDENTIAL, recoveryRunId);
    expect(freshEpoch).toBeGreaterThan(oldEpoch);
    providerRelease.resolve(doneOutcome("late stale provider result"));
    const fresh = harness.createClients({
      admissionProof: REPLACEMENT_CREDENTIAL,
      epoch: freshEpoch,
      runId: recoveryRunId,
    });
    clients.push(fresh);
    await fresh.connection.start();
    fresh.live.enqueuePreview(recoveryRunId, {
      kind: "assistant",
      payload: { text: "recovered", delta: "recovered" },
    });
    await expect(fresh.live.emitTerminal(recoveryRunId, TERMINAL_EVENT)).resolves.toBeUndefined();
    const freshIdentity = harness.admissions.at(-1);
    expect(freshIdentity?.turnClaim).toMatchObject({
      runId: recoveryRunId,
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: freshEpoch },
    });
    expect(freshIdentity?.turnClaim?.claimId).not.toBe(staleIdentity?.turnClaim?.claimId);
    expect(harness.liveDeltas[0]).toBe("acked");
    expect(harness.liveDeltas.filter((delta) => delta === "recovered")).toEqual(["recovered"]);
    const liveRequests = harness.requestParams("worker.live-event").map((request) => {
      const live = request as WorkerLiveEventParams;
      return [live.runId, live.seq, live.lastAckedSeq];
    });
    expect(liveRequests).toContainEqual([recoveryRunId, 1, 0]);
    harness.settleRun(recoveryRunId);
  });

  it("fences a dead worker and admits a fresh owner at a higher epoch", async () => {
    const old = harness.createClients();
    clients.push(old);
    await old.connection.start();
    const oldCommit = await old.transcript.commit([transcriptMessage("old owner")]);
    const pendingRelease = createDeferred<WorkerInferenceTerminalOutcome>();
    const pendingStarted = createDeferred();
    harness.providerPlan = { kind: "pending", release: pendingRelease, started: pendingStarted };
    const oldInference = old.inference.start(inferenceRequest(harness.epoch, "handoff-old"));
    const oldInferenceSettled = expect(oldInference).resolves.toMatchObject({
      type: "error",
      reason: "session-not-attached",
    });
    await pendingStarted.promise;

    const oldEpoch = harness.epoch;
    const newEpoch = harness.reclaimWithCredential(REPLACEMENT_CREDENTIAL, "fresh-run");
    expect(newEpoch).toBeGreaterThan(oldEpoch);
    const rejected = old.transcript.commit([transcriptMessage("late old owner")]);
    await expect(rejected).rejects.toMatchObject({
      name: "WorkerTranscriptCommitError",
      reason: "placement-mismatch",
    });
    await expect(old.connection.waitForExit()).resolves.toMatchObject({ kind: "failed" });
    pendingRelease.resolve(doneOutcome("stale paid output"));
    await oldInferenceSettled;

    harness.providerPlan = { kind: "immediate", text: "new owner reply" };
    // Milestone-3 admission binds the worker to a single run; the fresh owner
    // must be admitted for the run it executes.
    const fresh = harness.createClients({
      admissionProof: REPLACEMENT_CREDENTIAL,
      epoch: newEpoch,
      baseLeafId: oldCommit.newLeafId,
      runId: "fresh-run",
    });
    clients.push(fresh);
    await fresh.connection.start();
    expect(harness.admissions.at(-1)?.turnClaim).toMatchObject({
      runId: "fresh-run",
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: newEpoch },
    });
    await expect(
      fresh.inference.start({
        ...inferenceRequest(newEpoch, "handoff-new"),
        runId: "fresh-run",
      }),
    ).resolves.toEqual(doneOutcome("new owner reply"));
    await fresh.transcript.commit([transcriptMessage("new owner")]);

    const messages = SessionManager.open(harness.sessionTarget)
      .getEntries()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    expect(messages.map((message) => message.role)).toEqual(["user", "user"]);
    expect(harness.providerCalls).toBe(2);
    expect(
      harness.database.db
        .prepare(
          "SELECT run_epoch, next_seq FROM worker_transcript_commit_heads WHERE session_id = ? ORDER BY run_epoch",
        )
        .all(SESSION_ID),
    ).toEqual([
      { run_epoch: oldEpoch, next_seq: 2 },
      { run_epoch: newEpoch, next_seq: 2 },
    ]);
  });

  it("fail-stops a reconnected commit whose base changes while application is in flight", async () => {
    const current = harness.createClients();
    clients.push(current);
    const entered = createDeferred();
    const release = createDeferred();
    harness.transcriptGate = { phase: "before-apply", entered, release };
    await current.connection.start();
    const commit = current.transcript.commit([transcriptMessage("stale paid output")]);
    await entered.promise;
    harness.partition();
    const local = SessionManager.open(harness.sessionTarget);
    local.appendMessage(transcriptMessage("competing local entry"));
    release.resolve();

    await expect(commit).rejects.toMatchObject({
      name: "WorkerTranscriptCommitError",
      reason: "stale-base-leaf",
    });
    await expect(
      current.transcript.commit([transcriptMessage("must not retry after stale")]),
    ).rejects.toMatchObject({ name: "WorkerTranscriptCommitError" });
    expect(harness.requestParams("worker.transcript.commit")).toHaveLength(2);
    expect(SessionManager.open(harness.sessionTarget).getEntries()).toHaveLength(1);
  });

  it("advances a worker live stream whose run context is dispatch-owned and visible", async () => {
    const current = harness.createClients();
    clients.push(current);
    // A visible turn's run context is claimed by the gateway dispatch before the
    // turn hands off to the worker. The worker's first live event must adopt that
    // dispatch-owned context (seq advances from 1) and keep the run visible.
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    claimAgentRunContext(RUN_ID, {
      agentId: "main",
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      isControlUiVisible: true,
      lifecycleGeneration,
    });
    try {
      await current.connection.start();

      for (const delta of ["one", "two"]) {
        current.live.enqueuePreview(RUN_ID, {
          kind: "assistant",
          payload: { text: delta, delta },
        });
      }
      await expect(current.live.emitTerminal(RUN_ID, TERMINAL_EVENT)).resolves.toBeUndefined();

      expect(harness.liveDeltas).toEqual(["one", "two"]);
      expect(
        harness
          .requestParams("worker.live-event")
          .map((request) => (request as WorkerLiveEventParams).seq),
      ).toEqual([1, 2, 3]);
      expect(getAgentRunContext(RUN_ID)?.isControlUiVisible).toBe(true);
    } finally {
      clearAgentRunContext(RUN_ID);
    }
  });

  it("settles stop during an in-flight commit without retrying or spinning", async () => {
    const current = harness.createClients();
    clients.push(current);
    const entered = createDeferred();
    const release = createDeferred();
    harness.transcriptGate = { phase: "before-apply", entered, release };
    await current.connection.start();
    const commit = current.transcript.commit([transcriptMessage("stopped commit")]);
    await entered.promise;

    await current.connection.stop();
    await expect(commit).rejects.toBeInstanceOf(WorkerConnectionStoppedError);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(harness.requestParams("worker.transcript.commit")).toHaveLength(1);
    release.resolve();
  });
});
