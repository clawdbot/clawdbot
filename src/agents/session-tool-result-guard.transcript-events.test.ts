// Verifies guarded session managers emit transcript update events with stable sequence ids.
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transformMessages } from "../../packages/ai/src/transcript-transform.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  persistCompactionBoundaryWithSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { applyAssistantDeliveryDirectives } from "../config/sessions/transcript-assistant-delivery.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginHookBeforeMessageWriteEvent } from "../plugins/types.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { attachRuntimeUserTurnTranscriptContext } from "../sessions/user-turn-transcript-runtime-context.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.js";
import { createAssistantErrorTranscript } from "./assistant-error-transcript.js";
import { normalizeAssistantReplayContent } from "./embedded-agent-runner/replay-history.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./harness/hook-helpers.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import {
  prepareCodeModeSourceAppend,
  takeCodeModeResponseSource,
  wrapStreamFnCodeModeSource,
} from "./transcript-code-mode-source.js";

const listeners: Array<() => void> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let fixtureId = 0;

async function openPersistedSessionManager() {
  const root = tempDirs.make("openclaw-transcript-events-");
  const sessionId = `session-${fixtureId++}`;
  const target = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  const sessionEntry = { sessionId, updatedAt: Date.now() };
  await upsertSessionEntry({
    ...target,
    entry: sessionEntry,
  });
  return { root, sessionManager: SessionManager.open(target, root), target, sessionEntry };
}

afterEach(() => {
  // Remove all transcript listeners between tests to avoid duplicate broadcasts.
  while (listeners.length > 0) {
    listeners.pop()?.();
  }
  closeOpenClawAgentDatabasesForTest();
});

