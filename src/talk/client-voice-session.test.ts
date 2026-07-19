import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  isClientVoiceSessionConfirmable,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
  resolveOpenClientVoiceSessionId,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const { sendDurableMessageBatch } = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("../channels/message/runtime.js", () => ({ sendDurableMessageBatch }));

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let tempDir: string;

async function seedSession(
  sessionKey: string,
  route: { lastChannel?: string; lastTo?: string } = {},
): Promise<void> {
  await replaceSessionEntry(
    { agentId: "main", sessionKey },
    {
      sessionId: `session-${sessionKey.replaceAll(":", "-")}`,
      updatedAt: Date.now(),
      ...route,
    },
  );
}

function recordMutation(voiceSessionId: string, runId = `run-${voiceSessionId}`): void {
  registerClientVoiceConsultRun({
    agentId: "main",
    sessionKey: "agent:main:main",
    voiceSessionId,
    runId,
  });
  emitTrustedDiagnosticEvent({
    type: "tool.execution.started",
    runId,
    toolCallId: `call-${runId}`,
    toolName: "message",
    mutatingAction: true,
  });
  emitTrustedDiagnosticEvent({
    type: "tool.execution.completed",
    runId,
    toolCallId: `call-${runId}`,
    toolName: "message",
    durationMs: 5,
  });
}

async function completeRun(runId: string): Promise<void> {
  emitTrustedDiagnosticEvent({
    type: "run.completed",
    runId,
    durationMs: 5,
    outcome: "completed",
  });
  await waitForDiagnosticEventsDrained();
}

