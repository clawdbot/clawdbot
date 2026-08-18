// Codex tests cover SQLite-only trajectory plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSqliteTrajectoryRuntimeEvents,
  createTrajectoryRuntimeRecorderForTest,
  exportTrajectoryBundleForTest,
  loadSqliteTrajectoryRuntimeEvents,
  type SqliteTrajectoryRuntimeEventForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCodexTrajectoryRecorder,
  recordCodexTrajectoryCompletion,
  recordCodexTrajectoryContext,
} from "./trajectory.js";

type CodexTrajectoryRecorder = NonNullable<ReturnType<typeof createCodexTrajectoryRecorder>>;
type CodexTrajectoryFacade = NonNullable<
  Parameters<typeof createCodexTrajectoryRecorder>[0]["trajectory"]
>;

let testWorkspace: TempWorkspaceSync;

beforeEach(() => {
  testWorkspace = tempWorkspaceSync({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-codex-trajectory-",
  });
});

afterEach(() => {
  testWorkspace.cleanup();
});

function expectTrajectoryRecorder(
  recorder: ReturnType<typeof createCodexTrajectoryRecorder>,
): CodexTrajectoryRecorder {
  if (recorder === null) {
    throw new Error("Expected Codex trajectory recorder");
  }
  return recorder;
}

function createMemoryTrajectoryFacade(): {
  events: Array<{ type: string; data?: Record<string, unknown> }>;
  trajectory: CodexTrajectoryFacade;
} {
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  return {
    events,
    trajectory: {
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
  const host = createMemoryTrajectoryFacade();
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
    trajectory: host.trajectory,
    tools: params.tools,
  });
  return { events: host.events, recorder: expectTrajectoryRecorder(recorder) };
}

