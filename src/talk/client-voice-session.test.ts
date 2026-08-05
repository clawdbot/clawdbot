import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  normalizeSessionDeliveryState,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import {
  authorizeClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
  noteClientVoiceConfirmationUtterance,
} from "./client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "./client-voice-confirmation.test-support.js";
import {
  appendClientVoiceTranscript,
  appendRelayVoiceTranscript,
  closeClientVoiceSession,
  closeRelayVoiceSessionRecord,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  isClientVoiceSessionConfirmable,
  registerClientVoiceConsultRun,
  resolveClientVoiceAgentSessionId,
  resolveClientVoiceRunBinding,
  resolveOpenClientVoiceSessionId,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";
import { VOICE_TRANSCRIPT_MAX_UNRESOLVED } from "./voice-transcript.js";

type AppendTranscriptMessage =
  (typeof import("../config/sessions/session-accessor.js"))["appendTranscriptMessage"];

const sessionAccessorMocks = vi.hoisted(() => ({
  actualAppendTranscriptMessage: undefined as AppendTranscriptMessage | undefined,
  appendTranscriptMessage: vi.fn<AppendTranscriptMessage>(),
}));
const { sendDurableMessageBatch } = vi.hoisted(() => ({
  sendDurableMessageBatch: vi.fn(async () => ({ status: "sent" })),
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  sessionAccessorMocks.actualAppendTranscriptMessage = actual.appendTranscriptMessage;
  sessionAccessorMocks.appendTranscriptMessage.mockImplementation(actual.appendTranscriptMessage);
  return { ...actual, appendTranscriptMessage: sessionAccessorMocks.appendTranscriptMessage };
});
vi.mock("../channels/message/runtime.js", () => ({ sendDurableMessageBatch }));

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
let tempDir: string;

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function seedSession(sessionKey: string, context: DeliveryContext = {}): Promise<void> {
  await replaceSessionEntry(
    { agentId: "main", sessionKey },
    {
      sessionId: `session-${sessionKey.replaceAll(":", "-")}`,
      updatedAt: Date.now(),
      delivery: normalizeSessionDeliveryState({ context }),
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
    sendDurableMessageBatch.mockReset().mockResolvedValue({ status: "sent" });
    sessionAccessorMocks.appendTranscriptMessage.mockReset();
    if (sessionAccessorMocks.actualAppendTranscriptMessage) {
      sessionAccessorMocks.appendTranscriptMessage.mockImplementation(
        sessionAccessorMocks.actualAppendTranscriptMessage,
      );
    }
  });

  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
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

  it("stamps the agent session row when Talk creates it", async () => {
    const sessionKey = "agent:main:talk:new";
    const sessionId = await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey });

    expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
      sessionId,
      createdVia: "talk",
      createdActor: { type: "human" },
      createdAt: expect.any(Number),
    });

    await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey });
    expect(loadSessionEntry({ agentId: "main", sessionKey })?.createdVia).toBe("talk");
  });

  it("reads an existing agent session without creating a missing row", async () => {
    const existingKey = "agent:main:talk:existing";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: existingKey },
      { sessionId: "session-existing", updatedAt: 1 },
    );

    expect(resolveClientVoiceAgentSessionId({ agentId: "main", sessionKey: existingKey })).toBe(
      "session-existing",
    );
    expect(
      resolveClientVoiceAgentSessionId({
        agentId: "main",
        sessionKey: "agent:main:talk:missing",
      }),
    ).toBeUndefined();
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: "agent:main:talk:missing" }),
    ).toBeUndefined();
  });

  it("does not create an agent session after a browser-session deadline", async () => {
    const sessionKey = "agent:main:talk:expired";

    await expect(
      ensureClientVoiceAgentSessionEntry({
        agentId: "main",
        sessionKey,
        deadlineAt: Date.now() - 1,
      }),
    ).rejects.toThrow("Realtime browser session expired during startup");
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toBeUndefined();
  });

  it("repairs an incomplete existing row without claiming its creation actor", async () => {
    const sessionKey = "agent:main:talk:incomplete";
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId: "", updatedAt: 1, createdVia: "internal", createdAt: 1 },
    );

    await ensureClientVoiceAgentSessionEntry({ agentId: "main", sessionKey });

    const repaired = loadSessionEntry({ agentId: "main", sessionKey });
    expect(repaired?.sessionId).toBeTruthy();
    expect(repaired).toMatchObject({ createdVia: "internal", createdAt: 1 });
    expect(repaired?.createdActor).toBeUndefined();
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

  it("waits for transcript serialization but not mutation digest delivery", async () => {
    await seedSession("agent:main:main", {
      channel: "discord",
      to: "channel:voice-updates",
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      voiceSessionId: "voice-durable-close",
    });
    recordMutation(voiceSessionId);
    await completeRun(`run-${voiceSessionId}`);

    const confirmation = checkClientVoiceToolConfirmationPolicy({
      agentId: "main",
      voiceSessionId,
      toolName: "message",
      toolParams: { channel: "discord", message: "send it" },
      isConfirmable: () => true,
      now: 10,
    });
    if (confirmation.allowed) {
      throw new Error("expected a pending voice confirmation");
    }
    const confirmationId = confirmation.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1];
    if (!confirmationId) {
      throw new Error("expected a voice confirmation id");
    }

    const transcriptWrite = createDeferred();
    const actualAppend = sessionAccessorMocks.actualAppendTranscriptMessage!;
    sessionAccessorMocks.appendTranscriptMessage.mockImplementationOnce(async (...args) => {
      await transcriptWrite.promise;
      return await actualAppend(...args);
    });
    const append = appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      entryId: "final",
      role: "assistant",
      text: "final answer",
    });
    await vi.waitFor(() =>
      expect(sessionAccessorMocks.appendTranscriptMessage).toHaveBeenCalledOnce(),
    );

    const digestSend = createDeferred<{ status: "sent" }>();
    sendDurableMessageBatch.mockImplementationOnce(() => digestSend.promise);
    let closeSettled = false;
    const close = closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 42,
    }).then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");

    transcriptWrite.resolve();
    await Promise.all([append, close]);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 42,
    });
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
    ).toBeUndefined();
    await vi.waitFor(() => expect(sendDurableMessageBatch).toHaveBeenCalledOnce());

    noteClientVoiceConfirmationUtterance({
      agentId: "main",
      voiceSessionId,
      text: "yes",
      timestamp: 11,
    });
    expect(() =>
      authorizeClientVoiceConfirmation({
        agentId: "main",
        voiceSessionId,
        confirmationId,
        now: 12,
      }),
    ).toThrow("voice confirmation is missing");

    digestSend.resolve({ status: "sent" });
    await vi.waitFor(() =>
      expect(
        clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.digestDeliveredAt,
      ).toEqual(expect.any(Number)),
    );
  });

  it("rejects a concurrent close when an accepted transcript fails", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      voiceSessionId: "voice-concurrent-close-failure",
    });
    const transcriptWrite = createDeferred();
    const failure = new Error("transcript write failed");
    sessionAccessorMocks.appendTranscriptMessage.mockImplementationOnce(async () => {
      await transcriptWrite.promise;
      throw failure;
    });
    const append = appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      entryId: "failed",
      role: "user",
      text: "persist me",
    });
    await vi.waitFor(() =>
      expect(sessionAccessorMocks.appendTranscriptMessage).toHaveBeenCalledOnce(),
    );
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toEqual([expect.any(String)]);
    const close = closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 42,
    });

    transcriptWrite.resolve();
    await expect(append).rejects.toBe(failure);
    await expect(close).rejects.toBe(failure);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
  });

  it("keeps the session open when a failed transcript is retried after close", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      voiceSessionId: "voice-close-after-failure",
    });
    const transcriptWrite = createDeferred();
    const failure = new Error("transcript write failed");
    const actualAppend = sessionAccessorMocks.actualAppendTranscriptMessage!;
    sessionAccessorMocks.appendTranscriptMessage.mockImplementationOnce(async () => {
      await transcriptWrite.promise;
      throw failure;
    });
    const append = appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      entryId: "retryable",
      role: "user",
      text: "persist me",
    });
    const appendResult = append.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() =>
      expect(sessionAccessorMocks.appendTranscriptMessage).toHaveBeenCalledOnce(),
    );
    transcriptWrite.resolve();
    expect(await appendResult).toBe(failure);
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toEqual([expect.any(String)]);
    clientVoiceSessionTesting.reset();
    await expect(
      closeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        config: {},
        now: 42,
      }),
    ).rejects.toThrow("voice transcript persistence must be retried before close");
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
    sessionAccessorMocks.appendTranscriptMessage.mockImplementation(actualAppend);
    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      entryId: "retryable",
      role: "user",
      text: "persist me",
    });
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 99,
    });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 99,
    });
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toEqual([]);
  });

  it("terminally closes relay sessions while retaining unresolved transcript identity", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "relay",
    });
    sessionAccessorMocks.appendTranscriptMessage.mockRejectedValueOnce(
      new Error("transcript write failed"),
    );

    await expect(
      appendRelayVoiceTranscript({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        entryId: "relay-entry-1",
        role: "user",
        text: "persist me",
      }),
    ).rejects.toThrow("transcript write failed");
    const unresolved = clientVoiceSessionTesting.readRecord(
      "main",
      voiceSessionId,
    )?.transcriptFailureKeys;
    expect(unresolved).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);

    await closeRelayVoiceSessionRecord({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      status: "closed",
      transcriptFailureKeys: unresolved,
    });
  });

  it("bounds stalled transcript operations and closes after the accepted prefix", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      voiceSessionId: "voice-bounded",
    });
    const firstAppend = createDeferred();
    const actualAppend = sessionAccessorMocks.actualAppendTranscriptMessage;
    if (!actualAppend) {
      throw new Error("expected the real transcript append implementation");
    }
    sessionAccessorMocks.appendTranscriptMessage.mockImplementationOnce(async (...args) => {
      await firstAppend.promise;
      return await actualAppend(...args);
    });

    const appends = Array.from({ length: 10_000 }, (_, index) =>
      appendClientVoiceTranscript({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        entryId: String(index + 1),
        role: index % 2 === 0 ? "user" : "assistant",
        text: `  ${"x".repeat(9_000)}  `,
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
    await vi.waitFor(() =>
      expect(sessionAccessorMocks.appendTranscriptMessage).toHaveBeenCalledTimes(1),
    );
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("open");
    firstAppend.resolve();
    const results = await Promise.all(appends);

    const accepted = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);
    expect(accepted).toHaveLength(41);
    expect(rejected).toHaveLength(9_959);
    expect(
      results.every(
        (result) =>
          result.ok ||
          (result.error instanceof Error &&
            result.error.message === "voice transcript persistence queue capacity exceeded"),
      ),
    ).toBe(true);
    expect(sessionAccessorMocks.appendTranscriptMessage).toHaveBeenCalledTimes(41);
    expect(
      sessionAccessorMocks.appendTranscriptMessage.mock.calls.map(([, options]) => options.eventId),
    ).toEqual(Array.from({ length: 41 }, (_, index) => `voice:${voiceSessionId}:${index + 1}`));
    const firstMessage = sessionAccessorMocks.appendTranscriptMessage.mock.calls[0]?.[1]
      .message as { content?: Array<{ text?: string }> };
    expect(firstMessage.content?.[0]?.text).toHaveLength(8_000);
    await expect(
      appendClientVoiceTranscript({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        entryId: "after-overflow",
        role: "user",
        text: "must remain rejected after the accepted prefix drains",
      }),
    ).rejects.toThrow("voice transcript persistence queue capacity exceeded");

    const close = closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 42,
    });
    const duplicateClose = closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
      now: 99,
    });
    await Promise.all([close, duplicateClose]);
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)).toMatchObject({
      status: "closed",
      closedAt: 42,
    });
  });

  it("ignores whitespace transcripts without consuming queue capacity", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      voiceSessionId: "voice-whitespace",
    });

    await Promise.all(
      Array.from({ length: 10_000 }, (_, index) =>
        appendClientVoiceTranscript({
          agentId: "main",
          sessionKey: "agent:main:main",
          voiceSessionId,
          entryId: String(index + 1),
          role: "user",
          text: " \t\n ",
        }),
      ),
    );
    expect(sessionAccessorMocks.appendTranscriptMessage).not.toHaveBeenCalled();

    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      entryId: "real",
      role: "user",
      text: "persist me",
    });
    expect(sessionAccessorMocks.appendTranscriptMessage).toHaveBeenCalledOnce();
    expect(sessionAccessorMocks.appendTranscriptMessage.mock.calls[0]?.[1].eventId).toBe(
      `voice:${voiceSessionId}:real`,
    );
  });

  it("continues durable transcript operations after a persistence failure", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      voiceSessionId: "voice-write-failure",
    });
    sessionAccessorMocks.appendTranscriptMessage.mockRejectedValueOnce(
      new Error("transcript write failed"),
    );

    await expect(
      appendClientVoiceTranscript({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        entryId: "1",
        role: "user",
        text: "first",
      }),
    ).rejects.toThrow("transcript write failed");
    await expect(
      appendClientVoiceTranscript({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        entryId: "2",
        role: "assistant",
        text: "second",
      }),
    ).resolves.toBeUndefined();
    expect(
      sessionAccessorMocks.appendTranscriptMessage.mock.calls.map(([, options]) => options.eventId),
    ).toEqual([`voice:${voiceSessionId}:1`, `voice:${voiceSessionId}:2`]);
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toEqual([expect.any(String)]);
  });

  it("requires every failed transcript entry to recover before close", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      voiceSessionId: "voice-multiple-write-failures",
    });
    sessionAccessorMocks.appendTranscriptMessage
      .mockRejectedValueOnce(new Error("first transcript write failed"))
      .mockRejectedValueOnce(new Error("second transcript write failed"));

    for (const entryId of ["1", "2"]) {
      await expect(
        appendClientVoiceTranscript({
          agentId: "main",
          sessionKey: "agent:main:main",
          voiceSessionId,
          entryId,
          role: "user",
          text: entryId,
        }),
      ).rejects.toThrow("transcript write failed");
    }
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toHaveLength(2);

    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      entryId: "later",
      role: "assistant",
      text: "later entry",
    });
    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      entryId: "1",
      role: "user",
      text: "first",
    });
    await expect(
      closeClientVoiceSession({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        config: {},
      }),
    ).rejects.toThrow("voice transcript persistence must be retried before close");

    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      entryId: "2",
      role: "user",
      text: "second",
    });
    await closeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      config: {},
    });
    expect(clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.status).toBe("closed");
  });

  it("bounds unresolved transcript failure identity", async () => {
    await seedSession("agent:main:main");
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:main",
      origin: "client",
      voiceSessionId: "voice-write-failure-bound",
    });
    sessionAccessorMocks.appendTranscriptMessage.mockRejectedValue(
      new Error("transcript write failed"),
    );

    for (let index = 0; index < VOICE_TRANSCRIPT_MAX_UNRESOLVED; index += 1) {
      await expect(
        appendClientVoiceTranscript({
          agentId: "main",
          sessionKey: "agent:main:main",
          voiceSessionId,
          entryId: String(index),
          role: "user",
          text: "failed entry",
        }),
      ).rejects.toThrow("transcript write failed");
    }
    await expect(
      appendClientVoiceTranscript({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        entryId: "beyond-bound",
        role: "user",
        text: "must wait for recovery",
      }),
    ).rejects.toThrow("voice transcript persistence has too many unresolved entries");
    expect(sessionAccessorMocks.appendTranscriptMessage).toHaveBeenCalledTimes(
      VOICE_TRANSCRIPT_MAX_UNRESOLVED,
    );
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toHaveLength(VOICE_TRANSCRIPT_MAX_UNRESOLVED);

    const actualAppend = sessionAccessorMocks.actualAppendTranscriptMessage;
    if (!actualAppend) {
      throw new Error("expected the real transcript append implementation");
    }
    sessionAccessorMocks.appendTranscriptMessage.mockImplementation(actualAppend);
    await appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:main",
      voiceSessionId,
      entryId: "0",
      role: "user",
      text: "recovered entry",
    });
    sessionAccessorMocks.appendTranscriptMessage.mockRejectedValueOnce(
      new Error("replacement transcript write failed"),
    );
    await expect(
      appendClientVoiceTranscript({
        agentId: "main",
        sessionKey: "agent:main:main",
        voiceSessionId,
        entryId: "replacement",
        role: "user",
        text: "replacement entry",
      }),
    ).rejects.toThrow("replacement transcript write failed");
    expect(
      clientVoiceSessionTesting.readRecord("main", voiceSessionId)?.transcriptFailureKeys,
    ).toHaveLength(VOICE_TRANSCRIPT_MAX_UNRESOLVED);
  });

  it("keeps durable operation ownership independent between voice sessions", async () => {
    await seedSession("agent:main:first");
    await seedSession("agent:main:second");
    const firstVoiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:first",
      origin: "client",
      voiceSessionId: "voice-first",
    });
    const secondVoiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: "agent:main:second",
      origin: "client",
      voiceSessionId: "voice-second",
    });
    const firstAppend = createDeferred();
    const actualAppend = sessionAccessorMocks.actualAppendTranscriptMessage;
    if (!actualAppend) {
      throw new Error("expected the real transcript append implementation");
    }
    sessionAccessorMocks.appendTranscriptMessage.mockImplementationOnce(async (...args) => {
      await firstAppend.promise;
      return await actualAppend(...args);
    });

    const first = appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:first",
      voiceSessionId: firstVoiceSessionId,
      entryId: "1",
      role: "user",
      text: "first",
    });
    await vi.waitFor(() =>
      expect(sessionAccessorMocks.appendTranscriptMessage).toHaveBeenCalledTimes(1),
    );
    const second = appendClientVoiceTranscript({
      agentId: "main",
      sessionKey: "agent:main:second",
      voiceSessionId: secondVoiceSessionId,
      entryId: "1",
      role: "user",
      text: "second",
    });

    await second;
    expect(sessionAccessorMocks.appendTranscriptMessage).toHaveBeenCalledTimes(2);
    firstAppend.resolve();
    await first;
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
});
