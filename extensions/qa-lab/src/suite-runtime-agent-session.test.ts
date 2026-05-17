import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  readEffectiveTools,
  readRawQaSessionStore,
  readSessionTranscriptSummary,
  readSkillStatus,
} from "./suite-runtime-agent-session.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { cleanup, makeTempDir } = createTempDirHarness();

afterEach(async () => {
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
    gatewayCall.mockReset();
  });

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

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe("session-2");
    expect(gatewayCall).toHaveBeenCalledTimes(2);
    expect(gatewayCall).toHaveBeenNthCalledWith(
      2,
      "sessions.create",
      { label: "Retry Session", key: "agent:qa:retry" },
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
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(
      path.join(storeDir, "sessions.json"),
      JSON.stringify({ "session-1": { sessionId: "session-1", status: "ready" } }),
      "utf8",
    );

    await expect(
      readRawQaSessionStore({
        gateway: { tempRoot },
      } as never),
    ).resolves.toEqual({
      "session-1": { sessionId: "session-1", status: "ready" },
    });
  });

  it("summarizes a QA session transcript by session key", async () => {
    const tempRoot = await makeTempDir("qa-session-transcript-");
    const storeDir = path.join(tempRoot, "state", "agents", "qa", "sessions");
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(
      path.join(storeDir, "sessions.json"),
      JSON.stringify({
        "agent:qa:webchat": { sessionId: "session-1", sessionFile: "session-1.jsonl" },
      }),
      "utf8",
    );
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
