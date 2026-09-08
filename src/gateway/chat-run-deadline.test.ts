// Guards on per-attempt run-deadline renewal.
import { describe, expect, it } from "vitest";
import {
  registerChatAbortController,
  removeChatAbortControllerEntry,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";
import { renewChatRunExecutionDeadline } from "./chat-run-deadline.js";

const TIMEOUT_MS = 120_000;
const RUN_ID = "run-1";

function register(entries: Map<string, ChatAbortControllerEntry>, now: number) {
  return registerChatAbortController({
    chatAbortControllers: entries,
    runId: RUN_ID,
    sessionId: "session-1",
    sessionKey: "agent:main",
    timeoutMs: TIMEOUT_MS,
    kind: "chat-send",
    now,
  });
}

function renew(
  entries: Map<string, ChatAbortControllerEntry>,
  controller: AbortController,
  now: number,
) {
  return renewChatRunExecutionDeadline({
    entries,
    runId: RUN_ID,
    controller,
    timeoutMs: TIMEOUT_MS,
    now,
  });
}

describe("renewChatRunExecutionDeadline", () => {
  it("extends an executing run's deadline", () => {
    const entries = new Map<string, ChatAbortControllerEntry>();
    const now = Date.now();
    const registration = register(entries, now);
    registration.markExecutionStarted();
    const before = entries.get(RUN_ID)?.expiresAtMs ?? 0;

    expect(renew(entries, registration.controller, now + TIMEOUT_MS)).toBe(true);
    expect(entries.get(RUN_ID)?.expiresAtMs ?? 0).toBeGreaterThan(before);
  });

  it("declines before execution starts", () => {
    const entries = new Map<string, ChatAbortControllerEntry>();
    const now = Date.now();
    const registration = register(entries, now);

    expect(renew(entries, registration.controller, now)).toBe(false);
  });

  it("declines once the run is aborted", () => {
    const entries = new Map<string, ChatAbortControllerEntry>();
    const now = Date.now();
    const registration = register(entries, now);
    registration.markExecutionStarted();
    registration.controller.abort();

    expect(renew(entries, registration.controller, now)).toBe(false);
  });

  it("never revives a run the deadline sweep has already condemned", () => {
    const entries = new Map<string, ChatAbortControllerEntry>();
    const now = Date.now();
    const registration = register(entries, now);
    registration.markExecutionStarted();
    const expired = (entries.get(RUN_ID)?.expiresAtMs ?? 0) + 1;

    expect(renew(entries, registration.controller, expired)).toBe(false);
  });

  it("never shortens a deadline", () => {
    const entries = new Map<string, ChatAbortControllerEntry>();
    const now = Date.now();
    const registration = register(entries, now);
    registration.markExecutionStarted();
    const before = entries.get(RUN_ID)?.expiresAtMs ?? 0;

    expect(renew(entries, registration.controller, now)).toBe(false);
    expect(entries.get(RUN_ID)?.expiresAtMs ?? 0).toBe(before);
  });

  it("declines for a superseded or removed registration", () => {
    const entries = new Map<string, ChatAbortControllerEntry>();
    const now = Date.now();
    const registration = register(entries, now);
    registration.markExecutionStarted();
    removeChatAbortControllerEntry(entries, RUN_ID);

    expect(renew(entries, registration.controller, now + TIMEOUT_MS)).toBe(false);
  });
});
