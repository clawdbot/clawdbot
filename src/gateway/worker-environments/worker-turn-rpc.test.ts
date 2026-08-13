import { describe, expect, it, vi } from "vitest";
import { hashWorkerCredential } from "./credential.js";
import * as support from "./service.test-support.js";

type WorkerEnvironmentServiceOptions = support.WorkerEnvironmentServiceOptions;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("admits an npm-installed worker from canonical bundle identity without registry access", async () => {
    const environmentId = "worker-npm-admission";
    support.seedReady(environmentId, "npm");
    support.testState.prepareInstallation = vi.fn(async (install) => {
      if (install === "npm") {
        throw new Error("registry unavailable");
      }
      return support.BUNDLE_ARTIFACT;
    });
    const workerService = support.createService(support.createProvider());

    await expect(
      workerService.admitWorker(support.admissionFor(environmentId)),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(support.testState.prepareInstallation).toHaveBeenCalledTimes(1);
    expect(support.testState.prepareInstallation).toHaveBeenCalledWith("bundle");
  });

  it("fences transcript commits by current epoch and exact session credential binding", async () => {
    const environmentId = "worker-transcript-fence";
    const sessionId = "session-transcript-fence";
    const identity = support.seedAttachedIdentity(environmentId, sessionId);
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-1");
    const workerService = support.createService(support.createProvider(), {
      applyTranscriptCommit,
    });
    const request = support.transcriptRequest(identity, "hello");

    await expect(workerService.commitTranscript(identity, request)).resolves.toMatchObject({
      ok: true,
    });
    expect(applyTranscriptCommit).toHaveBeenCalledOnce();

    await expect(
      workerService.commitTranscript(identity, {
        ...request,
        runEpoch: identity.ownerEpoch + 1,
        seq: 2,
      }),
    ).resolves.toEqual({ ok: false, reason: "epoch-mismatch" });
    support.testState.stateDb.db
      .prepare("UPDATE worker_environment_credentials SET session_id = ? WHERE environment_id = ?")
      .run("session-other", environmentId);
    await expect(workerService.commitTranscript(identity, { ...request, seq: 2 })).resolves.toEqual(
      { ok: false, reason: "session-not-attached" },
    );
    expect(applyTranscriptCommit).toHaveBeenCalledOnce();
  });

  it("admits only a gateway-preclaimed worker placement and fences later requests", async () => {
    const environmentId = "worker-placement-fence";
    const sessionId = "session-placement-fence";
    const { identity, placementStore, workerService } = support.placementHarness(
      environmentId,
      sessionId,
    );
    const admission = {
      environmentId,
      credential: [support.CREDENTIAL, environmentId, sessionId].join("-"),
      sessionId,
      runId: "run-1",
      ownerEpoch: identity.ownerEpoch,
      rpcSetVersion: 1,
      handshake: support.BOOTSTRAP_RECEIPT,
    };

    await expect(workerService.admitWorker(admission)).resolves.toMatchObject({ ok: true });
    await expect(workerService.admitWorker(admission)).resolves.toMatchObject({ ok: true });
    expect(placementStore.validateWorkerTurn).toHaveBeenLastCalledWith({
      sessionId,
      environmentId,
      ownerEpoch: identity.ownerEpoch,
      runId: "run-1",
    });
    expect(placementStore.validateWorkerTurn).toHaveBeenCalledTimes(2);
    expect(workerService.validateWorkerConnection(identity)).toBeNull();

    const warmEnvironmentId = "worker-placement-warm";
    support.seedReady(warmEnvironmentId);
    const warmAdmission = await workerService.admitWorker(support.admissionFor(warmEnvironmentId));
    expect(warmAdmission).toMatchObject({ ok: true });
    if (!warmAdmission.ok) {
      throw new Error("warm worker admission failed");
    }
    expect(workerService.validateWorkerConnection(warmAdmission.identity)).toBeNull();
    expect(placementStore.validateWorkerTurn).toHaveBeenCalledTimes(3);

    placementStore.validateWorkerTurn.mockReturnValue(false);
    await expect(
      workerService.admitWorker({ ...admission, runId: "run-conflict" }),
    ).resolves.toEqual({ ok: false, reason: "placement-mismatch" });

    placementStore.validateWorkerTurn.mockReturnValue(true);
    support.testState.nowMs += 10_000;
    expect(workerService.validateWorkerConnection(identity)).toBeNull();
    expect(workerService.validateWorkerConnection(warmAdmission.identity)).toBe(
      "credential-expired",
    );
    await expect(workerService.admitWorker(admission)).resolves.toMatchObject({
      ok: true,
      identity: { sessionId, runId: "run-1" },
    });

    placementStore.validateWorkerTurn.mockReturnValue(false);
    expect(workerService.validateWorkerConnection(identity)).toBe("placement-mismatch");
    vi.mocked(support.testState.prepareInstallation).mockClear();
    await expect(workerService.admitWorker(admission)).resolves.toEqual({
      ok: false,
      reason: "credential-expired",
    });
    expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
    await expect(
      workerService.commitTranscript(identity, support.transcriptRequest(identity, "fenced")),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
  });

  it("does not rotate an expired delivered credential while its durable turn is active", async () => {
    const environmentId = "worker-expired-active-turn";
    const sessionId = "session-expired-active-turn";
    const liveEvents = support.createLiveEvents();
    const { identity, workerService } = support.placementHarness(environmentId, sessionId, {
      liveEvents,
    });
    support.testState.store.markCredentialDelivered({
      environmentId,
      credentialHash: identity.credentialHash,
      ownerEpoch: identity.ownerEpoch,
      sessionId,
      deliveredAtMs: support.testState.nowMs,
    });
    support.testState.nowMs = identity.credentialExpiresAtMs;

    await workerService.reconcileOnce();

    expect(support.testState.store.getCredential(environmentId)?.credentialHash).toBe(
      identity.credentialHash,
    );
    expect(liveEvents.rotateCredential).not.toHaveBeenCalled();
  });

  it("keeps preview ACKs in memory and persists only transcript and terminal cursors", async () => {
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-placement");
    const { liveEvents } = support.sequencedLiveEvents();
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-placement-ack",
      "session-placement-ack",
      {
        applyTranscriptCommit,
        liveEvents,
      },
    );
    const binding = support.placementBinding(identity);

    await expect(
      workerService.commitTranscript(
        identity,
        support.transcriptRequest(identity, "commit", { seq: 7 }),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(placementStore.updateAckCursors).toHaveBeenCalledWith({
      ...binding,
      transcriptSeq: 7,
    });

    await expect(
      workerService.pushLiveEvent(identity, support.assistantEvent(identity, "preview")),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 1 } });
    expect(placementStore.updateAckCursors).toHaveBeenCalledOnce();

    await expect(
      workerService.pushLiveEvent(
        identity,
        support.terminalEvent(identity, { lastAckedSeq: 1, seq: 2 }),
      ),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 2 } });
    expect(placementStore.updateAckCursors).toHaveBeenLastCalledWith({
      ...binding,
      liveSeq: 2,
    });
  });

  it("uses worker finishing as the durable workspace-result fence", async () => {
    const { liveEvents } = support.sequencedLiveEvents();
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-placement-finishing",
      "session-placement-finishing",
      { liveEvents },
    );
    const terminal = support.terminalEvent(identity);
    const finishing = {
      ...terminal,
      event: {
        kind: "lifecycle" as const,
        payload: { phase: "finishing" as const, startedAt: 1, endedAt: 2 },
      },
    };

    await expect(workerService.pushLiveEvent(identity, finishing)).resolves.toEqual({
      ok: true,
      result: { ackedSeq: 1 },
    });
    expect(placementStore.updateAckCursors).toHaveBeenLastCalledWith({
      ...support.placementBinding(identity),
      liveSeq: 1,
    });
  });

  it("does not ACK a transcript commit after its worker claim is fenced", async () => {
    let finishCommit: (() => void) | undefined;
    const commitBlocked = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const applyTranscriptCommit = support.successfulTranscriptCommit(
      "entry-placement-race",
      () => commitBlocked,
    );
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-placement-race",
      "session-placement-race",
      { applyTranscriptCommit },
    );

    const commit = workerService.commitTranscript(
      identity,
      support.transcriptRequest(identity, "commit before claim fence"),
    );
    await support.waitForFast(() => expect(applyTranscriptCommit).toHaveBeenCalledOnce());
    placementStore.validateWorkerTurn.mockReturnValue(false);
    finishCommit?.();

    await expect(commit).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(placementStore.validateWorkerTurn).toHaveBeenCalledTimes(2);
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();
  });

  it("advances the transcript cursor when a stale-base commit consumes its sequence", async () => {
    const applyTranscriptCommit = vi
      .fn<NonNullable<WorkerEnvironmentServiceOptions["applyTranscriptCommit"]>>()
      .mockResolvedValueOnce({ ok: false, reason: "stale-base-leaf" })
      .mockResolvedValueOnce({ ok: false, reason: "invalid-batch" });
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-placement-stale",
      "session-placement-stale",
      { applyTranscriptCommit },
    );
    const request = support.transcriptRequest(identity, "stale commit", {
      seq: 11,
      baseLeafId: "stale-leaf",
    });

    await expect(workerService.commitTranscript(identity, request)).resolves.toEqual({
      ok: false,
      reason: "stale-base-leaf",
    });
    expect(placementStore.updateAckCursors).toHaveBeenCalledWith({
      ...support.placementBinding(identity),
      transcriptSeq: 11,
    });

    await expect(
      workerService.commitTranscript(identity, { ...request, seq: 12 }),
    ).resolves.toEqual({ ok: false, reason: "invalid-batch" });
    expect(placementStore.updateAckCursors).toHaveBeenCalledOnce();
  });

  it("fences after a buffered terminal event becomes acknowledged by a gap fill", async () => {
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-after-terminal-gap");
    const { apply: liveApply, liveEvents } = support.sequencedLiveEvents((seq) =>
      seq === 1 ? 2 : 0,
    );
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-placement-gap",
      "session-placement-gap",
      {
        applyTranscriptCommit,
        liveEvents,
      },
    );

    await expect(
      workerService.pushLiveEvent(identity, support.terminalEvent(identity, { seq: 2 })),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 0 } });
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();

    await expect(
      workerService.pushLiveEvent(identity, support.assistantEvent(identity, "fills gap")),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 2 } });
    expect(placementStore.updateAckCursors).toHaveBeenCalledOnce();
    expect(placementStore.updateAckCursors).toHaveBeenCalledWith({
      ...support.placementBinding(identity),
      liveSeq: 2,
    });
    await expect(
      workerService.commitTranscript(
        identity,
        support.transcriptRequest(identity, "late transcript"),
      ),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    await expect(
      workerService.pushLiveEvent(
        identity,
        support.assistantEvent(identity, "late", { lastAckedSeq: 2, seq: 3 }),
      ),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(applyTranscriptCommit).not.toHaveBeenCalled();
    expect(liveApply).toHaveBeenCalledTimes(2);
  });

  it("applies a terminal ACK only after its transcript commit finishes", async () => {
    let finishCommit: (() => void) | undefined;
    const commitBlocked = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const applyTranscriptCommit = support.successfulTranscriptCommit(
      "entry-order",
      () => commitBlocked,
    );
    const { liveEvents } = support.sequencedLiveEvents();
    const { identity, placementStore, workerService } = support.placementHarness(
      "worker-placement-order",
      "session-placement-order",
      { applyTranscriptCommit, liveEvents },
    );

    const commit = workerService.commitTranscript(
      identity,
      support.transcriptRequest(identity, "commit before terminal"),
    );
    await support.waitForFast(() => expect(applyTranscriptCommit).toHaveBeenCalledOnce());
    const terminal = workerService.pushLiveEvent(identity, support.terminalEvent(identity));
    await Promise.resolve();
    expect(placementStore.updateAckCursors).not.toHaveBeenCalled();

    finishCommit?.();
    await expect(commit).resolves.toMatchObject({ ok: true });
    await expect(terminal).resolves.toEqual({ ok: true, result: { ackedSeq: 1 } });
    expect(placementStore.updateAckCursors.mock.calls).toEqual([
      [
        {
          ...support.placementBinding(identity),
          transcriptSeq: 1,
        },
      ],
      [
        {
          ...support.placementBinding(identity),
          liveSeq: 1,
        },
      ],
    ]);
  });

  it("fences post-terminal mutations while preserving sequenced replays", async () => {
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-terminal");
    const { apply: liveApply, liveEvents } = support.sequencedLiveEvents();
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async () => ({
        type: "error",
        reason: "provider-error",
        message: "Provider request failed",
      }),
    );
    const { identity, workerService } = support.placementHarness(
      "worker-terminal-fence",
      "session-terminal-fence",
      { applyTranscriptCommit, executeInference, liveEvents },
    );
    const transcript = support.transcriptRequest(identity, "terminal fence");
    const terminal = support.terminalEvent(identity);

    await expect(workerService.commitTranscript(identity, transcript)).resolves.toMatchObject({
      ok: true,
    });
    await expect(workerService.pushLiveEvent(identity, terminal)).resolves.toEqual({
      ok: true,
      result: { ackedSeq: 1 },
    });

    await expect(workerService.commitTranscript(identity, transcript)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      workerService.commitTranscript(identity, { ...transcript, seq: 2 }),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(applyTranscriptCommit).toHaveBeenCalledTimes(2);

    await expect(workerService.pushLiveEvent(identity, terminal)).resolves.toEqual({
      ok: true,
      result: { ackedSeq: 1 },
    });
    await expect(
      workerService.pushLiveEvent(identity, support.assistantEvent(identity, "late", { seq: 2 })),
    ).resolves.toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(liveApply).toHaveBeenCalledTimes(2);

    expect(
      workerService.startInference(identity, support.inferenceRequest(identity), {
        connectionId: "connection-terminal-fence",
        send: vi.fn(),
      }),
    ).toEqual({ ok: false, closeReason: "placement-mismatch" });
    expect(workerService.cancelInference(identity, support.inferenceRequest(identity))).toEqual({
      ok: false,
      closeReason: "placement-mismatch",
    });
    expect(executeInference).not.toHaveBeenCalled();

    const rotatedCredentialHash = hashWorkerCredential(
      ["rotated", identity.environmentId, identity.sessionId].join("-"),
    );
    support.testState.stateDb.db
      .prepare(
        "UPDATE worker_environment_credentials SET credential_hash = ? WHERE environment_id = ?",
      )
      .run(rotatedCredentialHash, identity.environmentId);
    const rotatedIdentity = { ...identity, credentialHash: rotatedCredentialHash };
    await expect(
      workerService.commitTranscript(rotatedIdentity, { ...transcript, seq: 2 }),
    ).resolves.toMatchObject({ ok: true });
    expect(applyTranscriptCommit).toHaveBeenCalledTimes(3);
  });

  it("does not treat a terminal event on an already ACKed sequence as authoritative", async () => {
    const applyTranscriptCommit = support.successfulTranscriptCommit("entry-after-reuse");
    const { liveEvents } = support.sequencedLiveEvents();
    const { identity, workerService } = support.placementHarness(
      "worker-terminal-reuse",
      "session-terminal-reuse",
      { applyTranscriptCommit, liveEvents },
    );
    const event = support.assistantEvent(identity, "first");

    await expect(workerService.pushLiveEvent(identity, event)).resolves.toMatchObject({ ok: true });
    await expect(
      workerService.pushLiveEvent(identity, support.terminalEvent(identity)),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      workerService.commitTranscript(
        identity,
        support.transcriptRequest(identity, "still mutable"),
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(applyTranscriptCommit).toHaveBeenCalledOnce();
  });

  it("fences inference by epoch and the durable session credential", async () => {
    const identity = support.seedAttachedIdentity(
      "worker-inference-fence",
      "session-inference-fence",
    );
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async () => ({
        type: "error",
        reason: "provider-error",
        message: "Provider request failed",
      }),
    );
    const workerService = support.createService(support.createProvider(), { executeInference });
    const request = support.inferenceRequest(identity);
    expect(
      workerService.startInference(
        identity,
        { ...request, sessionId: "session-other" },
        { connectionId: "connection-a", send: vi.fn() },
      ),
    ).toEqual({ ok: false, reason: "session-not-attached" });
    expect(
      workerService.startInference(
        identity,
        { ...request, runEpoch: request.runEpoch + 1 },
        { connectionId: "connection-b", send: vi.fn() },
      ),
    ).toEqual({ ok: false, reason: "epoch-mismatch" });

    const send = vi.fn();
    const started = workerService.startInference(identity, request, {
      connectionId: "connection-c",
      send,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error("inference fixture failed to start");
    }
    support.testState.stateDb.db
      .prepare(
        "UPDATE worker_environment_credentials SET credential_hash = ? WHERE environment_id = ?",
      )
      .run(
        hashWorkerCredential(["replacement", identity.environmentId].join("-")),
        identity.environmentId,
      );
    started.launch();
    await support.waitForFast(() => expect(send).toHaveBeenCalledOnce());
    expect(executeInference).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      event: "worker.inference.terminal",
      payload: { outcome: { reason: "session-not-attached" } },
    });
  });

  it("fences and rotates live credentials", async () => {
    const environmentId = "worker-live";
    const sessionId = "session-live";
    const identity = support.seedAttachedIdentity(environmentId, sessionId);
    const liveEvents = support.createLiveEvents();
    let inferenceSignal: AbortSignal | undefined;
    const executeInference = vi.fn<WorkerEnvironmentServiceOptions["executeInference"]>(
      async ({ signal }) => {
        inferenceSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { type: "error", reason: "cancelled", message: "Inference cancelled" };
      },
    );
    const workerService = support.createService(support.createProvider(), {
      executeInference,
      liveEvents,
    });
    const request = { ...support.LIVE_EVENT, runEpoch: identity.ownerEpoch };
    const push = workerService.pushLiveEvent.bind(workerService, identity);
    await push(request);
    await expect(push({ ...request, runEpoch: identity.ownerEpoch + 1 })).resolves.toEqual({
      ok: false,
      details: { reason: "epoch-mismatch" },
    });
    const started = workerService.startInference(identity, support.inferenceRequest(identity), {
      connectionId: "connection-rotation",
      send: vi.fn(),
    });
    if (!started.ok) {
      throw new Error("inference fixture failed to start");
    }
    started.launch();
    await support.waitForFast(() => expect(executeInference).toHaveBeenCalledOnce());
    support.testState.stateDb.db
      .prepare("UPDATE worker_environment_credentials SET session_id = ? WHERE environment_id = ?")
      .run("session-other", environmentId);
    await expect(push({ ...request, seq: 2 })).resolves.toEqual({
      ok: false,
      details: { reason: "session-not-attached" },
    });
    liveEvents.rotateCredential.mockClear();
    support.testState.nowMs += 10_000;
    await workerService.reconcileOnce();
    expect(inferenceSignal?.aborted).toBe(true);
    expect(liveEvents.rotateCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialHash: support.testState.store.getCredential(environmentId)?.credentialHash,
        previousCredentialHash: identity.credentialHash,
        runEpoch: identity.ownerEpoch,
      }),
    );
  });
});
