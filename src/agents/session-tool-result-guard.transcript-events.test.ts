// Verifies guarded session managers emit transcript update events with stable sequence ids.
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { attachRuntimeUserTurnTranscriptContext } from "../sessions/user-turn-transcript-runtime-context.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../shared/transcript-only-openclaw-assistant.js";
import { normalizeAssistantReplayContent } from "./embedded-agent-runner/replay-history.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { installToolSearchTargetTranscriptPersistence } from "./tool-search.js";

const listeners: Array<() => void> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let fixtureId = 0;

function createAssistantMessage(params: {
  content: AssistantMessage["content"];
  stopReason: AssistantMessage["stopReason"];
  timestamp: number;
}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.6-luna",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...params,
  };
}

async function openPersistedSessionManager() {
  const root = tempDirs.make("openclaw-transcript-events-");
  const sessionId = `session-${fixtureId++}`;
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId, updatedAt: Date.now() },
  });
  return { root, sessionManager: SessionManager.open(target, root), target };
}

afterEach(() => {
  // Remove all transcript listeners between tests to avoid duplicate broadcasts.
  while (listeners.length > 0) {
    listeners.pop()?.();
  }
  closeOpenClawAgentDatabasesForTest();
});

describe("guardSessionManager transcript updates", () => {
  it("persists paired nested activity after its wrapper while preserving the terminal leaf", async () => {
    const { root, target } = await openPersistedSessionManager();
    const projections = [
      {
        parentToolCallId: "wrapper-call",
        toolCallId: "nested-call",
        toolName: "read",
        input: { path: "large.txt" },
        result: {
          content: [{ type: "text" as const, text: "x".repeat(200_000) }],
          details: {},
        },
        isError: false,
        timestamp: 3,
      },
    ];
    const guarded = guardSessionManager(SessionManager.open(target, root), {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      contextWindowTokens: 128,
    });
    const restore = installToolSearchTargetTranscriptPersistence({
      sessionManager: guarded,
      projections,
    });

    guarded.appendMessage(
      createAssistantMessage({
        content: [
          {
            type: "toolCall",
            id: "wrapper-call",
            name: "exec",
            arguments: { code: 'return await read({ path: "large.txt" });' },
          },
        ],
        stopReason: "toolUse",
        timestamp: 1,
      }),
    );
    guarded.appendMessage({
      role: "toolResult",
      toolCallId: "wrapper-call",
      toolName: "exec",
      content: [{ type: "text", text: "completed" }],
      details: {
        openclawCodeModeControl: { kind: "exec", language: "javascript" },
        oversized: "y".repeat(200_000),
      },
      isError: false,
      timestamp: 2,
    });
    const finalEntryId = guarded.appendMessage(
      createAssistantMessage({
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        timestamp: 4,
      }),
    );
    restore();
    guarded.flushPendingToolResults?.();

    const messages = guarded
      .getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    expect(
      messages.map((message) => ({
        role: message.role,
        provider: (message as { provider?: unknown }).provider,
        toolCallId: (message as { toolCallId?: unknown }).toolCallId,
        artifact: (message as { openclawTranscriptArtifact?: unknown }).openclawTranscriptArtifact,
      })),
    ).toEqual([
      { role: "assistant", provider: "openai", toolCallId: undefined, artifact: undefined },
      { role: "toolResult", provider: undefined, toolCallId: "wrapper-call", artifact: undefined },
      {
        role: "assistant",
        provider: undefined,
        toolCallId: undefined,
        artifact: { kind: "nested-tool", version: 1 },
      },
      {
        role: "toolResult",
        provider: undefined,
        toolCallId: "nested-call",
        artifact: { kind: "nested-tool", version: 1 },
      },
      { role: "assistant", provider: "openai", toolCallId: undefined, artifact: undefined },
    ]);
    expect(guarded.getLeafId()).toBe(finalEntryId);
    expect((messages[1] as { details?: unknown }).details).toMatchObject({
      openclawCodeModeControl: { kind: "exec", language: "javascript" },
    });
    const nestedResult = messages[3] as Extract<AgentMessage, { role: "toolResult" }>;
    const nestedText = Array.isArray(nestedResult.content)
      ? nestedResult.content.map((part) => ("text" in part ? part.text : "")).join("")
      : "";
    expect(nestedText.length).toBeLessThan(200_000);
    expect(normalizeAssistantReplayContent(messages)).toEqual([
      messages[0],
      messages[1],
      messages[4],
    ]);
    const currentMainReplay = messages.filter(
      (message) => !isTranscriptOnlyOpenClawAssistantMessage(message),
    );
    expect(currentMainReplay.slice(2, 4)).toEqual([messages[2], messages[3]]);
    expect((currentMainReplay[2] as { content?: Array<{ id?: string }> }).content?.[0]?.id).toBe(
      (currentMainReplay[3] as { toolCallId?: string }).toolCallId,
    );

    const reopened = SessionManager.open(target, root);
    expect(reopened.getLeafId()).toBe(finalEntryId);
    expect(
      reopened
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message.role),
    ).toEqual(["assistant", "toolResult", "assistant", "toolResult", "assistant"]);
  });

  it("records the admission anchor when adopting an ingress-persisted user", async () => {
    const { root, target } = await openPersistedSessionManager();
    const message = {
      role: "user" as const,
      content: "canonical prompt",
      idempotencyKey: "canonical-run:user",
      timestamp: Date.now(),
    };
    await appendTranscriptMessage(target, {
      cwd: root,
      eventId: "ingress-persisted-user",
      message,
      now: message.timestamp,
    });
    const recorder = createUserTurnTranscriptRecorder({
      message,
      target: {
        ...target,
        sessionEntry: { sessionId: target.sessionId, updatedAt: message.timestamp },
      },
    });
    const guarded = guardSessionManager(SessionManager.open(target, root), {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      preparedUserTurnMessage: message,
      preparedUserTurnTranscriptRecorder: recorder,
    });

    expect(recorder.getAdmissionReceipt()).toBeUndefined();
    guarded.appendMessage({ ...message });

    expect(recorder.hasPersisted()).toBe(true);
    expect(recorder.getAdmissionReceipt()).toMatchObject({
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      entryId: "ingress-persisted-user",
      idempotencyKey: message.idempotencyKey,
      role: "user",
    });
  });

  it.each(["active", "side", "setup-metadata"] as const)(
    "adopts an ingress-persisted %s-branch user without broadcasting a duplicate",
    (branch) => {
      const updates: InternalSessionTranscriptUpdate[] = [];
      listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

      const sm = SessionManager.inMemory();
      const preparedUserTurnMessage = {
        role: "user" as const,
        content: "canonical prompt",
        idempotencyKey: "canonical-run:user",
        timestamp: Date.now(),
      };
      const existingId = sm.appendMessage(preparedUserTurnMessage);
      if (branch === "side") {
        const visibleLeafId = sm.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "visible branch" }],
          timestamp: Date.now(),
        } as Parameters<typeof sm.appendMessage>[0]);
        sm.appendLeafControl({
          targetId: visibleLeafId,
          appendParentId: existingId,
          appendMode: "side",
        });
      } else if (branch === "setup-metadata") {
        sm.appendModelChange("openai", "gpt-5.5");
        sm.appendThinkingLevelChange("off");
        sm.appendCustomEntry("model-snapshot", {
          modelApi: "openai-responses",
          modelId: "gpt-5.5",
          provider: "openai",
        });
      }
      const appendParentId = sm.getAppendParentId();
      const markRuntimePersisted = vi.fn();
      const recorder = {
        markBlocked: vi.fn(),
        markRuntimePersisted,
      } as unknown as UserTurnTranscriptRecorder;
      const guarded = guardSessionManager(sm, {
        agentId: "main",
        sessionKey: "agent:main:canonical",
        preparedUserTurnMessage,
        preparedUserTurnTranscriptRecorder: recorder,
      });

      const runtimeId = guarded.appendMessage({
        role: "user",
        content: "canonical prompt",
        timestamp: preparedUserTurnMessage.timestamp,
      });

      expect(runtimeId).toBe(existingId);
      expect(sm.getAppendParentId()).toBe(appendParentId);
      expect(
        sm
          .getEntries()
          .filter((entry) => entry.type === "message" && entry.message.role === "user"),
      ).toHaveLength(1);
      expect(updates).toEqual([]);
      expect(markRuntimePersisted).toHaveBeenCalledTimes(1);
      expect(markRuntimePersisted).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: "canonical-run:user" }),
      );
    },
  );

  it("persists and broadcasts memory-maintenance messages as hidden", async () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

    const { sessionManager: sm, target } = await openPersistedSessionManager();

    const guarded = guardSessionManager(sm, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      trigger: "memory",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
      timestamp: Date.now(),
    } as AgentMessage);

    const persisted = sm.getEntries().find((entry) => entry.type === "message") as
      | { message?: AgentMessage }
      | undefined;
    expect(persisted?.message).toMatchObject({ display: false, role: "assistant" });
    expect(updates[0]?.message).toMatchObject({ display: false, role: "assistant" });
  });

  it("keeps the user-turn recorder attached when hiding memory maintenance", () => {
    const sm = SessionManager.inMemory();
    const markRuntimePersisted = vi.fn();
    const recorder = {
      markBlocked: vi.fn(),
      markRuntimePersisted,
    } as unknown as UserTurnTranscriptRecorder;
    const runtimeMessage = attachRuntimeUserTurnTranscriptContext(
      {
        role: "user",
        content: "Pre-compaction memory flush",
        timestamp: Date.now(),
      },
      {
        message: {
          role: "user",
          content: "Pre-compaction memory flush",
          timestamp: Date.now(),
        },
        recorder,
      },
    );
    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:memory",
      trigger: "memory",
    });

    guarded.appendMessage(runtimeMessage as Parameters<typeof guarded.appendMessage>[0]);

    expect(markRuntimePersisted).toHaveBeenCalledWith(
      expect.objectContaining({ display: false, role: "user" }),
    );
  });

  it("does not hide ordinary messages that mention memory flushes", () => {
    const sm = SessionManager.inMemory();
    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:user",
      trigger: "user",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "user",
      content: "Why did the memory flush leak?",
      timestamp: Date.now(),
    } as AgentMessage);

    const persisted = sm.getEntries().find((entry) => entry.type === "message") as
      | { message?: AgentMessage }
      | undefined;
    expect(persisted?.message).not.toHaveProperty("display", false);
  });

  it("broadcasts the SQLite target for appended non-tool-result messages", async () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

    const { sessionManager: sm, target } = await openPersistedSessionManager();

    const guarded = guardSessionManager(sm, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    const timestamp = Date.now();
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello from subagent" }],
      timestamp,
    } as AgentMessage);

    expect(updates).toStrictEqual([
      {
        agentId: "main",
        message: {
          content: [{ text: "hello from subagent", type: "text" }],
          role: "assistant",
          timestamp,
        },
        messageId: expect.any(String),
        messageSeq: 1,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        target,
      },
    ]);
    expect(updates[0]?.messageId).not.toBe("");
  });

  it("does not resolve transcript sequence for an in-memory session", () => {
    const sm = SessionManager.inMemory();
    const getBranchSpy = vi.spyOn(sm, "getBranch");

    const guarded = guardSessionManager(sm, {
      agentId: "main",
      sessionKey: "agent:main:worker",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(getBranchSpy).not.toHaveBeenCalled();
    getBranchSpy.mockRestore();
  });

  it("reuses cached transcript sequence for consecutive appended messages", async () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

    const { sessionManager: sm, target } = await openPersistedSessionManager();
    sm.appendMessage({
      role: "user",
      content: "existing prompt",
      timestamp: Date.now(),
    } as Parameters<typeof sm.appendMessage>[0]);
    const getBranchSpy = vi.spyOn(sm, "getBranch");
    const guarded = guardSessionManager(sm, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first" }],
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(getBranchSpy).toHaveBeenCalledTimes(1);
    expect(updates.map((update) => update.messageSeq)).toEqual([2, 3]);
    getBranchSpy.mockRestore();
  });

  it("caches real tool result sequence before final assistant messages", async () => {
    // Tool results are persisted but not broadcast, so later visible messages must skip their seq.
    const updates: InternalSessionTranscriptUpdate[] = [];
    listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));

    const { sessionManager: sm, target } = await openPersistedSessionManager();
    sm.appendMessage({
      role: "user",
      content: "existing prompt",
      timestamp: Date.now(),
    } as Parameters<typeof sm.appendMessage>[0]);
    const getBranchSpy = vi.spyOn(sm, "getBranch");
    const guarded = guardSessionManager(sm, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      runId: "run-owning-final",
    });
    const appendMessage = guarded.appendMessage.bind(guarded) as unknown as (
      message: AgentMessage,
    ) => void;

    appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "tool output" }],
      isError: false,
      timestamp: Date.now(),
    } as AgentMessage);
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
      timestamp: Date.now(),
    } as AgentMessage);

    expect(
      sm
        .getEntries()
        .filter((entry) => entry.type === "message")
        .map((entry) => ({
          role: entry.message.role,
          runId: asNullableRecord(asNullableRecord(entry.message)?.["__openclaw"])?.runId,
        })),
    ).toEqual([
      { role: "user", runId: undefined },
      { role: "assistant", runId: "run-owning-final" },
      { role: "toolResult", runId: "run-owning-final" },
      { role: "assistant", runId: "run-owning-final" },
    ]);
    expect(getBranchSpy).toHaveBeenCalledTimes(1);
    expect(updates.map((update) => update.messageSeq)).toEqual([2, 4]);
    expect(
      updates.map(
        (update) => asNullableRecord(asNullableRecord(update.message)?.["__openclaw"])?.runId,
      ),
    ).toEqual(["run-owning-final", "run-owning-final"]);
    expect(updates.map((update) => update.runId)).toEqual([undefined, "run-owning-final"]);
    getBranchSpy.mockRestore();
  });

  it("refreshes terminal run ownership when a guarded session manager is reused", async () => {
    const updates: InternalSessionTranscriptUpdate[] = [];
    listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));
    const { sessionManager, target } = await openPersistedSessionManager();

    const firstRun = guardSessionManager(sessionManager, {
      agentId: target.agentId,
      runId: "run-first",
      sessionKey: target.sessionKey,
    });
    firstRun.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first reply" }],
      timestamp: Date.now(),
    } as Parameters<typeof firstRun.appendMessage>[0]);

    const secondRun = guardSessionManager(sessionManager, {
      agentId: target.agentId,
      runId: "run-second",
      sessionKey: target.sessionKey,
    });
    secondRun.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second reply" }],
      timestamp: Date.now(),
    } as Parameters<typeof secondRun.appendMessage>[0]);

    const unknownRun = guardSessionManager(sessionManager);
    unknownRun.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "unowned reply" }],
      timestamp: Date.now(),
    } as Parameters<typeof unknownRun.appendMessage>[0]);

    expect(secondRun).toBe(firstRun);
    expect(unknownRun).toBe(firstRun);
    expect(
      updates.map(({ messageId, messageSeq, runId }) => ({ messageId, messageSeq, runId })),
    ).toEqual([
      { messageId: expect.any(String), messageSeq: 1, runId: "run-first" },
      { messageId: expect.any(String), messageSeq: 2, runId: "run-second" },
      { messageId: expect.any(String), messageSeq: 3, runId: undefined },
    ]);
  });
});
