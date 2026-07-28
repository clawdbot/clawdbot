// Covers per-attempt guard state rebinding when a caller-owned SessionManager
// is reused across run attempts (auth/model fallback retries). Re-guarding must
// honor the new attempt's suppression flag and callbacks instead of keeping the
// first attempt's captured state, which would duplicate the user turn and
// notify stale prompt state.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it, vi } from "vitest";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

function persistedRoles(sm: SessionManager): string[] {
  return sm
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => ((entry as { message: AgentMessage }).message as { role: string }).role);
}

async function flushAsyncCallbacks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
});
