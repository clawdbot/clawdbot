// Qa Lab tests cover suite runtime agent session plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { saveSessionStore } from "openclaw/plugin-sdk/session-store-runtime";
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
    primaryModel: "openai/gpt-5.5",
    alternateModel: "openai/gpt-5.5-mini",
    providerMode: "mock-openai",
  } as never;

  beforeEach(() => {
    setSessionStoreLockRetryDelaysMsForTests([1, 1, 1]);
    gatewayCall.mockReset();
  });

  function requireGatewayCall() {
    const [call] = gatewayCall.mock.calls;
    if (!call) {
      throw new Error("expected gateway call");
    }
    return call;
  }

  async function writeQaSessionStore(
    storeDir: string,
    store: Record<string, Record<string, unknown>>,
  ) {
    await fs.mkdir(storeDir, { recursive: true });
    const now = Date.now();
    await saveSessionStore(
      path.join(storeDir, "sessions.json"),
      Object.fromEntries(
        Object.entries(store).map(([key, entry]) => [
          key,
          {
            updatedAt: now,
            ...entry,
          },
        ]),
      ) as never,
      { skipMaintenance: true },
    );
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

  it("reads the raw qa session store from disk", async () => {
    const tempRoot = await makeTempDir("qa-session-store-");
    const storeDir = path.join(tempRoot, "state", "agents", "qa", "sessions");
    await writeQaSessionStore(storeDir, {
      "session-1": { sessionId: "session-1", status: "ready" },
    });

    await expect(
      readRawQaSessionStore({
        gateway: { tempRoot },
      } as never),
    ).resolves.toEqual({
      "session-1": { sessionId: "session-1", status: "ready", updatedAt: expect.any(Number) },
    });
  });

  it("summarizes a QA session transcript by session key", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-");
    const storeDir = path.join(tempRoot, "state", "agents", "qa", "sessions");
    await writeQaSessionStore(storeDir, {
      "agent:qa:webchat": { sessionId: "session-1", sessionFile: "session-1.jsonl" },
    });
    await fs.writeFile(
      path.join(storeDir, "session-1.jsonl"),
      [
        JSON.stringify({
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
        }),
        JSON.stringify({ message: { role: "assistant", content: "Sent." } }),
      ].join("\n"),
      "utf8",
    );

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
    });
  });

  it("streams QA session transcript summaries across read chunk boundaries", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-stream-");
    const storeDir = path.join(tempRoot, "state", "agents", "qa", "sessions");
    await writeQaSessionStore(storeDir, {
      "agent:qa:stream": { sessionId: "session-stream", sessionFile: "stream.jsonl" },
    });
    await fs.writeFile(
      path.join(storeDir, "stream.jsonl"),
      [
        JSON.stringify({ message: { role: "user", content: "x".repeat(70 * 1024) } }),
        JSON.stringify({
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
        }),
        "{ malformed json",
        JSON.stringify({ message: { role: "assistant", content: "Sent." } }),
      ].join("\n"),
      "utf8",
    );

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
    });
  });

  it("fails closed when a QA session transcript line is oversized", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-long-line-");
    const storeDir = path.join(tempRoot, "state", "agents", "qa", "sessions");
    await writeQaSessionStore(storeDir, {
      "agent:qa:long-line": { sessionId: "session-long-line", sessionFile: "long-line.jsonl" },
    });
    await fs.writeFile(path.join(storeDir, "long-line.jsonl"), "x".repeat(1024 * 1024 + 1), "utf8");

    await expect(
      readSessionTranscriptSummary(
        {
          gateway: { tempRoot },
        } as never,
        "agent:qa:long-line",
      ),
    ).rejects.toThrow("session transcript line exceeded 1048576 bytes");
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