describe("guardSessionManager transcript updates", () => {
  it("refreshes the deferred error owner when a session manager serves a new run", async () => {
    const { sessionManager, target } = await openPersistedSessionManager();
    const first = createAssistantErrorTranscript({ runId: "run-first" });
    const second = createAssistantErrorTranscript({ runId: "run-second" });
    guardSessionManager(sessionManager, { runId: "run-first", assistantErrorTranscript: first });
    sessionManager.appendMessage(makeAgentAssistantMessage({ content: [], stopReason: "error" }));
    await first.settle(false);
    guardSessionManager(sessionManager, { runId: "run-second", assistantErrorTranscript: second });
    sessionManager.appendMessage(makeAgentAssistantMessage({ content: [], stopReason: "error" }));
    await second.settle(true);
    await first.settle(true);
    const messages = SessionManager.open(target)
      .getBranch()
      .filter((entry) => entry.type === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatchObject({
      stopReason: "error",
      __openclaw: { runId: "run-second" },
    });
  });

  it("persists compaction item identity under each current run across reload", async () => {
    const { sessionManager, root, target } = await openPersistedSessionManager();
    for (const runId of ["run-first", "run-second"]) {
      const guarded = guardSessionManager(sessionManager, { runId });
      const keptId = guarded.appendMessage({ role: "user", content: runId, timestamp: 1 });
      guarded.appendCompaction("summary", keptId, 100, { source: "hook" }, true, {
        itemId: `compaction-${runId}`,
      });
    }
    const compactions = SessionManager.open(target, root)
      .getBranch()
      .filter((entry) => entry.type === "compaction");
    expect(compactions).toMatchObject([
      {
        __openclaw: { runId: "run-first", itemId: "compaction-run-first" },
        details: { source: "hook" },
        fromHook: true,
      },
      {
        __openclaw: { runId: "run-second", itemId: "compaction-run-second" },
        details: { source: "hook" },
        fromHook: true,
      },
    ]);
  });

  it("reloads the session manager after atomic compaction persistence rolls back", async () => {
    const { sessionManager, root, target } = await openPersistedSessionManager();
    const keptId = sessionManager.appendMessage({
      role: "user",
      content: "keep",
      timestamp: 1,
    });
    const guarded = guardSessionManager(sessionManager, {
      withCompactionPersistence: (append, validateAppend) =>
        persistCompactionBoundaryWithSessionEntrySync(target, {
          append,
          transcriptByteCompactionLatch: {
            activeBytes: 2048,
            sessionId: target.sessionId,
            maxBytes: 1024,
          },
          validateAppend: (entryId, appendedText) => {
            expect(validateAppend(entryId, appendedText)).toBe(true);
            return false;
          },
        }),
    });

    expect(() => guarded.appendCompaction("summary", keptId, 100)).toThrow(
      "Compaction boundary validation failed",
    );
    expect(sessionManager.getLeafId()).toBe(keptId);
    expect(sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toEqual([]);
    expect(
      SessionManager.open(target, root)
        .getBranch()
        .filter((entry) => entry.type === "compaction"),
    ).toEqual([]);
  });

  it("consumes a steered source under its own custody and does not repeat its approval hook", async () => {
    const { root, target, sessionEntry } = await openPersistedSessionManager();
    const recorderTarget = { ...target, sessionEntry };
    const ambient = createUserTurnTranscriptRecorder({
      input: { text: "Active turn", timestamp: 1, idempotencyKey: "active:user" },
      target: recorderTarget,
    });
    const source = createUserTurnTranscriptRecorder({
      input: { text: "Steered source", timestamp: 2, idempotencyKey: "steered:user" },
      target: recorderTarget,
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
    });
    const markRuntimePersisted = vi.spyOn(source, "markRuntimePersisted");
    try {
      await ambient.stageApproved!({ runId: "active", assertCurrent: () => {} });
      await ambient.persistApproved();
      const approvalHook = vi.fn(({ message }: PluginHookBeforeMessageWriteEvent) => {
        if (message.role !== "user") {
          return undefined;
        }
        return {
          message: {
            ...message,
            content: `[approved] ${typeof message.content === "string" ? message.content : ""}`,
          },
        };
      });
      const registry = createEmptyPluginRegistry();
      registry.typedHooks.push({
        pluginId: "steered-input-approval",
        hookName: "before_message_write",
        source: "test",
        handler: approvalHook,
      });
      initializeGlobalHookRunner(registry);
      expect(await source.stageApproved!({ runId: "steered", assertCurrent: () => {} })).toBe(true);
      const approved = await source.resolveMessage();
      if (!approved) {
        throw new Error("Expected approved steering input");
      }
      const pending = listSessionPendingInputs(target);
      expect(pending.total).toBe(1);
      const guarded = guardSessionManager(SessionManager.open(target, root), {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        preparedUserTurnMessage: await ambient.resolveMessage(),
        preparedUserTurnTranscriptRecorder: ambient,
        suppressNextUserMessagePersistence: true,
      });
      const runtimeMessage = attachRuntimeUserTurnTranscriptContext(
        { role: "user", content: "Rendered steering prompt", timestamp: 2 },
        { message: approved, recorder: source },
      );

      // The already-running turn's async context is not the steered input's custody.
      const entryId = ambient.withPendingInput!(() => guarded.appendMessage(runtimeMessage));

      expect(entryId).toBe(pending.items[0]?.id);
      expect(guarded.getEntry(entryId)).toMatchObject({ message: approved });
      expect(source.getAdmissionReceipt()).toMatchObject({ entryId });
      expect(markRuntimePersisted).toHaveBeenCalledWith(
        approved,
        expect.objectContaining({ entryId }),
        { appended: true },
      );
      expect(listSessionPendingInputs(target)).toEqual({ items: [], total: 0 });
      expect(approvalHook).toHaveBeenCalledOnce();

      const unstagedId = guarded.appendMessage({
        role: "user",
        content: "Unstaged source",
        timestamp: 3,
      });
      expect(approvalHook).toHaveBeenCalledTimes(2);
      expect(guarded.getEntry(unstagedId)).toMatchObject({
        message: { role: "user", content: "[approved] Unstaged source" },
      });
    } finally {
      source.finishPendingInput?.("interrupted");
      ambient.finishPendingInput?.("interrupted");
      resetGlobalHookRunner();
    }
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "records replay admission without a fresh append (excluded: %s; stale manager: %s)",
    async (excludeFromContext, staleManager) => {
      const { root, target, sessionManager } = await openPersistedSessionManager();
      if (staleManager) {
        // The SDK persists model/thinking setup before prompt submission. Keep the user
        // projection stale without creating a competing lazy header initializer.
        sessionManager.appendModelChange("openai", "gpt-5.6-sol");
        sessionManager.appendThinkingLevelChange("off");
      }
      const openedBeforeIngress = staleManager
        ? SessionManager.openBounded(target, { cwd: root, maxBytes: 100_000, maxEvents: 100 })
        : undefined;
      const message = {
        role: "user" as const,
        content: "canonical prompt",
        idempotencyKey: "canonical-run:user",
        ...(excludeFromContext ? { excludeFromContext: true as const } : {}),
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
      const markRuntimePersisted = vi.spyOn(recorder, "markRuntimePersisted");
      const updates: InternalSessionTranscriptUpdate[] = [];
      listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));
      const guarded = guardSessionManager(
        openedBeforeIngress ??
          SessionManager.openBounded(target, { cwd: root, maxBytes: 100_000, maxEvents: 100 }),
        {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          preparedUserTurnMessage: message,
          preparedUserTurnTranscriptRecorder: recorder,
        },
      );

      expect(recorder.getAdmissionReceipt()).toBeUndefined();
      guarded.appendMessage({ ...message });

      expect(recorder.hasPersisted()).toBe(true);
      expect(markRuntimePersisted).toHaveBeenCalledWith(
        message,
        expect.objectContaining({ entryId: "ingress-persisted-user" }),
        { appended: false },
      );
      expect(updates).toEqual([]);
      expect(recorder.getAdmissionReceipt()).toMatchObject({
        agentId: target.agentId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
        entryId: "ingress-persisted-user",
        idempotencyKey: message.idempotencyKey,
        role: "user",
      });
    },
  );

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
      expect(markRuntimePersisted.mock.calls[0]?.[0]).toMatchObject({
        idempotencyKey: "canonical-run:user",
      });
      expect(markRuntimePersisted.mock.calls[0]?.[2]).toEqual({ appended: false });
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

    expect(markRuntimePersisted).toHaveBeenCalledTimes(1);
    expect(markRuntimePersisted.mock.calls[0]?.[0]).toMatchObject({
      display: false,
      role: "user",
    });
    expect(markRuntimePersisted.mock.calls[0]?.[2]).toEqual({ appended: true });
  });

  it("drops selected mentions when a write hook mutates their text in place", async () => {
    const { target, sessionManager } = await openPersistedSessionManager();
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Hi @Taylor" }],
      timestamp: 1,
      __openclaw: {
        humanMentions: [{ profileId: "profile-taylor", start: 3, end: 10 }],
      },
    };
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "rewrite-user-selection",
      hookName: "before_message_write",
      source: "test",
      handler: ({ message: runtimeMessage }: PluginHookBeforeMessageWriteEvent) => {
        if (runtimeMessage.role === "user" && Array.isArray(runtimeMessage.content)) {
          Object.assign(runtimeMessage.content[0]!, { text: "Hi @Morgan" });
        }
        return { message: runtimeMessage };
      },
    });
    initializeGlobalHookRunner(registry);
    try {
      const guarded = guardSessionManager(sessionManager, {
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        preparedUserTurnMessage: message,
      });
      const entryId = guarded.appendMessage(message);
      expect(guarded.getEntry(entryId)).toMatchObject({
        message: { role: "user", content: [{ type: "text", text: "Hi @Morgan" }] },
      });
      expect(guarded.getEntry(entryId)).not.toHaveProperty("message.__openclaw.humanMentions");
    } finally {
      resetGlobalHookRunner();
    }
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

  it.each([false, true])(
    "refreshes terminal run ownership with hooks skipped=%s",
    async (skipBeforeMessageWriteHooks) => {
      const updates: InternalSessionTranscriptUpdate[] = [];
      listeners.push(onInternalSessionTranscriptUpdate((update) => updates.push(update)));
      const { sessionManager, target } = await openPersistedSessionManager();

      const firstRun = guardSessionManager(sessionManager, {
        skipBeforeMessageWriteHooks,
        agentId: target.agentId,
        runId: "run-first",
        sessionKey: target.sessionKey,
        prepareAssistantTranscriptMessage: (message) =>
          applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./first.json"] }),
      });
      firstRun.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "first reply\nMEDIA:./first.json" }],
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
      expect(updates[0]?.message).toMatchObject({
        content: [{ type: "text", text: "first reply\nMEDIA:./first.json" }],
        openclawDelivery: { mediaUrls: ["./first.json"] },
      });
      expect(
        updates.slice(1).some(({ message }) => Reflect.has(message as object, "openclawDelivery")),
      ).toBe(false);
      expect(
        updates.map(({ messageId, messageSeq, runId }) => ({ messageId, messageSeq, runId })),
      ).toEqual([
        { messageId: expect.any(String), messageSeq: 1, runId: "run-first" },
        { messageId: expect.any(String), messageSeq: 2, runId: "run-second" },
        { messageId: expect.any(String), messageSeq: 3, runId: undefined },
      ]);
    },
  );
});