describe("client voice session", () => {
  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voice-session-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    sendDurableMessageBatch.mockClear();
  });

  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates, resumes, and enforces ownership and open state", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      provider: "google",
      origin: "client",
      voiceSessionId: "voice-1",
      now: 10,
    });
    expect(
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        origin: "client",
        voiceSessionId,
        now: 20,
      }),
    ).toBe(voiceSessionId);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      provider: "google",
    });
    expect(() =>
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        provider: "openai",
        origin: "client",
        voiceSessionId,
      }),
    ).toThrow("provider does not match");
    expect(() =>
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:other",
        origin: "client",
        voiceSessionId,
      }),
    ).toThrow("does not belong");

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 30,
    });
    expect(() =>
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        origin: "client",
        voiceSessionId,
      }),
    ).toThrow("already closed");
  });

  it("marks confirmability by declared capability, relay origin, or observed transcript", () => {
    const capable = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      transcriptCapable: true,
      voiceSessionId: "voice-capable",
    });
    const legacy = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      voiceSessionId: "voice-legacy",
    });
    const relay = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "relay",
      voiceSessionId: "voice-relay",
    });
    const binding = (voiceSessionId: string) => ({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
    });
    expect(isClientVoiceSessionConfirmable(binding(capable))).toBe(true);
    expect(isClientVoiceSessionConfirmable(binding(legacy))).toBe(false);
    expect(isClientVoiceSessionConfirmable(binding(relay))).toBe(true);
  });

  it("closes idempotently without changing the first close time", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      now: 10,
    });
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 20,
    });
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 30,
    });

    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 20,
    });
  });

  it("keeps active consult runs voice-bound after the call closes", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    registerClientVoiceConsultRun({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      runId: "run-active",
    });

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });

    expect(resolveClientVoiceRunBinding("run-active")).toMatchObject({ voiceSessionId });
  });

  it("resolves the open client record for legacy tool calls", () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });

    expect(
      resolveOpenClientVoiceSessionId({ agentId: "main", sessionKey: "agent:main:main" }),
    ).toBe(voiceSessionId);
    expect(
      resolveOpenClientVoiceSessionId({ agentId: "main", sessionKey: "agent:main:other" }),
    ).toBeUndefined();
    createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    expect(
      resolveOpenClientVoiceSessionId({ agentId: "main", sessionKey: "agent:main:main" }),
    ).toBeUndefined();
  });

  it("keeps repeated tool-call ids separate across consult runs", () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    for (const runId of ["run-1", "run-2"]) {
      registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        runId,
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId,
        toolCallId: "call-1",
        toolName: "message",
        mutatingAction: true,
      });
    }

    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toHaveLength(2);
  });

  it("closes stale records and leaves recent records open", async () => {
    const stale = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:stale",
      origin: "client",
      now: 1,
    });
    const recent = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:recent",
      origin: "client",
      now: 6 * 60 * 60_000,
    });

    expect(
      await closeStaleClientVoiceSessions({
        agentId: "main",
        config: {},
        now: 6 * 60 * 60_000 + 2,
      }),
    ).toBe(1);
    expect(clientVoiceSessionTesting.readRecord("main", stale)?.status).toBe("closed");
    expect(clientVoiceSessionTesting.readRecord("main", recent)?.status).toBe("open");
  });

  it("records only mutating started effects and updates their terminal status", () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    registerClientVoiceConsultRun({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      runId: "run-1",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-1",
      toolCallId: "read-1",
      toolName: "read",
      mutatingAction: false,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-1",
      toolCallId: "message-1",
      toolName: "message",
      mutatingAction: true,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-1",
      toolCallId: "message-1",
      toolName: "message",
      durationMs: 4,
      errorCategory: "aborted",
      terminalReason: "cancelled",
    });

    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual([
      expect.objectContaining({
        toolCallId: "message-1",
        toolName: "message",
        status: "cancelled",
        finishedAt: expect.any(Number),
      }),
    ]);
  });

  it("records post-close effects and defers the digest until the last consult completes", async () => {
    await seedSession("agent:main:main", {
      lastChannel: "discord",
      lastTo: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    for (const runId of ["run-1", "run-2"]) {
      registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        runId,
      });
    }

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();

    for (const runId of ["run-1", "run-2"]) {
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId,
        toolCallId: `call-${runId}`,
        toolName: "message",
        mutatingAction: true,
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.completed",
        runId,
        toolCallId: `call-${runId}`,
        toolName: "message",
        durationMs: 5,
      });
    }
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.effects).toEqual([
      expect.objectContaining({ runId: "run-1", status: "succeeded" }),
      expect.objectContaining({ runId: "run-2", status: "succeeded" }),
    ]);

    await completeRun("run-1");
    expect(sendDurableMessageBatch).not.toHaveBeenCalled();
    await completeRun("run-2");
    await vi.waitFor(() => expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1));
    expect(sendDurableMessageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        payloads: [{ text: "Voice call changes\n- message: succeeded\n- message: succeeded" }],
      }),
    );
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt).toEqual(
      expect.any(Number),
    );

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
  });

  it("retries a deferred digest on the next voice session after a failed delivery", async () => {
    await seedSession("agent:main:main", {
      lastChannel: "discord",
      lastTo: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    registerClientVoiceConsultRun({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      runId: "run-live",
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-live",
      toolCallId: "call-run-live",
      toolName: "message",
      mutatingAction: true,
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-live",
      toolCallId: "call-run-live",
      toolName: "message",
      durationMs: 5,
    });
    // Call ends while the consult still runs, so the digest is deferred.
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));
    await completeRun("run-live");
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
    ).toBeUndefined();

    // Starting the next voice session retries the deferred digest.
    await closeStaleClientVoiceSessions({ agentId: "main", config: {} });
    await vi.waitFor(() =>
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number)),
    );
  });

  it("retries the mutation digest after a transient send failure", async () => {
    await seedSession("agent:main:main", {
      lastChannel: "discord",
      lastTo: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);
    sendDurableMessageBatch.mockRejectedValueOnce(new Error("channel offline"));

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    }).catch(() => undefined);
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
    ).toBeUndefined();

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(2);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt).toEqual(
      expect.any(Number),
    );
  });

  it("delivers one mutation digest and skips webchat or missing targets", async () => {
    await seedSession("agent:main:main", {
      lastChannel: "discord",
      lastTo: "channel:voice-updates",
    });
    const delivered = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
    });
    recordMutation(delivered);
    await completeRun(`run-${delivered}`);
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId: delivered,
      config: {},
    });
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId: delivered,
      config: {},
    });
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
    expect(sendDurableMessageBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        durability: "required",
        requireUnknownSendReconciliation: true,
        payloads: [{ text: "Voice call changes\n- message: succeeded" }],
      }),
    );

    for (const [voiceSessionId, route] of [
      ["voice-webchat", { lastChannel: "webchat", lastTo: "browser" }],
      ["voice-no-target", {}],
    ] as const) {
      const sessionKey = `agent:main:${voiceSessionId}`;
      await seedSession(sessionKey, route);
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
        voiceSessionId,
      });
      registerClientVoiceConsultRun({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        runId: `run-${voiceSessionId}`,
      });
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId: `run-${voiceSessionId}`,
        toolCallId: `call-${voiceSessionId}`,
        toolName: "message",
        mutatingAction: true,
      });
      await completeRun(`run-${voiceSessionId}`);
      await closeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        config: {},
      });
    }
    expect(sendDurableMessageBatch).toHaveBeenCalledTimes(1);
  });
});
