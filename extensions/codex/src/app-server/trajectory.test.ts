// Codex tests cover SQLite-only trajectory plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEvents,
  type SqliteTrajectoryRuntimeEventForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CodexHostTrajectoryRecorder,
  createCodexTrajectoryRecorder,
  recordCodexTrajectoryCompletion,
  recordCodexTrajectoryContext,
} from "./trajectory.js";

type CodexTrajectoryRecorder = NonNullable<ReturnType<typeof createCodexTrajectoryRecorder>>;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-trajectory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function expectTrajectoryRecorder(
  recorder: ReturnType<typeof createCodexTrajectoryRecorder>,
): CodexTrajectoryRecorder {
  if (recorder === null) {
    throw new Error("Expected Codex trajectory recorder");
  }
  return recorder;
}

function createMemoryHostTrajectoryRecorder(): {
  events: Array<{ type: string; data?: Record<string, unknown> }>;
  recorder: CodexHostTrajectoryRecorder;
} {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  return {
    events,
    recorder: {
      recordEvent: (type, data) => events.push({ type, data }),
      recordToolResult: (data) => events.push({ type: "tool.result", data }),
      flush: async () => undefined,
    },
  };
}

function createMemoryBackedRecorder(params: {
  tmpDir: string;
  attempt?: Record<string, unknown>;
  tools?: Parameters<typeof createCodexTrajectoryRecorder>[0]["tools"];
}): {
  events: Array<{ type: string; data?: Record<string, unknown> }>;
  recorder: CodexTrajectoryRecorder;
} {
  const sessionId = (params.attempt?.sessionId as string | undefined) ?? "session-1";
  const host = createMemoryHostTrajectoryRecorder();
  const recorder = createCodexTrajectoryRecorder({
    cwd: params.tmpDir,
    attempt: {
      sessionFile: path.join(params.tmpDir, "session.jsonl"),
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      runId: "run-1",
      provider: "codex",
      modelId: "gpt-5.4",
      model: { api: "responses" },
      ...params.attempt,
    } as never,
    trajectoryRecorder: host.recorder,
    tools: params.tools,
    env: {},
  });
  return { events: host.events, recorder: expectTrajectoryRecorder(recorder) };
}

function createSqliteHostTrajectoryRecorder(params: {
  agentId: string;
  sessionId: string;
  storePath: string;
}): CodexHostTrajectoryRecorder {
  const events: SqliteTrajectoryRuntimeEventForTest[] = [];
  let seq = 0;
  return {
    recordEvent: (type, data) => {
      events.push({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: `${params.sessionId}:test`,
        source: "runtime",
        type,
        ts: new Date(0).toISOString(),
        seq,
        sessionId: params.sessionId,
        ...(data === undefined ? {} : { data }),
      });
      seq += 1;
    },
    recordToolResult: (data) => {
      events.push({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: `${params.sessionId}:test`,
        source: "runtime",
        type: "tool.result",
        ts: new Date(0).toISOString(),
        seq,
        sessionId: params.sessionId,
        data,
      });
      seq += 1;
    },
    flush: async () => {
      appendSqliteTrajectoryRuntimeEvents(params, events);
      events.length = 0;
    },
  };
}