describe("deferred assistant error transcript", () => {
  async function setup() {
    const { sessionManager: manager, target } = await openPersistedSessionManager();
    const owner = createAssistantErrorTranscript({ runId: "run-test" });
    installSessionToolResultGuard(manager, { assistantErrorTranscript: owner });
    return { target, owner, manager };
  }

  it.each([false, true])("persists only the last failure when terminal=%s", async (terminal) => {
    const { target, owner, manager } = await setup();
    for (let attempt = 1; attempt <= 10; attempt++) {
      manager.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: `Partial attempt ${attempt}` }],
          stopReason: "error",
          errorMessage: `provider rate limit ${attempt}`,
        }),
      );
      expect(SessionManager.open(target).getBranch()).toHaveLength(0);
    }
    if (!terminal) {
      manager.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "Recovered" }] }),
      );
    }
    await owner.settle(terminal);
    await owner.settle(terminal);
    const messages = SessionManager.open(target)
      .getBranch()
      .filter((entry) => entry.type === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.message).toMatchObject(
      terminal
        ? {
            content: [{ type: "text", text: "Partial attempt 10" }],
            stopReason: "error",
            errorMessage: "provider rate limit 10",
          }
        : { content: [{ type: "text", text: "Recovered" }] },
    );
  });

  it("preserves failed-attempt tool calls before their persisted results through recovery and replay", async () => {
    const { target, owner, manager } = await setup();
    const model = makeProviderModelFixture({
      id: "test-model",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://example.invalid",
    });
    const toolCall = {
      type: "toolCall" as const,
      id: "call-exec",
      name: "exec",
      arguments: { code: "const API_TOKEN = computeToken(); return API_TOKEN;" },
    };
    const failed = makeAgentAssistantMessage({
      content: [{ type: "text", text: "I" }, toolCall],
      stopReason: "error",
      errorMessage: "provider rate limit",
    });
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "error", reason: "error", error: failed });
    const response = await wrapStreamFnCodeModeSource(() => stream, new Set(["exec"]))(model, {
      messages: [],
    });
    const emitted = await response.result();
    manager.appendMessage(
      emitted,
      prepareCodeModeSourceAppend({}, emitted, takeCodeModeResponseSource(emitted)),
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: "Persisted result" }],
      isError: false,
      timestamp: 1,
    });
    owner.clear();
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Recovered" }],
        timestamp: 2,
      }),
    );
    await owner.settle(false);
    closeOpenClawAgentDatabasesForTest();
    const messages = SessionManager.open(target).buildSessionContext().messages;
    expect(messages).toMatchObject([
      { role: "assistant", content: [toolCall], stopReason: "toolUse" },
      {
        role: "toolResult",
        toolCallId: toolCall.id,
        content: [{ type: "text", text: "Persisted result" }],
      },
      { role: "assistant", content: [{ type: "text", text: "Recovered" }] },
    ]);
    expect(messages[0]).not.toHaveProperty("errorMessage");
    const normalized = normalizeAssistantReplayContent(messages);
    const replay = transformMessages(
      normalized.filter(
        (message) =>
          message.role === "assistant" || message.role === "user" || message.role === "toolResult",
      ),
      model,
    );
    expect(replay).toEqual(normalized);
  });

  it.each([
    {
      label: "canonical media",
      facts: {
        __openclaw: {
          media: [{ url: "https://example.invalid/report.pdf", contentType: "application/pdf" }],
        },
      },
    },
    { label: "managed attachment", facts: { openclawDelivery: { mediaUrls: ["./report.pdf"] } } },
    {
      label: "display override",
      facts: {
        openclawDisplayContent: [
          { type: "text", text: "Here" },
          { type: "attachment", url: "https://example.invalid/report.pdf" },
        ],
      },
    },
  ])("preserves $label facts without partial text when recovery succeeds", async ({ facts }) => {
    const { target, owner, manager } = await setup();
    const failed = {
      ...makeAgentAssistantMessage({
        content: [{ type: "text", text: "Here" }],
        stopReason: "error",
        errorMessage: "retry",
      }),
      ...facts,
    };
    manager.appendMessage(failed);
    owner.clear();
    manager.appendMessage(
      makeAgentAssistantMessage({ content: [{ type: "text", text: "Recovered" }] }),
    );
    await owner.settle(false);
    const messages = SessionManager.open(target).buildSessionContext().messages;
    expect(messages).toMatchObject([
      {
        role: "assistant",
        content: [],
        stopReason: "stop",
        ...facts,
        ...(facts.openclawDisplayContent
          ? { openclawDisplayContent: [facts.openclawDisplayContent[1]] }
          : {}),
      },
      { role: "assistant", content: [{ type: "text", text: "Recovered" }] },
    ]);
  });

  it("keeps terminal partial text and its error without duplicating tool facts or usage", async () => {
    const { target, owner, manager } = await setup();
    const displayText = { type: "text", text: "Displayed partial answer" };
    const attachment = { type: "attachment", url: "https://example.invalid/report.pdf" };
    const failed = {
      ...makeAgentAssistantMessage({
        content: [
          { type: "text", text: "Partial answer" },
          { type: "toolCall", id: "call-terminal", name: "read", arguments: {} },
        ],
        stopReason: "error",
        errorMessage: "terminal failure",
      }),
      openclawDisplayContent: [displayText, attachment],
    };
    failed.usage = { ...failed.usage, output: 7, totalTokens: 7 };
    manager.appendMessage(failed);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "call-terminal",
      toolName: "read",
      content: [{ type: "text", text: "Result" }],
      isError: false,
      timestamp: 1,
    });
    await owner.settle(true);
    const messages = SessionManager.open(target).buildSessionContext().messages;
    expect(messages).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-terminal" }],
        openclawDisplayContent: [attachment],
        usage: { output: 7 },
      },
      { role: "toolResult", toolCallId: "call-terminal" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Partial answer" }],
        openclawDisplayContent: [displayText],
        stopReason: "error",
        errorMessage: "terminal failure",
        usage: { output: 0 },
      },
    ]);
  });

  it("revalidates the captured writer before committing a terminal failure", async () => {
    const { target, owner, manager } = await setup();
    let active = true;
    await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: target,
        assertCommitAllowed: () => {
          if (!active) {
            throw new Error("writer retired");
          }
        },
        withTranscriptWrite: async (operation) => await operation(),
      },
      async () => {
        manager.appendMessage(makeAgentAssistantMessage({ content: [], stopReason: "error" }));
      },
    );
    active = false;
    await expect(owner.settle(true)).rejects.toThrow("writer retired");
    expect(SessionManager.open(target).getBranch()).toHaveLength(0);
  });
});
