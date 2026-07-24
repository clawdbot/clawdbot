// Persistence-backed coverage for the `messageId` carried on terminal chat
// events. These tests drive the real `AgentSession` persistence path against a
// real `SessionManager` writing a real transcript file, then assert the id the
// session emits on `agent_end` is byte-identical to the id of the assistant
// entry actually written to disk.
//
// The gateway-level test in `server.agent.gateway-server-agent-b.test.ts` only
// proves the id is *forwarded* (it injects a synthetic lifecycle id). This file
// covers the other half: that the id is the *produced transcript id*, and that
// it stays correct across the terminal shapes a run can take — plain final,
// aborted, auto-retry, contentless, tool loops, and post-run injection.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { AgentSession, type AgentSessionEvent } from "./agent-session.js";
import { loadEntriesFromFile, SessionManager } from "./session-manager.js";

const tempPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-session-messageid-"));
  tempPaths.push(dir);
  return dir;
}

type Harness = {
  session: AgentSession;
  sessionManager: SessionManager;
  sessionFile: string;
  emitted: AgentSessionEvent[];
  handle: (event: unknown) => Promise<void>;
};

/**
 * Builds an `AgentSession` bound to a real on-disk transcript.
 *
 * Only the outward-facing collaborators are stubbed (listener fan-out, the
 * extension bus, retry settings). Everything under test — event dispatch,
 * `sessionManager.appendMessage`, and the id bookkeeping — is the real
 * implementation running against real persistence.
 */
async function makeHarness(options?: { retryable?: boolean }): Promise<Harness> {
  const dir = await makeTempDir();
  const sessionFile = path.join(dir, "session.jsonl");
  const sessionManager = SessionManager.open(sessionFile, dir, dir);
  const emitted: AgentSessionEvent[] = [];

  const session = Object.create(AgentSession.prototype) as AgentSession;
  Object.assign(session, {
    sessionManager,
    lastAssistantMessage: undefined,
    lastAssistantMessageId: undefined,
    extensionModifiedToolResultIds: new Set<string>(),
    steeringMessages: [],
    followUpMessages: [],
    overflowRecoveryAttempted: false,
    retryCount: 0,
    settingsManager: {
      getRetrySettings: () => ({
        enabled: options?.retryable === true,
        maxRetries: options?.retryable === true ? 3 : 0,
      }),
    },
    // Auto-retry classification is orthogonal to id bookkeeping; force the
    // branch so the retry test exercises a genuine `willRetry: true` terminal.
    isRetryableError: () => options?.retryable === true,
    emit: (event: AgentSessionEvent) => {
      emitted.push(event);
    },
    emitExtensionEvent: async () => false,
    emitQueueUpdate: () => {},
  });

  return {
    session,
    sessionManager,
    sessionFile,
    emitted,
    handle: (event: unknown) =>
      (
        session as unknown as { handleAgentEventUnlocked: (e: unknown) => Promise<void> }
      ).handleAgentEventUnlocked(event),
  };
}

function assistantMessage(text: string, stopReason = "stop"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
  } as unknown as AgentMessage;
}

/** Ids of the assistant messages actually persisted to the transcript file. */
function persistedAssistantIds(sessionFile: string): string[] {
  return loadEntriesFromFile(sessionFile)
    .filter(
      (entry): entry is typeof entry & { id: string; message: { role: string } } =>
        (entry as { type?: string }).type === "message" &&
        (entry as { message?: { role?: string } }).message?.role === "assistant",
    )
    .map((entry) => entry.id);
}

function terminalEvents(emitted: AgentSessionEvent[]) {
  return emitted.filter((event) => event.type === "agent_end");
}

