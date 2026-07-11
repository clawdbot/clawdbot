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
    trajectorySessionFile: `sqlite:main:${sessionId}:${path.join(params.tmpDir, "sessions.json")}`,
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
    flush: async () => {
      appendSqliteTrajectoryRuntimeEvents(params, events);
      events.length = 0;
    },
  };
}

describe("Codex trajectory recorder", () => {
  it("rejects file-backed trajectory targets without creating sidecars", () => {
    const tmpDir = makeTempDir();
    const warn = vi.fn();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: {},
      warn,
    });

    expect(recorder).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "codex trajectory capture requires a matching SQLite session target",
      { sessionId: "session-1", reason: "non-sqlite-session-target" },
    );
    expect(fs.existsSync(path.join(tmpDir, "session.trajectory.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "session.trajectory-path.json"))).toBe(false);
  });

  it("rejects a SQLite marker for a different session identity", () => {
    const tmpDir = makeTempDir();
    const warn = vi.fn();
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: "sqlite:main:other:/tmp/openclaw-agent.sqlite",
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      trajectoryRecorder: createMemoryHostTrajectoryRecorder().recorder,
      env: {},
      warn,
    });

    expect(recorder).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "codex trajectory capture requires a matching SQLite session target",
      { sessionId: "session-1", reason: "session-id-mismatch" },
    );
  });

  it("warns when the SQLite host recorder is unavailable", () => {
    const warn = vi.fn();
    const recorder = createCodexTrajectoryRecorder({
      cwd: makeTempDir(),
      attempt: {
        sessionFile: "sqlite:main:session-1:/tmp/openclaw-agent.sqlite",
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

  it("stores SQLite-backed trajectory captures in the session database", async () => {
    const tmpDir = makeTempDir();
    const storePath = path.join(tmpDir, "sessions", "sessions.json");
    const trajectorySessionFile = `sqlite:main:session-1:${storePath}`;
    await upsertSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      storePath,
      entry: { sessionId: "session-1", sessionFile: trajectorySessionFile, updatedAt: 10 },
    });
    const recorder = createCodexTrajectoryRecorder({
      cwd: tmpDir,
      attempt: {
        sessionFile: path.join(tmpDir, "sessions", "session.jsonl"),
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      trajectoryRecorder: createSqliteHostTrajectoryRecorder({
        agentId: "main",
        sessionId: "session-1",
        storePath,
      }),
      trajectorySessionFile,
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

  it("redacts secrets and keeps recorded strings UTF-16 safe", async () => {
    const { events, recorder } = createMemoryBackedRecorder({ tmpDir: makeTempDir() });
    recorder.recordEvent("model.output", {
      text: `${"x".repeat(19_999)}😀`,
      apiKey: "secret",
      authorization: "Bearer sk-test-secret-token",
    });
    await recorder.flush();

    expect(events[0]?.data?.text).toBe(`${"x".repeat(19_999)}…`);
    expect(events[0]?.data?.apiKey).toBe("<redacted>");
    expect(events[0]?.data?.authorization).toBe("<redacted>");
  });

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
        sessionFile: "sqlite:main:session-1:/tmp/openclaw-agent.sqlite",
        sessionId: "session-1",
        model: { api: "responses" },
      } as never,
      env: { OPENCLAW_TRAJECTORY: "0" },
      warn,
    });

    expect(recorder).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves usage when truncating oversized model completion events", async () => {
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
        aborted: false,
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
      truncated: true,
      reason: "trajectory-event-size-limit",
      usage,
    });
    expect(events[0]?.data?.messagesSnapshot).toBeUndefined();
    expect(events[0]?.data?.droppedFields).toContain("messagesSnapshot");
  });
});
