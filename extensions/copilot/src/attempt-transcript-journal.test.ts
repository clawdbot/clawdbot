import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionEvent } from "@github/copilot-sdk";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  readSessionTranscriptEvents,
  type SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAttemptTranscriptJournal } from "./attempt-transcript-journal.js";
import type { AttemptParamsLike } from "./attempt-types.js";
import { attachEventBridge, type SessionLike } from "./event-bridge.js";

const tempDirs: string[] = [];

type FakeSession = SessionLike & {
  emit: (event: SessionEvent) => void;
};

function createFakeSession(): FakeSession {
  const listeners = new Map<string, Array<(event: SessionEvent) => void>>();
  return {
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    emit(event) {
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event);
      }
    },
    on: vi.fn((eventType: string, handler: (event: SessionEvent) => void) => {
      listeners.set(eventType, [...(listeners.get(eventType) ?? []), handler]);
    }) as FakeSession["on"],
    sendAndWait: vi.fn(async () => undefined),
    sessionId: "sdk-session",
  };
}

function event(
  type: string,
  id: string,
  data: Record<string, unknown>,
  agentId?: string,
): SessionEvent {
  return {
    type,
    id,
    parentId: null,
    timestamp: "2026-07-26T12:00:00.000Z",
    data,
    ...(agentId ? { agentId } : {}),
  } as SessionEvent;
}

async function createFixture(trigger?: string) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-copilot-journal-"));
  tempDirs.push(tempDir);
  const target: SessionTranscriptTargetParams = {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    storePath: path.join(tempDir, "sessions.json"),
  };
  const userMessage = {
    role: "user",
    content: "inspect both files",
    timestamp: 1,
  } as const;
  let blocked = false;
  let persisted = false;
  const recorder = {
    message: userMessage,
    resolveMessage: vi.fn(async () => userMessage),
    markRuntimePersistencePending: vi.fn(),
    markRuntimePersisted: vi.fn(() => {
      persisted = true;
    }),
    markBlocked: vi.fn(() => {
      blocked = true;
    }),
    hasPersisted: () => persisted,
    isBlocked: () => blocked,
    hasRuntimePersistencePending: () => false,
    waitForRuntimePersistence: vi.fn(async () => undefined),
    persistApproved: vi.fn(async () => undefined),
    persistBlocked: vi.fn(async () => undefined),
    persistFallback: vi.fn(async () => undefined),
  } satisfies NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]>;
  const attempt = {
    agentId: "main",
    prompt: "inspect both files",
    runId: "run-1",
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    sessionTarget: target,
    timeoutMs: 1000,
    trigger,
    userTurnTranscriptRecorder: recorder,
  } as unknown as AttemptParamsLike;
  const session = createFakeSession();
  const journal = createAttemptTranscriptJournal({
    abortSession: () => session.abort(),
    attempt,
    messages: [],
    sdkSessionId: "sdk-session",
  });
  const bridge = attachEventBridge(session, {
    getSdkSessionId: () => "sdk-session",
    isAborted: () => false,
    transcriptProjection: {
      journal,
      modelRef: { api: "openai-responses", id: "gpt-5", provider: "github-copilot" },
      now: () => 2,
    },
  });
  return { attempt, bridge, journal, recorder, session, target, tempDir };
}