describe("AgentSession agent_end messageId", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("carries the id of the assistant message persisted to the transcript", async () => {
    const { handle, emitted, sessionFile } = await makeHarness();
    const message = assistantMessage("hello from the agent");

    await handle({ type: "message_end", message });
    await handle({ type: "agent_end", messages: [message] });

    const [terminal] = terminalEvents(emitted);
    const persisted = persistedAssistantIds(sessionFile);

    expect(persisted).toHaveLength(1);
    // The emitted id is the transcript id, not a fresh/synthetic one.
    expect(terminal).toMatchObject({ lastAssistantMessageId: persisted[0] });
  });

  it("carries the persisted id on an aborted run that still produced a message", async () => {
    const { handle, emitted, sessionFile } = await makeHarness();
    const message = assistantMessage("partial answer", "aborted");

    await handle({ type: "message_end", message });
    await handle({ type: "agent_end", messages: [message] });

    const [terminal] = terminalEvents(emitted);
    expect(terminal).toMatchObject({
      willRetry: false,
      lastAssistantMessageId: persistedAssistantIds(sessionFile)[0],
    });
  });

  it("omits messageId entirely for a contentless run", async () => {
    const { handle, emitted, sessionFile } = await makeHarness();

    // No assistant message_end: the run ended without producing a message.
    await handle({ type: "agent_end", messages: [] });

    const [terminal] = terminalEvents(emitted);
    expect(persistedAssistantIds(sessionFile)).toEqual([]);
    // Absent rather than empty/stale, so clients can't dedup on a bogus id.
    expect(terminal).not.toHaveProperty("lastAssistantMessageId");
  });

  it("reports the final assistant message of a tool loop, not the first or the tool result", async () => {
    const { handle, emitted, sessionFile } = await makeHarness();
    const toolCall = assistantMessage("calling a tool", "toolUse");
    const toolResult = {
      role: "toolResult",
      toolCallId: "call-1",
      content: "tool output",
    } as unknown as AgentMessage;
    const finalAnswer = assistantMessage("answer after the tool");

    await handle({ type: "message_end", message: toolCall });
    await handle({ type: "message_end", message: toolResult });
    await handle({ type: "message_end", message: finalAnswer });
    await handle({ type: "agent_end", messages: [toolCall, toolResult, finalAnswer] });

    const persisted = persistedAssistantIds(sessionFile);
    expect(persisted).toHaveLength(2);

    const [terminal] = terminalEvents(emitted);
    const reported = (terminal as { lastAssistantMessageId?: string }).lastAssistantMessageId;
    expect(reported).toBe(persisted[1]);
    expect(reported).not.toBe(persisted[0]);
  });

  it("tracks the newest assistant message across an auto-retry within one run", async () => {
    const { handle, emitted, sessionFile } = await makeHarness({ retryable: true });
    const failed = assistantMessage("transient failure", "error");
    const retried = assistantMessage("answer on retry");

    await handle({ type: "message_end", message: failed });
    await handle({ type: "agent_end", messages: [failed] });
    await handle({ type: "message_end", message: retried });
    await handle({ type: "agent_end", messages: [failed, retried] });

    const persisted = persistedAssistantIds(sessionFile);
    expect(persisted).toHaveLength(2);

    const [firstTerminal, secondTerminal] = terminalEvents(emitted);
    // First terminal is the retryable one and points at the failed attempt.
    expect(firstTerminal).toMatchObject({
      willRetry: true,
      lastAssistantMessageId: persisted[0],
    });
    // The second terminal must advance to the retried message, not repeat it.
    expect(secondTerminal).toMatchObject({ lastAssistantMessageId: persisted[1] });
  });

  it("stays pinned to the produced message when another entry is appended after it", async () => {
    const { handle, emitted, sessionManager, sessionFile } = await makeHarness();
    const message = assistantMessage("the produced answer");

    await handle({ type: "message_end", message });

    // Something injects into the transcript after the assistant turn — the
    // exact case that makes "read the last transcript entry" unreliable.
    sessionManager.appendMessage({
      role: "user",
      content: "injected follow-up",
      timestamp: Date.now(),
    } as never);

    await handle({ type: "agent_end", messages: [message] });

    const entries = loadEntriesFromFile(sessionFile).filter(
      (entry) => (entry as { type?: string }).type === "message",
    );
    const lastEntryId = (entries.at(-1) as { id: string }).id;
    const assistantId = persistedAssistantIds(sessionFile)[0];

    // Precondition: the tail is no longer the assistant message.
    expect(lastEntryId).not.toBe(assistantId);

    const [terminal] = terminalEvents(emitted);
    expect(terminal).toMatchObject({ lastAssistantMessageId: assistantId });
  });
});
