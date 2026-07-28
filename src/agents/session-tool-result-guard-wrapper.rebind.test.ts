// Covers per-attempt guard state rebinding when a caller-owned SessionManager
// is reused across run attempts (auth/model fallback retries). Re-guarding must
// honor the new attempt's suppression flag and callbacks instead of keeping the
// first attempt's captured state, which would duplicate the user turn and
// notify stale prompt state.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it, vi } from "vitest";
import { resolveLiveToolResultMaxChars } from "./embedded-agent-runner/tool-result-truncation.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

function assistantToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "n", arguments: {} }],
  } as AgentMessage;
}

function toolResult(id: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "n",
    content: [{ type: "text", text }],
    isError: false,
  } as AgentMessage;
}

function persistedRoles(sm: SessionManager): string[] {
  return sm
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => ((entry as { message: AgentMessage }).message as { role: string }).role);
}

function persistedToolResultTexts(sm: SessionManager): string[] {
  return sm
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: AgentMessage }).message)
    .filter((message) => (message as { role?: string }).role === "toolResult")
    .map((message) =>
      ((message as { content?: Array<{ text?: string }> }).content ?? [])
        .map((block) => block.text ?? "")
        .join(""),
    );
}

async function flushAsyncCallbacks(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("guardSessionManager attempt rebinding", () => {
  it("returns the same guarded instance when re-guarding", () => {
    const first = guardSessionManager(SessionManager.inMemory());
    const second = guardSessionManager(first);
    expect(second).toBe(first);
  });

  it("honors the retry attempt's persistence suppression instead of duplicating the user turn", async () => {
    const firstAttemptPersisted = vi.fn();
    const firstAttemptSuppressed = vi.fn();
    const sm = guardSessionManager(SessionManager.inMemory(), {
      onUserMessagePersisted: firstAttemptPersisted,
      onUserMessagePersistenceSuppressed: firstAttemptSuppressed,
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(userMessage("prompt"));
    await flushAsyncCallbacks();
    expect(persistedRoles(sm)).toEqual(["user"]);
    expect(firstAttemptPersisted).toHaveBeenCalledTimes(1);

    // Second attempt reuses the caller-owned manager: the user turn is already
    // persisted, so normalization requests suppression for the retry.
    const retryAttemptPersisted = vi.fn();
    const retryAttemptSuppressed = vi.fn();
    const reguarded = guardSessionManager(sm, {
      suppressNextUserMessagePersistence: true,
      onUserMessagePersisted: retryAttemptPersisted,
      onUserMessagePersistenceSuppressed: retryAttemptSuppressed,
    });
    expect(reguarded).toBe(sm);

    appendMessage(userMessage("prompt"));
    await flushAsyncCallbacks();

    expect(persistedRoles(sm)).toEqual(["user"]);
    expect(retryAttemptSuppressed).toHaveBeenCalledTimes(1);
    expect(retryAttemptPersisted).not.toHaveBeenCalled();
    // The first attempt's callbacks must not observe the retry.
    expect(firstAttemptPersisted).toHaveBeenCalledTimes(1);
    expect(firstAttemptSuppressed).not.toHaveBeenCalled();
  });

  it("clears stale suppression when the retry attempt does not request it", async () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      suppressNextUserMessagePersistence: true,
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    const retryAttemptPersisted = vi.fn();
    guardSessionManager(sm, {
      onUserMessagePersisted: retryAttemptPersisted,
    });

    appendMessage(userMessage("prompt"));
    await flushAsyncCallbacks();

    expect(persistedRoles(sm)).toEqual(["user"]);
    expect(retryAttemptPersisted).toHaveBeenCalledTimes(1);
  });

  it("notifies the retry attempt's preparing callback instead of the first attempt's", () => {
    const firstAttemptPreparing = vi.fn();
    const sm = guardSessionManager(SessionManager.inMemory(), {
      onUserMessagePreparingForPersistence: firstAttemptPreparing,
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    const retryAttemptPreparing = vi.fn();
    guardSessionManager(sm, {
      onUserMessagePreparingForPersistence: retryAttemptPreparing,
    });

    appendMessage(userMessage("prompt"));

    expect(retryAttemptPreparing).toHaveBeenCalledTimes(1);
    expect(firstAttemptPreparing).not.toHaveBeenCalled();
  });

  it("applies the retry attempt's smaller tool-result cap after rebinding", () => {
    const oversized = "x".repeat(20_000);
    const sm = guardSessionManager(SessionManager.inMemory(), {
      contextWindowTokens: 200_000,
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(assistantToolCall("call_1"));
    appendMessage(toolResult("call_1", oversized));

    // Retry attempt falls back to a model with a much smaller context window.
    guardSessionManager(sm, { contextWindowTokens: 4_000 });
    appendMessage(assistantToolCall("call_2"));
    appendMessage(toolResult("call_2", oversized));

    const texts = persistedToolResultTexts(sm);
    expect(texts).toHaveLength(2);
    // The first attempt's large-window cap keeps the payload intact.
    expect(texts[0]).toBe(oversized);
    // The rebound guard must enforce the retry attempt's smaller cap instead
    // of the limit captured when the guard was first installed.
    const retryCap = resolveLiveToolResultMaxChars({ contextWindowTokens: 4_000 });
    expect(retryCap).toBeLessThan(oversized.length);
    expect(texts[1]).not.toBe(oversized);
    expect(texts[1]?.length ?? 0).toBeLessThanOrEqual(retryCap + 500);
  });
});