describe("Codex trajectory recorder", () => {
  it("warns when the SQLite host recorder is unavailable", () => {
    const warn = vi.fn();
    const recorder = createCodexTrajectoryRecorder({
      cwd: makeTempDir(),
      attempt: {
        sessionFile: "agent:main:session-1",
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: {},
      warn,
    });

    expect(recorder).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "codex trajectory capture requires the SQLite host recorder",
      { sessionId: "session-1", reason: "sqlite-recorder-unavailable" },
    );
  });

  it("stores SQLite-backed captures for the canonical session-key target", async () => {
    // Regression: the host stopped emitting legacy `sqlite:` session-file
    // markers, so any marker re-derivation here drops every Codex capture.
    const tmpDir = makeTempDir();
    const storePath = path.join(tmpDir, "sessions", "sessions.json");
    await upsertSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      storePath,
      entry: { sessionId: "session-1", updatedAt: 10 },
    });
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: "agent:main:session-1",
        sessionKey: "agent:main:session-1",
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      trajectoryRecorder: createSqliteHostTrajectoryRecorder({
        agentId: "main",
        sessionId: "session-1",
        storePath,
      }),
      env: {},
    });

    const trajectoryRecorder = expectTrajectoryRecorder(recorder);
    trajectoryRecorder.recordEvent("session.started");
    await trajectoryRecorder.flush();

    expect(fs.readdirSync(path.join(tmpDir, "sessions"))).not.toEqual(
      expect.arrayContaining(["session.trajectory.jsonl", "session.trajectory-path.json"]),
    );
    await expect(
      loadSqliteTrajectoryRuntimeEvents({ agentId: "main", sessionId: "session-1", storePath }),
    ).resolves.toEqual([expect.objectContaining({ type: "session.started" })]);
  });

  it.each(["dynamic", "mcp"])(
    "forwards %s tool arguments unchanged to the host recorder",
    async (toolKind) => {
      const { events, recorder } = createMemoryBackedRecorder({ tmpDir: makeTempDir() });
      const text = `${"x".repeat(19_999)}😀`;
      recorder.recordEvent("tool.call", {
        toolKind,
        text,
        apiKey: "secret",
        authorization: "Bearer sk-test-secret-token",
        arguments: {
          sessionKey: "agent:receiver:main",
          sourceSessionKey: "agent:sender:main",
        },
      });
      await recorder.flush();

      expect(events[0]).toEqual({
        type: "tool.call",
        data: {
          toolKind,
          text,
          apiKey: "secret",
          authorization: "Bearer sk-test-secret-token",
          arguments: {
            sessionKey: "agent:receiver:main",
            sourceSessionKey: "agent:sender:main",
          },
        },
      });
    },
  );

  it("records namespace dynamic tools as callable trajectory definitions", async () => {
    const tools = [
      {
        type: "namespace" as const,
        name: "openclaw",
        description: "",
        tools: [
          {
            type: "function" as const,
            name: "web_search",
            description: "Search the web.",
            inputSchema: { type: "object" },
            deferLoading: true,
          },
        ],
      },
    ];
    const tmpDir = makeTempDir();
    const init = createMemoryBackedRecorder({ tmpDir, tools });

    recordCodexTrajectoryContext(init.recorder, { attempt: {} as never, cwd: tmpDir, tools });
    await init.recorder.flush();

    expect(init.events[0]?.data?.tools).toEqual([
      {
        name: "web_search",
        description: "Search the web.",
        parameters: { type: "object" },
      },
    ]);
  });

  it("honors explicit disablement without warning", () => {
    const warn = vi.fn();
    const recorder = createCodexTrajectoryRecorder({
      cwd: makeTempDir(),
      attempt: {
        sessionFile: "agent:main:session-1",
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: { OPENCLAW_TRAJECTORY: "0" },
      warn,
    });

    expect(recorder).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("delegates oversized model completion events to the host recorder", async () => {
    const attempt = {
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      provider: "codex",
      modelId: "gpt-5.4",
      model: { api: "responses" },
    } as never;
    const usage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    const { events, recorder } = createMemoryBackedRecorder({
      tmpDir: makeTempDir(),
      attempt,
    });

    recordCodexTrajectoryCompletion(recorder, {
      attempt,
      threadId: "thread-1",
      turnId: "turn-1",
      timedOut: false,
      result: {
        terminal: { kind: "ok" },
        attemptUsage: usage,
        assistantTexts: ["done"],
        messagesSnapshot: Array.from({ length: 20 }, (_value, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `message-${index} ${"x".repeat(32_000)}`,
        })),
      } as never,
    });
    await recorder.flush();

    expect(events[0]?.data).toMatchObject({
      usage,
      assistantTexts: ["done"],
    });
    expect(events[0]?.data?.messagesSnapshot).toHaveLength(20);
    expect(events[0]?.data?.truncated).toBeUndefined();
  });

  it("delegates oversized tool results to the host tool-result path", () => {
    const recorded: Array<Record<string, unknown>> = [];
    const recorder = expectTrajectoryRecorder(
      createCodexTrajectoryRecorder({
        cwd: makeTempDir(),
        attempt: {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId: "run-1",
          provider: "codex",
          modelId: "gpt-5.4",
          model: { api: "responses" },
        } as never,
        trajectoryRecorder: {
          recordEvent: vi.fn(),
          recordToolResult: (data) => recorded.push(data),
          flush: async () => undefined,
        },
        env: {},
      }),
    );

    const data = {
      name: "sessions_send",
      toolCallId: "call-oversized",
      isError: true,
      success: false,
      contentItems: Array.from({ length: 64 }, () => ({
        type: "inputText",
        text: "x".repeat(8_000),
      })),
    };
    recorder.recordToolResult(data);

    expect(recorded).toEqual([data]);
  });

  it("projects trusted prompt origin without applying host bounds", async () => {
    const { events, recorder } = createMemoryBackedRecorder({ tmpDir: makeTempDir() });
    const oversized = "界".repeat(30_000);
    const origin = {
      kind: "inter_session" as const,
      sourceSessionKey: "agent:sender:main",
      originSessionId: oversized,
      sourceChannel: oversized,
      sourceTool: oversized,
    };

    recorder.recordPromptSubmitted(
      {
        threadId: oversized,
        turnId: oversized,
        prompt: oversized,
        imagesCount: 0,
      },
      origin,
    );
    await recorder.flush();

    expect(events[0]?.data).toEqual({
      threadId: oversized,
      turnId: oversized,
      prompt: oversized,
      imagesCount: 0,
      origin: {
        kind: "inter_session",
        sourceSessionKey: "agent:sender:main",
        originSessionId: oversized,
        sourceChannel: oversized,
        sourceTool: oversized,
      },
    });
  });

  it("validates prompt provenance and projects only canonical fields", async () => {
    const { events, recorder } = createMemoryBackedRecorder({ tmpDir: makeTempDir() });

    recorder.recordPromptSubmitted(
      { threadId: "thread-1", turnId: "turn-1", prompt: "hello", imagesCount: 0 },
      {
        kind: "forged",
        sourceSessionKey: "agent:sender:main",
      } as never,
    );
    recorder.recordPromptSubmitted(
      { threadId: "thread-1", turnId: "turn-2", prompt: "hello again", imagesCount: 0 },
      {
        kind: "inter_session",
        sourceSessionKey: "agent:sender:main",
        sourceTool: "sessions_send",
        sourceSessionHash: `sha256:v1:${"f".repeat(64)}`,
        originSessionHash: `sha256:v1:${"e".repeat(64)}`,
        nested: { sourceSessionKey: "nested-secret" },
        apiKey: "must-not-leak",
      } as never,
    );
    await recorder.flush();

    expect(events[0]?.data).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      prompt: "hello",
      imagesCount: 0,
    });
    expect(events[1]?.data).toEqual({
      threadId: "thread-1",
      turnId: "turn-2",
      prompt: "hello again",
      imagesCount: 0,
      origin: {
        kind: "inter_session",
        sourceSessionKey: "agent:sender:main",
        sourceTool: "sessions_send",
      },
    });
  });
});
