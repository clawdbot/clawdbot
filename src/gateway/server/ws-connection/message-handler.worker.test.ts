import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WORKER_GITHUB_PUBLICATION_PROTOCOL_FEATURE,
  WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
  WORKER_PORTAL_PROTOCOL_FEATURE,
  WORKER_SESSION_TOOLS_PROTOCOL_FEATURE,
  type WorkerSessionToolResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { WORKER_INFERENCE_PROTOCOL_FEATURE } from "../../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createNoisyPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { prepareSystemAgentRunAdmission } from "../../../agents/admitted-run-context.js";
import type { SessionPlacementTurnParams } from "../../../agents/session-placement-admission.js";
import {
  beginGatewayRestartSignalAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { createWorkerSessionPlacementStore } from "../../worker-environments/placement-store.js";
import { signalWorkerTurnClaimClosed } from "../../worker-environments/placement-turn-claim-events.js";
import { prepareWorkerAgentRuntimeIdentity } from "../../worker-environments/worker-turn-payload.js";
import {
  CREDENTIAL,
  HANDSHAKE,
  IDENTITY,
  TRANSCRIPT_COMMIT,
  LIVE_EVENT,
  ATTACHED_IDENTITY,
  INFERENCE_IDS,
  INFERENCE_START,
  INFERENCE_EVENT,
  waitForWorkerProtocol,
  createRateLimiter,
  attachHarness,
  admit,
  setupWorkerProtocolTestState,
} from "./message-handler.worker.test-support.js";

const SESSION_TOOL_CASES = [
  {
    name: "spawn",
    method: "worker.sessions.spawn",
    toolName: "sessions_spawn",
    request: { toolCallId: "call-spawn", task: "run the child" },
  },
  {
    name: "send",
    method: "worker.sessions.send",
    toolName: "sessions_send",
    request: {
      toolCallId: "call-send",
      sessionKey: "agent:main:dashboard:child",
      message: "status",
    },
  },
  {
    name: "publish",
    method: "worker.github.publish",
    toolName: "github_publish",
    request: { toolCallId: "call-publish", title: "Publish the fix" },
  },
  {
    name: "portal",
    method: "worker.portal",
    toolName: "portal",
    request: { toolCallId: "call-portal", action: "open", port: 3000 },
  },
] as const;
describe("dedicated worker websocket protocol", () => {
  setupWorkerProtocolTestState();

  it("admits with a minimal secret-free hello", async () => {
    const harness = attachHarness();
    await admit(harness);

    expect(harness.responses[0]).toMatchObject({ ok: true, payload: { type: "worker-hello-ok" } });
    expect(JSON.stringify([harness.responses, harness.client()])).not.toContain(CREDENTIAL);
    expect(harness.client()).toMatchObject({
      connectionKind: "worker",
      connect: { role: "worker" },
    });
  });

  it("does not mark a synchronously closed hello ready or recreate its expiry timer", async () => {
    vi.useFakeTimers();
    const harness = attachHarness({ closeDuringHello: true });

    harness.sendConnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.responses).toHaveLength(1);
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.advanceHandshakePhase).not.toHaveBeenCalledWith("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps unrelated worker admission closed while startup is pending", async () => {
    const harness = attachHarness({ startupPending: () => true });
    harness.sendConnect();

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1013, "gateway-unavailable"),
    );
    expect(harness.service.admitWorker).not.toHaveBeenCalled();
    expect(harness.responses[0]).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", retryable: true },
    });
  });

  it("returns a bounded admission rejection", async () => {
    const reason = "invalid-credential" as const;
    const harness = attachHarness({ admissionFailure: reason });
    harness.sendConnect();

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"),
    );
    expect(harness.responses[0]).toMatchObject({
      ok: false,
      error: { details: { reason: "invalid-handshake" } },
    });
    expect(harness.logWsControl.warn).toHaveBeenCalledWith(
      `worker admission rejected reason=${reason}`,
    );
    expect(harness.setClient).not.toHaveBeenCalled();
  });

  it("fails closed when public ingress context is missing", async () => {
    const harness = attachHarness({ omitPublicAdmission: true });
    harness.sendConnect();

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"),
    );
    expect(harness.service.admitWorker).not.toHaveBeenCalled();
    expect(harness.logWsControl.warn).toHaveBeenCalledWith(
      "worker admission rejected reason=public-ingress-context-missing",
    );
  });

  it.each(["invalid-credential", "environment-mismatch"] as const)(
    "projects public %s failures to one opaque reason",
    async (internalReason) => {
      const recordFailure = vi.fn();
      const rateLimiter = createRateLimiter({ recordFailure });
      const harness = attachHarness({
        admissionFailure: internalReason,
        rateLimiter,
      });
      harness.sendConnect();

      await waitForWorkerProtocol(() =>
        expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"),
      );
      expect(harness.responses[0]).toMatchObject({
        ok: false,
        error: { details: { reason: "invalid-handshake" } },
      });
      expect(harness.logWsControl.warn).toHaveBeenCalledWith(
        `worker admission rejected reason=${internalReason}`,
      );
      expect(harness.setCloseCause).toHaveBeenCalledWith(internalReason);
      expect(recordFailure).toHaveBeenCalledWith("203.0.113.10", "worker-admission");
    },
  );

  it("rejects rate-limited public admission before credential verification", async () => {
    const rateLimiter = createRateLimiter({
      check: vi.fn(() => ({ allowed: false, remaining: 0, retryAfterMs: 12_000 })),
    });
    const harness = attachHarness({ rateLimiter });
    harness.sendConnect();

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"),
    );
    expect(harness.responses[0]).toMatchObject({
      ok: false,
      error: {
        details: { reason: "invalid-handshake" },
      },
    });
    expect(harness.service.admitWorker).not.toHaveBeenCalled();
    expect(harness.setCloseCause).toHaveBeenCalledWith("rate-limited");
  });

  it("resets public credential failures after successful admission", async () => {
    const reset = vi.fn();
    const rateLimiter = createRateLimiter({ reset });
    const harness = attachHarness({ rateLimiter });
    await admit(harness);

    expect(reset).toHaveBeenCalledWith("203.0.113.10", "worker-admission");
  });

  it("keeps public ownership failures opaque and charges the admission budget", async () => {
    const reset = vi.fn();
    const recordFailure = vi.fn();
    const rateLimiter = createRateLimiter({ reset, recordFailure });
    const harness = attachHarness({
      rateLimiter,
      validationFailure: "credential-replaced",
    });
    harness.sendConnect();

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"),
    );
    expect(harness.logWsControl.warn).toHaveBeenCalledWith(
      "worker admission rejected reason=credential-replaced",
    );
    expect(recordFailure).toHaveBeenCalledWith("203.0.113.10", "worker-admission");
    expect(reset).not.toHaveBeenCalled();
  });

  it.each([
    ["node.event", { event: "agent.request", payloadJSON: '{"requestId":"r-1"}' }],
    ["health", {}],
    ["worker.inference", {}],
  ])("rejects legacy method %s", async (method, params) => {
    const harness = attachHarness();
    await admit(harness);
    harness.sendRequest(method, params);

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "method-not-allowed"),
    );
    expect(harness.logGateway.warn).toHaveBeenCalledWith(
      "worker protocol request rejected reason=method-not-allowed",
    );
  });

  it("accepts heartbeat", async () => {
    const valid = attachHarness();
    await admit(valid);
    valid.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "busy" });
    await waitForWorkerProtocol(() => expect(valid.responses).toHaveLength(2));
    expect(valid.responses[1]).toMatchObject({
      ok: true,
      payload: { status: "ok", ownerEpoch: 1 },
    });
  });

  it("gates inference independently", async () => {
    const unsupported = attachHarness({
      identity: {
        ...ATTACHED_IDENTITY,
        protocolFeatures: HANDSHAKE.protocolFeatures.filter(
          (feature) => feature !== WORKER_INFERENCE_PROTOCOL_FEATURE,
        ),
      },
    });
    await admit(unsupported);
    unsupported.sendRequest("worker.inference.start", INFERENCE_START);
    await waitForWorkerProtocol(() =>
      expect(unsupported.close).toHaveBeenCalledWith(1008, "method-not-allowed"),
    );
    expect(unsupported.service.startInference).not.toHaveBeenCalled();
  });

  it("acknowledges inference before forwarding synchronous stream frames", async () => {
    const harness = attachHarness({
      identity: ATTACHED_IDENTITY,
      onInferenceLaunch: (sink) => sink.send(INFERENCE_EVENT),
    });
    await admit(harness);
    harness.sendRequest("worker.inference.start", INFERENCE_START);

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(3));
    expect(harness.responses[1]).toMatchObject({
      ok: true,
      payload: { status: "accepted" },
    });
    expect(harness.responses[2]).toEqual(INFERENCE_EVENT);
    expect(harness.service.startInference).toHaveBeenCalledOnce();

    harness.sendRequest("worker.inference.cancel", INFERENCE_IDS, "cancel-1");
    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(4));
    expect(harness.responses[3]).toMatchObject({
      ok: true,
      payload: { status: "cancelled" },
    });
    expect(harness.service.cancelInference).toHaveBeenCalledWith(ATTACHED_IDENTITY, INFERENCE_IDS);
  });

  it.each(SESSION_TOOL_CASES)(
    "keeps heartbeats flowing while $name is pending",
    async (testCase) => {
      const operation = createDeferredCore<WorkerSessionToolResult>();
      const harness = attachHarness({
        identity: ATTACHED_IDENTITY,
        onSessionTool: () => operation.promise,
      });
      await admit(harness);
      harness.sendRequest(testCase.method, testCase.request, `${testCase.name}-1`);
      await waitForWorkerProtocol(() =>
        expect(harness.service.executeSessionTool).toHaveBeenCalledOnce(),
      );

      harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "busy" }, "heartbeat-1");
      await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
      expect(harness.responses[1]).toMatchObject({
        id: "heartbeat-1",
        ok: true,
        payload: { status: "ok" },
      });

      operation.resolve({ resultJson: JSON.stringify({ content: [] }) });
      await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(3));
      expect(harness.responses[2]).toMatchObject({ id: `${testCase.name}-1`, ok: true });
    },
  );

  it.each(SESSION_TOOL_CASES)(
    "rejects an in-flight duplicate $name request id",
    async (testCase) => {
      const operation = createDeferredCore<WorkerSessionToolResult>();
      const harness = attachHarness({
        identity: ATTACHED_IDENTITY,
        onSessionTool: () => operation.promise,
      });
      await admit(harness);
      harness.sendRequest(testCase.method, testCase.request, "duplicate-session-operation");
      await waitForWorkerProtocol(() =>
        expect(harness.service.executeSessionTool).toHaveBeenCalledOnce(),
      );

      harness.sendRequest(testCase.method, testCase.request, "duplicate-session-operation");
      await waitForWorkerProtocol(() =>
        expect(harness.close).toHaveBeenCalledWith(1008, "invalid-frame"),
      );
      expect(harness.service.executeSessionTool).toHaveBeenCalledOnce();
      operation.resolve({ resultJson: JSON.stringify({ content: [] }) });
    },
  );

  it.each(SESSION_TOOL_CASES)(
    "continues durable $name work but suppresses its response after cleanup",
    async (testCase) => {
      let operationStarted = false;
      let operationSignal: AbortSignal | undefined;
      const operation = createDeferredCore<WorkerSessionToolResult>();
      const harness = attachHarness({
        identity: ATTACHED_IDENTITY,
        onSessionTool: (signal) => {
          operationStarted = true;
          operationSignal = signal;
          return operation.promise;
        },
      });
      await admit(harness);
      harness.sendRequest(testCase.method, testCase.request, `${testCase.name}-1`);
      await waitForWorkerProtocol(() => expect(operationStarted).toBe(true));

      harness.cleanup();
      expect(operationSignal).toBeUndefined();
      operation.resolve({ resultJson: JSON.stringify({ content: [] }) });
      await Promise.resolve();
      expect(harness.responses).toHaveLength(1);
    },
  );

  it.each(SESSION_TOOL_CASES)("routes and frames $name responses", async (testCase) => {
    const harness = attachHarness({ identity: ATTACHED_IDENTITY });
    await admit(harness);
    harness.sendRequest(testCase.method, testCase.request, `${testCase.name}-route`);

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.service.executeSessionTool).toHaveBeenCalledWith(
      ATTACHED_IDENTITY,
      testCase.toolName,
      testCase.request,
      undefined,
    );
    expect(harness.responses[1]).toMatchObject({
      id: `${testCase.name}-route`,
      ok: true,
      payload: { resultJson: expect.any(String) },
    });
    expect(harness.setLastFrameMeta).toHaveBeenLastCalledWith({
      type: "req",
      method: testCase.method,
    });
  });

  it.each(SESSION_TOOL_CASES)("feature-gates $name independently", async (testCase) => {
    const requiredFeature =
      testCase.toolName === "portal"
        ? WORKER_PORTAL_PROTOCOL_FEATURE
        : testCase.toolName === "github_publish"
          ? WORKER_GITHUB_PUBLICATION_PROTOCOL_FEATURE
          : WORKER_SESSION_TOOLS_PROTOCOL_FEATURE;
    const harness = attachHarness({
      identity: {
        ...ATTACHED_IDENTITY,
        protocolFeatures: ATTACHED_IDENTITY.protocolFeatures.filter(
          (feature) => feature !== requiredFeature,
        ),
      },
    });
    await admit(harness);
    harness.sendRequest(testCase.method, testCase.request);

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "method-not-allowed"),
    );
    expect(harness.service.executeSessionTool).not.toHaveBeenCalled();
  });

  it.each([
    ["an invalid action", { toolCallId: "call-portal", action: "delete", port: 3000 }],
    [
      "an unexpected field",
      { toolCallId: "call-portal", action: "open", port: 3000, unexpected: true },
    ],
  ])("rejects portal parameters with %s before execution", async (_reason, request) => {
    const harness = attachHarness({ identity: ATTACHED_IDENTITY });
    await admit(harness);
    harness.sendRequest("worker.portal", request);

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.responses[1]).toMatchObject({
      ok: false,
      error: { details: { reason: "invalid-frame" } },
    });
    expect(harness.service.executeSessionTool).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("dispatches semantic transcript commits on the closed worker allowlist", async () => {
    const harness = attachHarness();
    await admit(harness);
    harness.sendRequest("worker.transcript.commit", TRANSCRIPT_COMMIT);

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.responses[1]).toMatchObject({
      ok: true,
      payload: { entryIds: ["entry-1"], newLeafId: "entry-1" },
    });
    expect(harness.service.commitTranscript).toHaveBeenCalledWith(IDENTITY, TRANSCRIPT_COMMIT);
    expect(harness.setLastFrameMeta).toHaveBeenLastCalledWith({
      type: "req",
      method: "worker.transcript.commit",
    });
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("admits large image transcript frames without enlarging control or text budgets", async () => {
    const image = {
      type: "image",
      data: createNoisyPngBuffer(256, 256).toString("base64"),
      mimeType: "image/png",
    };
    expect(Buffer.byteLength(image.data)).toBeGreaterThan(64 * 1024);
    const transcript = {
      ...TRANSCRIPT_COMMIT,
      messages: [
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "read-image",
          timestamp: 1,
          isError: false,
          content: [image],
        },
      ],
    };
    const valid = attachHarness();
    await admit(valid);
    valid.sendRequest("worker.transcript.commit", transcript);
    await waitForWorkerProtocol(() => expect(valid.responses).toHaveLength(2));
    expect(valid.service.commitTranscript).toHaveBeenCalledWith(IDENTITY, transcript);
    expect(valid.close).not.toHaveBeenCalled();
    for (const [method, params] of [
      [
        "worker.transcript.commit",
        {
          ...transcript,
          messages: [
            {
              ...transcript.messages[0],
              content: [image, { type: "text", text: "x".repeat(64 * 1024) }],
            },
          ],
        },
      ],
      ["worker.heartbeat", { runEpoch: 1, extra: image.data }],
    ] as const) {
      const oversized = attachHarness();
      await admit(oversized);
      oversized.sendRequest(method, params);
      await waitForWorkerProtocol(() =>
        expect(oversized.close).toHaveBeenCalledWith(1009, "invalid-frame"),
      );
      expect(oversized.service.commitTranscript).not.toHaveBeenCalled();
    }
  });

  it("gates live-event features, schema, and closed errors", async () => {
    const unsupported = attachHarness({
      identity: {
        ...IDENTITY,
        protocolFeatures: HANDSHAKE.protocolFeatures.filter(
          (feature) => feature !== WORKER_LIVE_EVENT_PROTOCOL_FEATURE,
        ),
      },
    });
    await admit(unsupported);
    unsupported.sendRequest("worker.live-event", LIVE_EVENT);
    await waitForWorkerProtocol(() => expect(unsupported.close).toHaveBeenCalled());
    expect(unsupported.service.pushLiveEvent).not.toHaveBeenCalled();

    const resync = attachHarness({
      liveFailure: { reason: "resync-required", ackedSeq: 2, expectedSeq: 3 },
    });
    await admit(resync);
    resync.sendRequest("worker.live-event", { ...LIVE_EVENT, seq: 7 });
    await waitForWorkerProtocol(() =>
      expect(resync.responses[1]).toMatchObject({
        error: { details: { reason: "resync-required" } },
      }),
    );
    expect(resync.service.pushLiveEvent).toHaveBeenCalledOnce();

    const invalid = attachHarness();
    await admit(invalid);
    invalid.sendRequest("worker.live-event", {
      ...LIVE_EVENT,
      event: { kind: "assistant", payload: { delta: "x" } },
    });
    await waitForWorkerProtocol(() =>
      expect(invalid.responses[1]).toMatchObject({
        error: { details: { reason: "invalid-event" } },
      }),
    );
    expect(invalid.service.pushLiveEvent).not.toHaveBeenCalled();
  });

  it("dispatches a TLS certificate fallback step without closing the worker", async () => {
    const request = {
      ...LIVE_EVENT,
      event: {
        kind: "lifecycle" as const,
        payload: {
          phase: "fallback_step" as const,
          fallbackStepType: "fallback_step" as const,
          fallbackStepFromModel: "openai/gpt-primary",
          fallbackStepFromFailureReason: "tls_certificate" as const,
          fallbackStepFinalOutcome: "next_fallback" as const,
        },
      },
    };
    const harness = attachHarness();
    await admit(harness);
    harness.sendRequest("worker.live-event", request);

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.service.pushLiveEvent).toHaveBeenCalledWith(IDENTITY, request);
    expect(harness.responses[1]).toEqual({
      type: "res",
      id: "request-1",
      ok: true,
      payload: { ackedSeq: request.seq },
    });
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("rejects transcript commits when the admitted worker lacks the feature", async () => {
    const harness = attachHarness({
      identity: { ...IDENTITY, protocolFeatures: ["worker-heartbeat-v1"] },
    });
    await admit(harness);
    harness.sendRequest("worker.transcript.commit", TRANSCRIPT_COMMIT);

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "method-not-allowed"),
    );
    expect(harness.service.commitTranscript).not.toHaveBeenCalled();
  });

  it("returns closed transcript errors without closing the worker connection", async () => {
    const harness = attachHarness({ commitFailure: "stale-base-leaf" });
    await admit(harness);
    harness.sendRequest("worker.transcript.commit", TRANSCRIPT_COMMIT);

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.responses[1]).toMatchObject({
      ok: false,
      error: { details: { reason: "stale-base-leaf" } },
    });
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("rejects structurally invalid transcript batches before application", async () => {
    const harness = attachHarness();
    await admit(harness);
    harness.sendRequest("worker.transcript.commit", {
      ...TRANSCRIPT_COMMIT,
      sessionId: "foreign-session",
    });

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.responses[1]).toMatchObject({
      ok: false,
      error: { details: { reason: "invalid-batch" } },
    });
    expect(harness.service.commitTranscript).not.toHaveBeenCalled();
    expect(harness.close).not.toHaveBeenCalled();
  });

  it("closes a replaced worker before parsing a malformed transcript batch", async () => {
    const harness = attachHarness();
    await admit(harness);
    vi.mocked(harness.service.validateWorkerConnection).mockReturnValue("credential-replaced");
    harness.sendRequest("worker.transcript.commit", {
      ...TRANSCRIPT_COMMIT,
      sessionId: "foreign-session",
    });

    await waitForWorkerProtocol(() => expect(harness.responses).toHaveLength(2));
    expect(harness.responses[1]).toMatchObject({
      ok: false,
      error: { details: { reason: "credential-replaced" } },
    });
    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"),
    );
    expect(harness.service.commitTranscript).not.toHaveBeenCalled();
  });

  it("revalidates ownership immediately before admission", async () => {
    const harness = attachHarness({ validationFailure: "credential-replaced" });
    harness.sendConnect();

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "invalid-handshake"),
    );
    expect(harness.setCloseCause).toHaveBeenCalledWith("credential-replaced");
    expect(harness.setClient).not.toHaveBeenCalled();
  });

  it("revalidates ownership on heartbeat", async () => {
    const harness = attachHarness();
    await admit(harness);
    vi.mocked(harness.service.validateWorkerConnection).mockReturnValue("credential-replaced");
    harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "ready" });

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"),
    );
  });

  it("keeps an expired credential connected only while its durable turn remains valid", async () => {
    const harness = attachHarness({
      identity: { ...ATTACHED_IDENTITY, credentialExpiresAtMs: Date.now() + 20 },
    });
    await admit(harness);
    vi.mocked(harness.service.validateWorkerConnection).mockClear();

    await waitForWorkerProtocol(() =>
      expect(harness.service.validateWorkerConnection).toHaveBeenCalled(),
    );
    expect(harness.close).not.toHaveBeenCalled();

    vi.mocked(harness.service.validateWorkerConnection).mockReturnValue("credential-expired");
    harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "busy" });
    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "credential-expired"),
    );
  });

  it("fences a replaced connection before dispatch", async () => {
    const harness = attachHarness();
    await admit(harness);
    harness.client()!.invalidated = true;
    harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "ready" });

    await waitForWorkerProtocol(() =>
      expect(harness.close).toHaveBeenCalledWith(1008, "credential-replaced"),
    );
    expect(harness.service.validateWorkerConnection).toHaveBeenCalledOnce();
  });

  it.each([
    { scenario: "an already-admitted unaudited worker", fence: "none", accepted: true },
    { scenario: "a worker whose exact admitted run closed", fence: "run", accepted: false },
    { scenario: "a worker whose exact placement closed", fence: "placement", accepted: false },
    { scenario: "a worker during a restart signal", fence: "restart", accepted: false },
  ] as const)("handles $scenario while suspension drains", async ({ fence, accepted }) => {
    const claim = ATTACHED_IDENTITY.turnClaim;
    if (!claim) {
      throw new Error("expected attached worker turn claim");
    }
    const preparedRunAdmission = prepareSystemAgentRunAdmission(
      {},
      claim.runId,
      "main",
      "test.worker-suspension",
    );
    const stateDir = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-suspension-"),
    );
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    const placements = createWorkerSessionPlacementStore({ database });
    let placementActive = true;
    vi.spyOn(placements, "validateTurnClaim").mockImplementation(
      (current) => current === claim && placementActive,
    );
    const storePath = database.path;
    const rootAdmission = tryBeginGatewayRootWorkAdmission();
    if (!rootAdmission) {
      throw new Error("expected parent worker turn root admission");
    }
    let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
    let restartSignal: ReturnType<typeof beginGatewayRestartSignalAdmission> = null;
    try {
      const { runtimeIdentity } = await rootAdmission.run(() =>
        prepareWorkerAgentRuntimeIdentity({
          agentId: "main",
          placements,
          runtimeInstanceId: ATTACHED_IDENTITY.environmentId,
          sessionKey: "agent:main:worker-suspension",
          turn: {
            preparedRunAdmission,
            runId: claim.runId,
          } as SessionPlacementTurnParams,
          turnClaim: claim,
        }),
      );
      expect(runtimeIdentity.executionIdentityToken).toBeUndefined();
      const harness = attachHarness({ identity: ATTACHED_IDENTITY });
      await admit(harness);
      suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.drain()).toBe(true);
      if (fence === "run") {
        preparedRunAdmission.close();
      } else if (fence === "placement") {
        placementActive = false;
        signalWorkerTurnClaimClosed(storePath, claim);
      } else if (fence === "restart") {
        restartSignal = beginGatewayRestartSignalAdmission();
        expect(restartSignal).not.toBeNull();
      }

      harness.sendRequest("worker.transcript.commit", TRANSCRIPT_COMMIT);

      if (accepted) {
        await waitForWorkerProtocol(() =>
          expect(harness.service.commitTranscript).toHaveBeenCalledOnce(),
        );
        expect(harness.close).not.toHaveBeenCalled();
        expect(harness.responses[1]).toMatchObject({ ok: true });
      } else {
        await waitForWorkerProtocol(() =>
          expect(harness.close).toHaveBeenCalledWith(1013, "gateway-unavailable"),
        );
        expect(harness.service.commitTranscript).not.toHaveBeenCalled();
      }
    } finally {
      restartSignal?.rollback();
      suspension?.release();
      signalWorkerTurnClaimClosed(storePath, claim);
      preparedRunAdmission.close();
      rootAdmission.release();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects authenticated heartbeats while gateway admission is suspended", async () => {
    const harness = attachHarness();
    await admit(harness);
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension).not.toBeNull();
    try {
      harness.sendRequest("worker.heartbeat", { sentAtMs: 1, status: "ready" });
      await waitForWorkerProtocol(() =>
        expect(harness.close).toHaveBeenCalledWith(1013, "gateway-unavailable"),
      );
      expect(harness.service.validateWorkerConnection).toHaveBeenCalledOnce();
    } finally {
      suspension?.rollback();
    }
  });
});