function transcriptMessages(events: unknown[]) {
  return events.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") {
      return [];
    }
    const record = entry as {
      id: string;
      parentId: string | null;
      message: AgentMessage & { display?: boolean; idempotencyKey?: string };
    };
    return [record];
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("Copilot attempt transcript journal", () => {
  it("commits a hidden tool turn to SQLite in assistant request order", async () => {
    const { bridge, journal, recorder, session, target, tempDir } = await createFixture("memory");
    await journal.persistInitialUser();
    expect(recorder.markRuntimePersisted).toHaveBeenCalledOnce();

    const initialUser = event("user.message", "sdk-user", { content: "inspect both files" });
    session.emit(initialUser);
    session.emit(
      event("assistant.usage", "prior-usage", {
        apiCallId: "prior-call",
        inputTokens: 50,
        model: "gpt-5",
        outputTokens: 40,
      }),
    );
    const toolAssistant = event("assistant.message", "assistant-tools", {
      content: "checking",
      messageId: "assistant-tools-message",
      model: "gpt-5",
      toolRequests: [
        { arguments: { path: "a" }, name: "read", toolCallId: "call-a" },
        { arguments: { path: "b" }, name: "read", toolCallId: "call-b" },
      ],
    });
    session.emit(toolAssistant);
    session.emit(
      event("tool.execution_start", "start-a", { toolCallId: "call-a", toolName: "read" }),
    );
    session.emit(
      event("tool.execution_start", "start-b", { toolCallId: "call-b", toolName: "read" }),
    );
    session.emit(
      event("tool.execution_complete", "result-b", {
        result: { content: "B", detailedContent: "details B" },
        success: true,
        toolCallId: "call-b",
      }),
    );
    session.emit(
      event("user.message", "steering-user", {
        content: "steer after tools",
        delivery: "steering",
        source: "future-steering-source",
      }),
    );
    session.emit(
      event(
        "tool.execution_complete",
        "result-child",
        {
          result: { content: "child" },
          success: true,
          toolCallId: "child-call",
        },
        "child-1",
      ),
    );
    session.emit({
      ...event("tool.execution_complete", "ephemeral-result-a", {
        result: { content: "transient" },
        success: true,
        toolCallId: "call-a",
      }),
      ephemeral: true,
    } as SessionEvent);
    session.emit(
      event("tool.execution_complete", "result-a", {
        error: { message: "A failed" },
        success: false,
        toolCallId: "call-a",
      }),
    );
    const finalAssistant = event("assistant.message", "assistant-final", {
      content: "finished",
      messageId: "assistant-final-message",
      model: "gpt-5",
    });
    session.emit(finalAssistant);
    bridge.recordSendResult(finalAssistant);
    session.emit(event("session.idle", "idle", {}));
    await journal.barrier("test");

    const rows = transcriptMessages(await readSessionTranscriptEvents(target));
    expect(rows.map((row) => row.message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "user",
      "assistant",
    ]);
    expect(rows.map((row) => row.id).slice(1)).toEqual([
      "assistant-tools",
      "result-a",
      "result-b",
      "steering-user",
      "assistant-final",
    ]);
    expect(rows.map((row) => row.parentId).slice(1)).toEqual(
      rows.map((row) => row.id).slice(0, -1),
    );
    expect(rows.every((row) => row.message.display === false)).toBe(true);
    expect(rows[0]?.message.idempotencyKey).toBe("run-1:user");
    expect(rows[1]?.message).toMatchObject({ usage: { input: 0, output: 0 } });
    expect(rows[5]?.message).toMatchObject({
      content: [{ type: "text", text: "finished" }],
    });
    expect(rows[5]?.message.idempotencyKey).toBe("copilot-sdk:sdk-session:assistant-final");
    expect(rows[2]?.message).toMatchObject({
      isError: true,
      toolCallId: "call-a",
      content: [{ type: "text", text: "A failed" }],
    });
    expect(journal.snapshot()).toMatchObject({
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "copilot-sdk:sdk-session:assistant-final",
      replayInvalid: false,
    });
    expect(journal.snapshot().messagesSnapshot.map((message) => message.role)).toEqual(
      rows.map((row) => row.message.role),
    );
    const files = await fs.readdir(tempDir, { recursive: true });
    expect(files.some((file) => file.endsWith(".jsonl"))).toBe(false);
  });

  it("hides autopilot users while preserving unknown SDK source provenance", async () => {
    const { journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
    session.emit(
      event("user.message", "autopilot-user", {
        content: "continue",
        attachments: [
          {
            type: "file",
            displayName: "notes.txt",
            mimeType: "text/plain",
            path: "/tmp/notes.txt",
          },
          {
            type: "blob",
            data: "c2VjcmV0LWJ5dGVz",
            displayName: "image.png",
            mimeType: "image/png",
          },
        ],
        isAutopilotContinuation: true,
        source: "future-source-kind",
      }),
    );
    session.emit(
      event("tool.execution_complete", "user-tool-result", {
        isUserRequested: true,
        result: { content: "user tool result" },
        success: true,
        toolCallId: "user-call",
      }),
    );
    session.emit(
      event("user.message", "skill-user", {
        content: "injected skill context",
        source: "skill-pdf",
      }),
    );
    session.emit(
      event("user.message", "unknown-user", {
        content: "unknown source context",
        source: "future-visible-source",
      }),
    );
    await journal.barrier("test");

    const rows = transcriptMessages(await readSessionTranscriptEvents(target));
    expect(rows).toHaveLength(4);
    expect(rows[1]?.message).toMatchObject({
      role: "user",
      content: "continue",
      display: false,
      __openclaw: {
        copilotSource: "future-source-kind",
        media: [{ path: "/tmp/notes.txt", contentType: "text/plain" }],
        copilotAttachments: [
          expect.objectContaining({ type: "file", path: "/tmp/notes.txt" }),
          expect.not.objectContaining({ data: expect.anything() }),
        ],
      },
    });
    expect(rows[2]?.message).toMatchObject({ display: false });
    expect(rows[3]?.message).not.toHaveProperty("display", false);
    expect(rows[3]?.message).toMatchObject({
      __openclaw: { copilotSource: "future-visible-source" },
    });
    expect(journal.snapshot().replayInvalid).toBe(true);
  });
});