function createSqliteTrajectoryFacade(params: {
  agentId: string;
  sessionId: string;
  storePath: string;
}): CodexTrajectoryFacade {
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
  it("returns null when the host trajectory facade is unavailable", () => {
    expect(
      createCodexTrajectoryRecorder({
        cwd: testWorkspace.dir,
        attempt: {
          sessionFile: "agent:main:session-1",
          sessionId: "session-1",
          model: { api: "responses" },
        } as never,
      }),
    ).toBeNull();
  });

  it("stores SQLite-backed captures for the canonical session-key target", async () => {
    // Regression: the host stopped emitting legacy `sqlite:` session-file
    // markers, so any marker re-derivation here drops every Codex capture.
    const tmpDir = testWorkspace.dir;
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
      trajectory: createSqliteTrajectoryFacade({
        agentId: "main",
        sessionId: "session-1",
        storePath,
      }),
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
    const tmpDir = testWorkspace.dir;
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

  it("lets the host bound oversized Codex events without losing terminal facts", async () => {
    const tmpDir = testWorkspace.dir;
    const storePath = path.join(tmpDir, "sessions", "sessions.json");
    const sessionTarget = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath,
    };
    await upsertSessionEntry({
      agentId: sessionTarget.agentId,
      sessionKey: sessionTarget.sessionKey,
      storePath,
      entry: { sessionId: sessionTarget.sessionId, updatedAt: 10 },
    });
    const attempt = {
      agentId: "main",
      cwd: tmpDir,
      workspaceDir: tmpDir,
      sessionFile: sessionTarget.sessionKey,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      provider: "codex",
      modelId: "gpt-5.4",
      model: { api: "responses" },
    };
    const usage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    const hostRecorder = createTrajectoryRuntimeRecorderForTest({
      sessionId: sessionTarget.sessionId,
      sessionKey: sessionTarget.sessionKey,
      sessionTarget,
      runId: attempt.runId,
      provider: "openai",
      modelId: attempt.modelId,
      modelApi: "responses",
      workspaceDir: tmpDir,
    });
    if (!hostRecorder) {
      throw new Error("Expected host trajectory recorder");
    }
    const host = await createAgentHarnessHostCapabilitiesForTest({
      attempt: { ...attempt, trajectoryRecorder: hostRecorder } as never,
      pluginId: "codex",
    });
    const recorder = createCodexTrajectoryRecorder({
      attempt: attempt as never,
      cwd: tmpDir,
      trajectory: host.capabilities.trajectory,
    } as never);
    const trajectoryRecorder = expectTrajectoryRecorder(recorder);

    try {
      recordCodexTrajectoryContext(trajectoryRecorder, {
        attempt: attempt as never,
        cwd: tmpDir,
        developerInstructions: `Bearer ${"s".repeat(40)} ${"x".repeat(40_000)}`,
        prompt: "inspect",
        tools: [
          {
            type: "function",
            name: "huge_tool",
            description: "x".repeat(40_000),
            inputSchema: { type: "object" },
          },
        ],
      } as never);
      trajectoryRecorder.recordEvent("tool.result", {
        toolCallId: "call-1",
        toolName: "huge_tool",
        status: "completed",
        authorization: `Bearer ${"t".repeat(40)}`,
        output: `token=${"t".repeat(40)} ${"x".repeat(40_000)}`,
      });
      recordCodexTrajectoryCompletion(trajectoryRecorder, {
        attempt: attempt as never,
        threadId: "thread-1",
        turnId: "turn-1",
        timedOut: true,
        yieldDetected: true,
        result: {
          terminal: {
            kind: "timeout",
            phase: "prompt",
            source: "runtime",
            aborted: true,
            failure: { source: "prompt", error: "terminal prompt error" },
          },
          attemptUsage: usage,
          assistantTexts: ["done"],
          // Twelve entries stay below the old plugin's post-sanitization cap,
          // but exceed the host cap when forwarded without pre-shrinking.
          messagesSnapshot: Array.from({ length: 12 }, (_value, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: `message-${index} ${"x".repeat(32_000)}`,
          })),
        } as never,
      });
      await trajectoryRecorder.flush();
    } finally {
      host.close();
    }

    const events = await loadSqliteTrajectoryRuntimeEvents({
      agentId: sessionTarget.agentId,
      sessionId: sessionTarget.sessionId,
      storePath,
    });
    const context = events.find((event) => event.type === "context.compiled");
    const tool = events.find((event) => event.type === "tool.result");
    const completion = events.find((event) => event.type === "model.completed");
    expect(context?.data).toMatchObject({
      prompt: "inspect",
      systemPrompt: {
        truncated: true,
        reason: "trajectory-field-size-limit",
      },
      tools: [
        {
          name: "huge_tool",
          description: {
            truncated: true,
            reason: "trajectory-field-size-limit",
          },
          parameters: { type: "object" },
        },
      ],
    });
    expect(JSON.stringify(context)).not.toContain("s".repeat(40));
    expect(tool?.data).toMatchObject({
      toolCallId: "call-1",
      toolName: "huge_tool",
      status: "completed",
      output: {
        truncated: true,
        reason: "trajectory-field-size-limit",
      },
    });
    expect(tool?.data?.authorization).toBeUndefined();
    expect(JSON.stringify(tool)).not.toContain(`token=${"t".repeat(40)}`);
    expect(completion?.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      threadId: "thread-1",
      turnId: "turn-1",
      timedOut: true,
      yieldDetected: true,
      aborted: true,
      promptError: "terminal prompt error",
      usage,
      assistantTexts: ["done"],
    });
    expect(completion?.data?.messagesSnapshot).toBeUndefined();
    expect(completion?.data?.droppedFields).toEqual(["messagesSnapshot"]);

    const bundle = await exportTrajectoryBundleForTest({
      outputDir: path.join(tmpDir, "bundle"),
      sessionTarget,
      sessionId: sessionTarget.sessionId,
      sessionKey: sessionTarget.sessionKey,
      workspaceDir: tmpDir,
    });
    const exportedCompletion = bundle.events.find((event) => event.type === "model.completed");
    expect(exportedCompletion?.data).toEqual(completion?.data);
  });
});
