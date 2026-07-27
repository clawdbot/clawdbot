import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  authorizeClientVoiceConfirmation,
  resolveClientVoiceToolConfirmationPolicy,
} from "../../talk/client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "../../talk/client-voice-confirmation.test-support.js";
import {
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { talkClientHandlers } from "./talk-client.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const sessionKey = "agent:main:main";
const sessionId = "voice-transcript-session";
let tempDir: string;

async function invokeTranscript(params: Record<string, unknown>) {
  const respond = vi.fn();
  await talkClientHandlers["talk.client.transcript"]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) },
  } as never);
  return respond;
}

async function invokeClose(params: Record<string, unknown>) {
  const respond = vi.fn();
  await talkClientHandlers["talk.client.close"]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) },
    client: { connId: "conn-close" },
  } as never);
  return respond;
}

describe("talk.client.transcript", () => {
  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-talk-transcript-")),
    );
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      { sessionId, updatedAt: Date.now() },
    );
  });

  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    resetClientVoiceConfirmationStateForTest();
    vi.useRealTimers();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("appends finalized messages once by event id", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    const params = {
      sessionKey,
      voiceSessionId,
      entryId: "1",
      role: "user",
      text: "hello from voice",
      timestamp: 123,
    };

    expect(await invokeTranscript(params)).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(await invokeTranscript(params)).toHaveBeenCalledWith(true, { ok: true }, undefined);
    const events = readSessionTranscriptMessageEvents({ agentId: "main", sessionId });
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      id: `voice:${voiceSessionId}:1`,
      message: {
        role: "user",
        content: [{ type: "text", text: "hello from voice" }],
        timestamp: 123,
        provenance: { kind: "realtime_voice", sourceChannel: "talk" },
      },
    });
  });

  it("appends before the session has ever received a chat turn", async () => {
    const talkFirstSessionKey = "agent:main:talk-first";
    await ensureClientVoiceAgentSessionEntry({
      agentId: "main",
      sessionKey: talkFirstSessionKey,
    });
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey: talkFirstSessionKey,
      provider: "google",
      origin: "client",
    });

    expect(
      await invokeTranscript({
        sessionKey: talkFirstSessionKey,
        voiceSessionId,
        entryId: "1",
        role: "user",
        text: "heard before the first consult",
      }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);

    const talkFirstEntry = loadSessionEntry({
      agentId: "main",
      sessionKey: talkFirstSessionKey,
    });
    expect(talkFirstEntry?.sessionId).toBeTruthy();
    expect(
      readSessionTranscriptMessageEvents({
        agentId: "main",
        sessionId: talkFirstEntry?.sessionId ?? "missing",
      }),
    ).toHaveLength(1);
  });

  it("uses server observation time for spoken-confirmation freshness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    await invokeTranscript({
      sessionKey,
      voiceSessionId,
      entryId: "early-yes",
      role: "user",
      text: "yes",
      timestamp: 10_000,
    });
    const policy = resolveClientVoiceToolConfirmationPolicy({
      agentId: "main",
      voiceSessionId,
      runId: "run-later",
      toolName: "message",
      toolParams: { action: "send", message: "later" },
      now: 200,
    });
    expect(policy.allowed).toBe(false);
    if (policy.allowed) {
      throw new Error("expected confirmation request");
    }
    const confirmationId = policy.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1];
    expect(confirmationId).toBeTruthy();

    expect(() =>
      authorizeClientVoiceConfirmation({
        agentId: "main",
        voiceSessionId,
        confirmationId: confirmationId ?? "missing",
        now: 201,
      }),
    ).toThrow("explicit spoken confirmation");
  });

  it("accepts an idempotent close retry after the first response is lost", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    const params = { sessionKey, voiceSessionId };

    expect(await invokeClose(params)).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(await invokeClose(params)).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("truncates UTF-16 safely and writes assistant metadata", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      provider: "google",
      origin: "client",
    });
    const respond = await invokeTranscript({
      sessionKey,
      voiceSessionId,
      entryId: "assistant-1",
      role: "assistant",
      text: `${"x".repeat(7_999)}😀tail`,
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    const event = readSessionTranscriptMessageEvents({ agentId: "main", sessionId })[0]?.event as
      | { message?: { content?: Array<{ text?: string }> } }
      | undefined;
    const text = event?.message?.content?.[0]?.text;
    expect(text).toBe("x".repeat(7_999));
    expect(event).toMatchObject({
      message: {
        api: "realtime",
        provider: "google",
        model: "realtime-voice",
        stopReason: "stop",
      },
    });
  });

  it("uses the neutral provider label for records created before provider tracking", async () => {
    const voiceSessionId = createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });

    expect(
      await invokeTranscript({
        sessionKey,
        voiceSessionId,
        entryId: "legacy-assistant",
        role: "assistant",
        text: "legacy provider reply",
      }),
    ).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(
      readSessionTranscriptMessageEvents({ agentId: "main", sessionId })[0]?.event,
    ).toMatchObject({
      message: { api: "realtime", provider: "realtime", model: "realtime-voice" },
    });
  });

  it.each([
    ["missing", "voice-missing", "voice session not found"],
    ["closed", "voice-closed", "voice session is closed"],
    ["relay", "voice-relay", "does not allow this transcript source"],
  ])("rejects %s voice records", async (kind, voiceSessionId, expected) => {
    if (kind !== "missing") {
      createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: kind === "relay" ? "relay" : "client",
        voiceSessionId,
      });
    }
    if (kind === "closed") {
      await closeClientVoiceSession({
        agentId: "main",
        sessionKey,
        voiceSessionId,
        config: {},
      });
    }

    const respond = await invokeTranscript({
      sessionKey,
      voiceSessionId,
      entryId: "1",
      role: "user",
      text: "hello",
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining(expected) }),
    );
  });
});
