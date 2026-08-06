// Trajectory runtime tests cover event recording and runtime file handling.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { TRAJECTORY_RUNTIME_EVENT_MAX_BYTES } from "./paths.js";
import { loadSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder, toTrajectoryToolDefinitions } from "./runtime.js";

type TrajectoryRuntimeRecorder = NonNullable<ReturnType<typeof createTrajectoryRuntimeRecorder>>;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-runtime-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function expectTrajectoryRuntimeRecorder(
  recorder: ReturnType<typeof createTrajectoryRuntimeRecorder>,
): TrajectoryRuntimeRecorder {
  if (recorder === null) {
    throw new Error("Expected trajectory runtime recorder");
  }
  expect(typeof recorder.recordEvent).toBe("function");
  return recorder;
}

describe("trajectory runtime", () => {
  it("records sanitized runtime events by default", () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      workspaceDir: "/tmp/workspace",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      systemPrompt: "system prompt",
      headers: [{ name: "Authorization", value: "Bearer sk-test-secret-token" }],
      command: "curl -H 'Authorization: Bearer sk-other-secret-token'",
      oauth: "ya29.fake-access-token-with-enough-length",
      apple: "abcd-efgh-ijkl-mnop",
      tools: toTrajectoryToolDefinitions([
        { name: "z-tool", parameters: { z: 1 } },
        { name: "a-tool", description: "alpha", parameters: { a: 1 } },
        { name: " ", description: "ignored" },
      ]),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.type).toBe("context.compiled");
    expect(parsed.source).toBe("runtime");
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.data.tools).toEqual([
      { name: "a-tool", description: "alpha", parameters: { a: 1 } },
      { name: "z-tool", parameters: { z: 1 } },
    ]);
    expect(JSON.stringify(parsed.data)).not.toContain("sk-test-secret-token");
    expect(JSON.stringify(parsed.data)).not.toContain("sk-other-secret-token");
    expect(JSON.stringify(parsed.data)).not.toContain("ya29.fake-access-token");
    expect(JSON.stringify(parsed.data)).not.toContain("abcd-efgh-ijkl-mnop");
  });

  it("records SQLite marker runtime events without active JSONL sidecars", async () => {
    const tempDir = makeTempDir();
    const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId: "session-1", updatedAt: 10 });
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionKey,
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "session-1",
        storePath,
      }),
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      workspaceDir: "/tmp/workspace",
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      prompt: "hello",
    });
    runtimeRecorder.recordEvent("model.completed", {
      usage: { input: 1, output: 2, total: 3 },
    });
    expect(runtimeRecorder.describeFlushState()).toContain("pendingRows=2");
    await runtimeRecorder.flush();

    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual([
      expect.objectContaining({ source: "runtime", type: "context.compiled" }),
      expect.objectContaining({ source: "runtime", type: "model.completed" }),
    ]);
    expect(fs.existsSync(path.join(path.dirname(storePath), "trajectory", "session-1.jsonl"))).toBe(
      false,
    );
  });

  it("records runtime events for the canonical session-key target the dispatcher passes", async () => {
    // Attempt dispatch stopped passing legacy `sqlite:` markers and now hands
    // the canonical session key plus a complete target. Recording must not
    // depend on the marker, or every harness capture silently disappears.
    const tempDir = makeTempDir();
    const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId: "session-1", updatedAt: 10 });
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionKey,
      sessionFile: sessionKey,
      sessionTarget: { agentId: "main", sessionId: "session-1", sessionKey, storePath },
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      workspaceDir: "/tmp/workspace",
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("session.started");
    await runtimeRecorder.flush();

    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual([expect.objectContaining({ source: "runtime", type: "session.started" })]);
  });

  it("rejects a legacy SQLite marker for another session", () => {
    const storePath = path.join(makeTempDir(), "sessions.json");

    expect(
      createTrajectoryRuntimeRecorder({
        sessionId: "current-session",
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId: "stale-session",
          storePath,
        }),
      }),
    ).toBeNull();
  });

  it.each([
    ["requested key", "agent:main:other", "main", "agent:main:main"],
    ["target key agent", undefined, "main", "agent:worker:main"],
  ])(
    "rejects a complete target that conflicts with the %s",
    (_label, sessionKey, agentId, targetKey) => {
      const storePath = path.join(makeTempDir(), "sessions.json");

      expect(
        createTrajectoryRuntimeRecorder({
          sessionId: "session-1",
          ...(sessionKey ? { sessionKey } : {}),
          sessionTarget: {
            agentId,
            sessionId: "session-1",
            sessionKey: targetKey,
            storePath,
          },
        }),
      ).toBeNull();
    },
  );

  it("rejects a complete target whose key maps to another session", async () => {
    const storePath = path.join(makeTempDir(), "sessions.json");
    const sessionKey = "agent:main:stored-session";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "stored-session",
        updatedAt: 1,
      },
    );

    expect(
      createTrajectoryRuntimeRecorder({
        sessionId: "requested-session",
        sessionKey,
        sessionTarget: {
          agentId: "main",
          sessionId: "requested-session",
          sessionKey,
          storePath,
        },
      }),
    ).toBeNull();
  });

  it("stores bounded oversized runtime events in SQLite", async () => {
    const tempDir = makeTempDir();
    const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:main";
    const usage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId: "session-1", updatedAt: 10 });
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionKey,
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId: "session-1",
        storePath,
      }),
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("model.completed", {
      usage,
      messagesSnapshot: Array.from({ length: 12 }, (_value, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(32_000)}`,
      })),
    });
    await runtimeRecorder.flush();

    const [event] = await loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath });
    expect(event).toMatchObject({
      type: "model.completed",
      data: {
        truncated: true,
        reason: "trajectory-event-size-limit",
        usage,
      },
    });
    expect(event?.data?.messagesSnapshot).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThanOrEqual(
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
    );
  });

  it("bounds oversized prompts before compact preservation", () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      prompt: "x".repeat(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.data.truncated).toBeUndefined();
    expect(parsed.data.prompt.truncated).toBe(true);
    expect(parsed.data.prompt.reason).toBe("trajectory-field-size-limit");
    expect(
      Buffer.byteLength(expectDefined(writes[0], "writes[0] test invariant"), "utf8"),
    ).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1);
  });

  it("keeps normal schema-v1 event payloads unchanged", () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });
    const data = {
      prompt: "inspect",
      systemPrompt: "system prompt",
      messages: [{ role: "user", content: "inspect" }],
      messagesSnapshot: [{ role: "assistant", content: "done" }],
      imagesCount: 0,
    };

    expectTrajectoryRuntimeRecorder(recorder).recordEvent("prompt.submitted", data);

    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.data).toEqual(data);
    expect(JSON.stringify(parsed.data)).toBe(JSON.stringify(data));
    expect(parsed.data.truncated).toBeUndefined();
  });

  it("preserves usage when truncating oversized runtime events", () => {
    const writes: string[] = [];
    const usage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    const promptCache = { readTokens: 333_824, writeTokens: 51_130 };
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("model.completed", {
      usage,
      promptCache,
      assistantTexts: ["done"],
      finalPromptText: "inspect",
      messagesSnapshot: Array.from({ length: 12 }, (_value, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(32_000)}`,
      })),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.type).toBe("model.completed");
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      usage,
      promptCache,
      assistantTexts: ["done"],
      finalPromptText: "inspect",
    });
    expect(parsed.data.messagesSnapshot).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(["messagesSnapshot"]);
    expect(
      Buffer.byteLength(expectDefined(writes[0], "writes[0] test invariant"), "utf8"),
    ).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1);
  });

  it("preserves stopReason while dropping oversized preserved fields to keep runtime events bounded", () => {
    const writes: string[] = [];
    const oversizedUsage = Object.fromEntries(
      Array.from({ length: 64 }, (_value, index) => [`field-${index}`, "x".repeat(5_000)]),
    );
    const promptCache = { readTokens: 333_824, writeTokens: 51_130 };
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("model.completed", {
      usage: oversizedUsage,
      promptCache,
      stopReason: "length",
      messagesSnapshot: [{ role: "user", content: "x".repeat(32_000) }],
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      promptCache,
      stopReason: "length",
    });
    expect(parsed.data.usage).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(
      expect.arrayContaining(["usage", "messagesSnapshot"]),
    );
    expect(
      Buffer.byteLength(expectDefined(writes[0], "writes[0] test invariant"), "utf8"),
    ).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1);
  });

  it("preserves the prompt when an oversized event drops inlined conversation state", () => {
    const writes: string[] = [];
    const prompt = "summarize the incident timeline for the deploy that failed";
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      prompt,
      systemPrompt: "x".repeat(32_000),
      messages: Array.from({ length: 12 }, (_value, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(32_000)}`,
      })),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      prompt,
      systemPrompt: "x".repeat(32_000),
    });
    expect(parsed.data.messages).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(["messages"]);
    expect(
      Buffer.byteLength(expectDefined(writes[0], "writes[0] test invariant"), "utf8"),
    ).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1);
  });

  it("drops repeated conversation fields in priority order", () => {
    const writes: string[] = [];
    const prompt = "summarize the incident timeline";
    const messageBlocks = Array.from({ length: 12 }, (_value, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index} ${"x".repeat(32_000)}`,
    }));
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    expectTrajectoryRuntimeRecorder(recorder).recordEvent("context.compiled", {
      prompt,
      messagesSnapshot: messageBlocks,
      messages: messageBlocks,
      systemPrompt: "x".repeat(32_760),
      tools: Array.from({ length: 7 }, (_value, index) => ({
        name: `tool-${index}`,
        description: "x".repeat(32_760),
      })),
    });

    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.data.prompt).toBe(prompt);
    expect(parsed.data.tools).toHaveLength(7);
    expect(parsed.data.messagesSnapshot).toBeUndefined();
    expect(parsed.data.messages).toBeUndefined();
    expect(parsed.data.systemPrompt).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(["messagesSnapshot", "messages", "systemPrompt"]);
    expect(
      Buffer.byteLength(expectDefined(writes[0], "writes[0] test invariant"), "utf8"),
    ).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1);
  });

  it("preserves the prompt in the compact fallback for oversized events", () => {
    const writes: string[] = [];
    const prompt = "summarize the incident timeline for the deploy that failed";
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    expectTrajectoryRuntimeRecorder(recorder).recordEvent("context.compiled", {
      prompt,
      tools: Array.from({ length: 12 }, (_value, index) => ({
        name: `tool-${index}`,
        description: "x".repeat(32_000),
      })),
    });

    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      prompt,
    });
    expect(parsed.data.tools).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(["tools"]);
    expect(
      Buffer.byteLength(expectDefined(writes[0], "writes[0] test invariant"), "utf8"),
    ).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1);
  });

  it("preserves usage on non-final oversized runtime completions", () => {
    const writes: string[] = [];
    const firstUsage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    const secondUsage = { input: 12, output: 3, total: 15 };
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("model.completed", {
      usage: firstUsage,
      promptCache: { readTokens: 333_824 },
      messagesSnapshot: Array.from({ length: 12 }, (_value, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(32_000)}`,
      })),
    });
    runtimeRecorder.recordEvent("model.completed", {
      usage: secondUsage,
      assistantTexts: ["final answer"],
    });

    expect(writes).toHaveLength(2);
    const first = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    const second = JSON.parse(expectDefined(writes[1], "writes[1] test invariant"));
    expect(first.data).toMatchObject({
      truncated: true,
      usage: firstUsage,
      promptCache: { readTokens: 333_824 },
    });
    expect(second.data).toMatchObject({
      usage: secondUsage,
      assistantTexts: ["final answer"],
    });
    expect(second.data.truncated).toBeUndefined();
  });

  it("caps large final prompts and records their original length", () => {
    const writes: string[] = [];
    const finalPromptText = `prompt-${"🙂".repeat(4_096)}`;
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    expectTrajectoryRuntimeRecorder(recorder).recordEvent("model.completed", { finalPromptText });

    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(Buffer.byteLength(parsed.data.finalPromptText, "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect(Buffer.byteLength(parsed.data.finalPromptText, "utf8")).toBeGreaterThan(4 * 1024 - 4);
    expect(parsed.data.finalPromptTextOriginalLength).toBe(finalPromptText.length);
  });

  it("leaves short final prompts unchanged", () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    expectTrajectoryRuntimeRecorder(recorder).recordEvent("trace.artifacts", {
      finalPromptText: "short prompt",
    });

    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    expect(parsed.data.finalPromptText).toBe("short prompt");
    expect(parsed.data.finalPromptTextOriginalLength).toBeUndefined();
  });

  it("redacts secrets before preserving usage in truncated runtime events", () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("model.completed", {
      usage: {
        total: 1,
        note: "Authorization: Bearer sk-inline-secret-token",
        apiKey: "sk-test-secret-token",
        authorization: "Bearer sk-other-secret-token",
      },
      messagesSnapshot: Array.from({ length: 12 }, (_value, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(32_000)}`,
      })),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(expectDefined(writes[0], "writes[0] test invariant"));
    const preservedUsage = JSON.stringify(parsed.data.usage);
    expect(parsed.data.truncated).toBe(true);
    expect(preservedUsage).toContain("redacted");
    expect(preservedUsage).not.toContain("sk-inline-secret-token");
    expect(preservedUsage).not.toContain("sk-test-secret-token");
    expect(preservedUsage).not.toContain("sk-other-secret-token");
  });

  it("describes queued writer state for cleanup timeout logs", () => {
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: () => "queued",
        flush: async () => undefined,
        describeQueue: () => ({
          pendingWrites: 2,
          queuedBytes: 256,
          activeOperation: "file-append",
          activeWriteBytes: 128,
          maxFileBytes: 1024,
          maxQueuedBytes: 1024,
          yieldBeforeWrite: true,
        }),
      },
    });

    const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);

    expect(runtimeRecorder.describeFlushState()).toBe(
      "pendingWrites=2 queuedBytes=256 activeOperation=file-append yieldBeforeWrite=true activeWriteBytes=128 maxQueuedBytes=1024 maxFileBytes=1024",
    );
  });

  it("does not record runtime events when explicitly disabled", () => {
    const recorder = createTrajectoryRuntimeRecorder({
      env: {
        OPENCLAW_TRAJECTORY: "0",
      },
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: () => undefined,
        flush: async () => undefined,
      },
    });

    expect(recorder).toBeNull();
  });
});
