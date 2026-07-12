// Qa Lab tests cover suite runtime agent session plugin behavior.
import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  readEffectiveTools,
  readRawQaSessionStore,
  readSessionTranscriptSummary,
  readSkillStatus,
  setSessionStoreLockRetryDelaysMsForTests,
} from "./suite-runtime-agent-session.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();

afterEach(async () => {
  setSessionStoreLockRetryDelaysMsForTests();
  vi.useRealTimers();
  await cleanup();
});

describe("qa suite runtime agent session helpers", () => {
  const gatewayCall = vi.fn();
  const env = {
    gateway: { call: gatewayCall },
    primaryModel: "openai/gpt-5.6-luna",
    alternateModel: "openai/gpt-5.6-luna-mini",
    providerMode: "mock-openai",
  } as never;

  beforeEach(() => {
    setSessionStoreLockRetryDelaysMsForTests([1, 1, 1]);
    gatewayCall.mockReset();
  });

  function qaSessionEnv(tempRoot: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
    };
  }

  async function seedQaSession(params: {
    entry?: Record<string, unknown>;
    sessionId: string;
    sessionKey: string;
    tempRoot: string;
  }) {
    await upsertSessionEntry({
      agentId: "qa",
      env: qaSessionEnv(params.tempRoot),
      sessionKey: params.sessionKey,
      entry: {
        sessionId: params.sessionId,
        updatedAt: 10,
        ...params.entry,
      },
    });
  }

  async function appendQaTranscriptMessage(params: {
    message: unknown;
    sessionId: string;
    sessionKey: string;
    tempRoot: string;
  }) {
    await appendSessionTranscriptMessageByIdentity({
      agentId: "qa",
      env: qaSessionEnv(params.tempRoot),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      message: params.message,
    });
  }

  function requireGatewayCall() {
    const [call] = gatewayCall.mock.calls;
    if (!call) {
      throw new Error("expected gateway call");
    }
    return call;
  }

  it("creates sessions and trims the returned key", async () => {
    gatewayCall.mockResolvedValueOnce({ key: "  session-1  " });

    await expect(createSession(env, "Test Session")).resolves.toBe("session-1");
    const [method, params, options] = requireGatewayCall();
    expect(method).toBe("sessions.create");
    expect(params).toEqual({ label: "Test Session" });
    expect(options?.timeoutMs).toBe(60_000);
  });

  it("retries transient session store lock timeouts while creating sessions", async () => {
    const lockTimeoutError = Object.assign(
      new Error("SessionWriteLockTimeoutError: session file locked"),
      { code: "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT" },
    );
    gatewayCall
      .mockRejectedValueOnce(lockTimeoutError)
      .mockResolvedValueOnce({ key: " session-2 " });

    vi.useFakeTimers();
    const pending = createSession(env, "Retry Session", "agent:qa:retry");

    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe("session-2");
    expect(gatewayCall).toHaveBeenCalledTimes(2);
    expect(gatewayCall).toHaveBeenNthCalledWith(
      2,
      "sessions.create",
      { label: "Retry Session", key: "agent:qa:retry" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("retries transient session store stale locks while creating sessions", async () => {
    const lockStaleError = Object.assign(
      new Error("SessionWriteLockStaleError: session file lock stale"),
      { code: "OPENCLAW_SESSION_WRITE_LOCK_STALE" },
    );
    gatewayCall.mockRejectedValueOnce(lockStaleError).mockResolvedValueOnce({ key: " session-3 " });

    vi.useFakeTimers();
    const pending = createSession(env, "Retry Stale Session", "agent:qa:stale-retry");

    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toBe("session-3");
    expect(gatewayCall).toHaveBeenCalledTimes(2);
    expect(gatewayCall).toHaveBeenNthCalledWith(
      2,
      "sessions.create",
      { label: "Retry Stale Session", key: "agent:qa:stale-retry" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("reads effective tool ids once and drops blanks", async () => {
    gatewayCall.mockResolvedValueOnce({
      groups: [
        { tools: [{ id: "alpha" }, { id: " beta " }] },
        { tools: [{ id: "alpha" }, { id: "" }, {}] },
      ],
    });

    await expect(readEffectiveTools(env, "session-1")).resolves.toEqual(new Set(["alpha", "beta"]));
  });

  it("reads skill status for the default qa agent", async () => {
    gatewayCall.mockResolvedValueOnce({
      skills: [{ name: "alpha", eligible: true }],
    });

    await expect(readSkillStatus(env)).resolves.toEqual([{ name: "alpha", eligible: true }]);
    const [method, params, options] = requireGatewayCall();
    expect(method).toBe("skills.status");
    expect(params).toEqual({ agentId: "qa" });
    expect(options?.timeoutMs).toBe(45_000);
  });

  it("reads the raw qa session store from SQLite", async () => {
    const tempRoot = await makeTempDir("qa-session-store-");
    await seedQaSession({
      tempRoot,
      sessionKey: "session-1",
      sessionId: "session-1",
      entry: { status: "running" },
    });

    await expect(
      readRawQaSessionStore({
        gateway: { tempRoot },
      } as never),
    ).resolves.toEqual({
      "session-1": { sessionId: "session-1", status: "running", updatedAt: 10 },
    });
  });

  it("summarizes a QA session transcript by session key", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-");
    const sessionKey = "agent:qa:webchat";
    await seedQaSession({ tempRoot, sessionKey, sessionId: "session-1" });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId: "session-1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "message",
            input: { action: "send", text: "hello" },
          },
        ],
        stopReason: "toolUse",
      },
    });

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        sessionKey,
      ),
    ).resolves.toEqual({
      finalText: "",
      hasDirectReplySelfMessage: false,
      lastAssistantContentTypes: ["tool_use"],
      lastAssistantStopReason: "toolUse",
      lastAssistantToolNames: ["message"],
      lastMessageRole: "assistant",
    });

    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId: "session-1",
      message: { role: "assistant", content: "Sent." },
    });

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        "agent:qa:webchat",
      ),
    ).resolves.toEqual({
      finalText: "Sent.",
      hasDirectReplySelfMessage: true,
      lastMessageRole: "assistant",
    });
  });

  it("summarizes QA transcript events after non-assistant rows", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-events-");
    const sessionKey = "agent:qa:stream";
    await seedQaSession({ tempRoot, sessionKey, sessionId: "session-stream" });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId: "session-stream",
      message: { role: "user", content: "x".repeat(70 * 1024) },
    });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId: "session-stream",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "message",
            input: { action: "send", text: "hello" },
          },
        ],
      },
    });
    await appendQaTranscriptMessage({
      tempRoot,
      sessionKey,
      sessionId: "session-stream",
      message: {
        role: "assistant",
        content: "Sent.",
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      },
    });

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        "agent:qa:stream",
      ),
    ).resolves.toEqual({
      finalText: "Sent.",
      hasDirectReplySelfMessage: true,
      lastAssistantErrorMessage: "Request was aborted",
      lastAssistantStopReason: "aborted",
      lastMessageRole: "assistant",
    });
  });

  it("fails closed when a requested QA session transcript is empty", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-empty-");
    await seedQaSession({
      tempRoot,
      sessionKey: "agent:qa:empty",
      sessionId: "session-empty",
    });

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        "agent:qa:empty",
      ),
    ).rejects.toThrow("session transcript is empty");
  });

  it("fails closed when a requested QA session transcript entry is missing", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-missing-");

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        "agent:qa:missing",
      ),
    ).rejects.toThrow("session transcript entry not found");
  });

  it("returns an empty session store when the file does not exist", async () => {
    const tempRoot = await makeTempDir("qa-session-store-missing-");

    await expect(
      readRawQaSessionStore({
        gateway: { tempRoot },
      } as never),
    ).resolves.toStrictEqual({});
  });
});
