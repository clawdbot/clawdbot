// Verifies guarded session managers emit transcript update events with stable sequence ids.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
} from "../config/sessions/session-accessor.js";
import { applyAssistantDeliveryDirectives } from "../config/sessions/transcript-assistant-delivery.js";
import { readRuntimePromptImageProvenance } from "../media/runtime-prompt-image-provenance.js";
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
import {
  detectAndLoadPromptImages,
  hydratePromptMediaMessages,
} from "./embedded-agent-runner/run/images.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./harness/hook-helpers.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

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
  it.each([
    { name: "history first", order: ["history", "current"], missing: false },
    { name: "current first", order: ["current", "history"], missing: false },
    { name: "history before missing current", order: ["history", "current"], missing: true },
    { name: "missing current before history", order: ["current", "history"], missing: true },
    {
      name: "dropped unbound before missing current",
      order: ["invalid", "current", "history"],
      missing: true,
    },
  ] as const)("preserves runtime image replay ($name)", async ({ name, order, missing }) => {
    const { root, sessionManager, target, sessionEntry } = await openPersistedSessionManager();
    const historyBytes = createSolidPngBuffer(1, 1, { r: 255, g: 0, b: 0 });
    const currentBytes = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    const invalidBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
    expect(hash(historyBytes)).not.toBe(hash(currentBytes));
    const currentPath = path.join(root, "current.png");
    if (!missing) {
      await fs.writeFile(currentPath, currentBytes);
    }
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "Compare the retained image with the current image.",
        media: [{ path: currentPath, contentType: "image/png" }],
        mediaImageLayout: {
          slots: order.map((source) =>
            source === "current"
              ? { kind: "offloaded" as const, factIndex: 0 }
              : { kind: "inline" as const },
          ),
        },
        timestamp: 1,
        idempotencyKey: `${name}:user`,
      },
      target: { ...target, sessionEntry },
    });
    const preparedMessage = await recorder.resolveMessage();
    if (!preparedMessage) {
      throw new Error("Expected canonical prepared user input");
    }
    const prepared = await detectAndLoadPromptImages({
      prompt: "Compare the retained image with the current image.",
      userTurnTranscriptRecorder: recorder,
      existingImages: order.flatMap((source) =>
        source === "current"
          ? []
          : [
              {
                type: "image" as const,
                data: (source === "invalid" ? invalidBytes : historyBytes).toString("base64"),
                mimeType: "image/png",
              },
            ],
      ),
      model: { input: ["text", "image"] },
      workspaceDir: root,
      localRoots: [root],
    });
    const preparedSources = order.filter(
      (source) => source !== "invalid" && (!missing || source !== "current"),
    );
    const expectedFactIndexes = preparedSources.map((source) => (source === "current" ? 0 : null));
    expect({
      hashes: prepared.images.map((image) => hash(Buffer.from(image.data, "base64"))),
      indexes: prepared.imageFactIndexes,
      loaded: prepared.loadedCount,
      failed: prepared.failedMediaCount,
      skipped: prepared.skippedCount,
    }).toEqual({
      hashes: preparedSources.map((source) =>
        hash(source === "current" ? currentBytes : historyBytes),
      ),
      indexes: expectedFactIndexes,
      loaded: missing ? 0 : 1,
      failed: missing ? 1 : 0,
      skipped: missing ? 1 : 0,
    });
    // Mirror AgentSession's native producer; its own SDK test covers this copy boundary.
    const provenance = readRuntimePromptImageProvenance(prepared.images);
    if (!provenance) {
      throw new Error("Expected prepared runtime image provenance");
    }
    const runtimeMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Rendered runtime prompt" }, ...prepared.images],
      timestamp: 2,
      __openclaw: {
        mediaImageBlockFactIndexes: provenance.imageFactIndexes,
        mediaImageLayout: provenance.mediaImageLayout,
      },
    };
    expect(runtimeMessage.__openclaw.mediaImageBlockFactIndexes).toEqual(expectedFactIndexes);
    const guarded = guardSessionManager(sessionManager, {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      preparedUserTurnMessage: preparedMessage,
      preparedUserTurnTranscriptRecorder: recorder,
    });
    const entryId = guarded.appendMessage(runtimeMessage);
    expect(recorder.hasPersisted()).toBe(true);
    const storedEntry = SessionManager.open(target, root).getEntry(entryId);
    if (storedEntry?.type !== "message" || storedEntry.message.role !== "user") {
      throw new Error("Expected runtime user row from the real SQLite transcript");
    }
    const storedMessage = storedEntry.message;
    expect(storedMessage.content).toEqual(runtimeMessage.content);
    expect(Reflect.get(storedMessage, "idempotencyKey")).toBe(`${name}:user`);
    // Recover the unavailable current source only after the runtime row was committed.
    if (missing) {
      await fs.writeFile(currentPath, currentBytes);
    }
    await expect(fs.readFile(currentPath)).resolves.toEqual(currentBytes);
    const failures: number[] = [];
    const [replayed] = await hydratePromptMediaMessages([storedMessage], {
      workspaceDir: root,
      model: { input: ["text", "image"] },
      localRoots: [root],
      onCurrentTurnImageFailure: (count) => {
        failures.push(count);
      },
    });
    if (replayed?.role !== "user" || !Array.isArray(replayed.content)) {
      throw new Error("Expected stored runtime row to materialize for replay");
    }
    expect({
      hashes: replayed.content
        .filter((block) => block.type === "image")
        .map((image) => hash(Buffer.from(image.data, "base64"))),
      text: replayed.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
      failures,
    }).toEqual({
      hashes: order.flatMap((source) =>
        source === "invalid" ? [] : [hash(source === "current" ? currentBytes : historyBytes)],
      ),
      text: ["Rendered runtime prompt"],
      failures: [],
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

  it.each([false, true])(
    "records the admission anchor when adopting an ingress-persisted user (excluded: %s)",
    async (excludeFromContext) => {
      const { root, target } = await openPersistedSessionManager();
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
      const guarded = guardSessionManager(
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
