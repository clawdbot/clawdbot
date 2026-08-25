// Verifies guarded session managers emit transcript update events with stable sequence ids.
import fs from "node:fs";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { mergeSessionTranscriptContext } from "../channels/inbound-event/session-transcript-context.runtime.js";
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
import { recordToolResultLocalMediaReplayAuthorization } from "./embedded-agent-tool-media.js";
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

  it("bounds and refreshes persisted media authority through channel context", async () => {
    const { root, sessionManager: sm, target } = await openPersistedSessionManager();
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    const collision = path.join(root, "media", "generated", "collision.png");
    const exact = path.join(root, "media", "generated", "exact.png");
    fs.mkdirSync(path.dirname(collision), { recursive: true });
    fs.writeFileSync(collision, "collision");
    fs.writeFileSync(exact, "exact");
    let inspected = 0;
    const probeMediaUrls = Array(100_000).fill(exact);
    const iterateProbeMediaUrls = probeMediaUrls[Symbol.iterator].bind(probeMediaUrls);
    Object.defineProperty(probeMediaUrls, Symbol.iterator, {
      *value() {
        for (const mediaUrl of iterateProbeMediaUrls()) {
          inspected += 1;
          yield mediaUrl;
        }
      },
    });
    const boundedAuthorization = recordToolResultLocalMediaReplayAuthorization(
      { details: { media: { mediaUrls: probeMediaUrls } } },
      "exec",
      new Set(["exec"]),
    );
    expect(inspected).toBe(64);
    expect(
      asNullableRecord(asNullableRecord(boundedAuthorization.details)?.media)
        ?.localMediaReplayAuthorized,
    ).toBe(true);
    const guarded = guardSessionManager(sm, {
      runId: "run-allowed",
      trustedLocalMediaToolNames: new Set(["exec"]),
    });
    const appendToolResult = (
      manager: typeof guarded,
      id: string,
      name: string,
      mediaUrls: readonly string[],
    ) => {
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id, name, arguments: {} }],
        timestamp: Date.now(),
      } as Parameters<typeof manager.appendMessage>[0]);
      manager.appendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text: "done" }],
        details: { media: { mediaUrls } },
        isError: false,
        timestamp: Date.now(),
      } as Parameters<typeof manager.appendMessage>[0]);
    };
    try {
      guarded.appendMessage({
        role: "user",
        content: "inspect",
        timestamp: Date.now(),
      } as Parameters<typeof guarded.appendMessage>[0]);
      for (const [id, name, mediaUrls] of [
        ["colliding", "Bash", [collision]],
        ["exact", "exec", [exact]],
      ] as const) {
        appendToolResult(guarded, id, name, mediaUrls);
      }
      guarded.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `collision ${collision}; exact ${exact}` }],
        timestamp: Date.now(),
      } as Parameters<typeof guarded.appendMessage>[0]);

      const deniedRun = guardSessionManager(sm, {
        runId: "run-denied",
        trustedLocalMediaToolNames: new Set(),
      });
      deniedRun.appendMessage({
        role: "user",
        content: "recheck",
        timestamp: Date.now(),
      } as Parameters<typeof deniedRun.appendMessage>[0]);
      appendToolResult(deniedRun, "stale", "exec", [exact]);
      deniedRun.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `stale ${exact}` }],
        timestamp: Date.now(),
      } as Parameters<typeof deniedRun.appendMessage>[0]);

      const restoredRun = guardSessionManager(sm, {
        runId: "run-restored",
        trustedLocalMediaToolNames: new Set(["exec"]),
      });
      restoredRun.appendMessage({
        role: "user",
        content: "restore",
        timestamp: Date.now(),
      } as Parameters<typeof restoredRun.appendMessage>[0]);
      appendToolResult(restoredRun, "restored", "exec", [exact]);
      restoredRun.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `restored ${exact}` }],
        timestamp: Date.now(),
      } as Parameters<typeof restoredRun.appendMessage>[0]);

      const authorizations = sm.getEntries().flatMap((entry) => {
        if (entry.type !== "message" || entry.message.role !== "toolResult") {
          return [];
        }
        return [
          asNullableRecord(asNullableRecord(entry.message.details)?.media)
            ?.localMediaReplayAuthorized,
        ];
      });
      expect(deniedRun).toBe(guarded);
      expect(restoredRun).toBe(guarded);
      expect(authorizations).toEqual([false, true, false, true]);

      const ctx = {
        Body: "continue",
        RawBody: "continue",
        CommandBody: "continue",
        SessionTranscriptContext: { historyLimit: 10 },
      } as FinalizedMsgContext;
      await mergeSessionTranscriptContext({
        agentId: target.agentId,
        ctx,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
      });
      expect(ctx.InboundHistory?.map((entry) => entry.body)).toEqual([
        "inspect",
        `collision [unverified media reference removed]/generated/collision.png; exact ${exact}`,
        "recheck",
        `stale [unverified media reference removed]/generated/exact.png`,
        "restore",
        `restored ${exact}`,
      ]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
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
