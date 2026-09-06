import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  markChatAbortTerminalPersistenceError,
  waitForChatAbortControllerRemoval,
} from "./chat-abort-lifecycle-internal.js";
import {
  abortChatRunById,
  registerChatAbortController,
  removeChatAbortControllerEntry,
} from "./chat-abort.js";
import type { ChatAbortControllerEntry } from "./chat-abort.types.js";
import { createChatRunState } from "./server-chat-state.js";

function registeredRun() {
  const entries = new Map<string, ChatAbortControllerEntry>();
  const runId = "terminal-drain";
  const registration = registerChatAbortController({
    chatAbortControllers: entries,
    runId,
    sessionId: "terminal-session",
    sessionKey: "agent:main:terminal",
    timeoutMs: 60_000,
  });
  const entry = registration.entry;
  if (!entry) {
    throw new Error("Expected a registered run");
  }
  const drain = () =>
    waitForChatAbortControllerRemoval({
      entries,
      targets: [{ runId, entry }],
      timeoutMs: 1_000,
    });
  return { entries, runId, entry, registration, drain };
}

it.each(
  ["settled", "pending", "writing", "failed"].flatMap((state) =>
    [false, true].map((alreadyRemoved) => ({ state, alreadyRemoved })),
  ),
)(
  "checks $state terminal ownership when alreadyRemoved=$alreadyRemoved",
  async ({ state, alreadyRemoved }) => {
    const { entries, runId, entry, drain } = registeredRun();
    if (state === "pending") {
      entry.projectSessionTerminalPending = true;
    } else if (state === "writing") {
      entry.projectSessionTerminalPersistence = new Promise<void>(() => {});
    } else if (state === "failed") {
      markChatAbortTerminalPersistenceError(entry, new Error("terminal write failed"));
    }
    if (alreadyRemoved) {
      removeChatAbortControllerEntry(entries, runId, entry);
    }
    const result = drain();
    removeChatAbortControllerEntry(entries, runId, entry);
    expect(await result).toBe(state === "settled");
  },
);

it("finishes an empty selection without draining unrelated registrations", async () => {
  const { entries, runId } = registeredRun();
  expect(await waitForChatAbortControllerRemoval({ entries, targets: [], timeoutMs: 1_000 })).toBe(
    true,
  );
  expect(entries.has(runId)).toBe(true);
});

it("releases the reserved terminal owner when no lifecycle subscriber adopts it", async () => {
  const { entries, runId, entry, drain } = registeredRun();
  const result = drain();
  expect(
    abortChatRunById(
      {
        chatAbortControllers: entries,
        chatRunState: createChatRunState(),
        removeChatRun: () => undefined,
        agentRunSeq: new Map(),
        broadcast: () => {},
        nodeSendToSession: () => {},
      },
      { runId, sessionKey: entry.sessionKey },
    ),
  ).toEqual({ aborted: true });
  expect(await result).toBe(true);
  expect(entries.has(runId)).toBe(false);
});

it.each(["fulfilled", "rejected"] as const)(
  "drains a promise-only registration after it is %s",
  async (outcome) => {
    const { entries, runId, entry, registration, drain } = registeredRun();
    const persistence = createDeferred();
    entry.projectSessionTerminalPersistence = persistence.promise;
    const result = drain();
    registration.cleanup();
    expect(entries.get(runId)).toBe(entry);
    if (outcome === "fulfilled") {
      persistence.resolve();
    } else {
      persistence.reject(new Error("terminal write failed"));
    }
    expect(await result).toBe(outcome === "fulfilled");
    expect(entries.has(runId)).toBe(false);
  },
);

it.each(["fulfilled", "rejected"] as const)(
  "does not retire a replacement persistence owner when an older write is %s",
  async (outcome) => {
    const { entries, runId, entry, registration, drain } = registeredRun();
    const previous = createDeferred();
    const current = createDeferred();
    entry.projectSessionTerminalPersistence = previous.promise;
    registration.cleanup();
    entry.projectSessionTerminalPersistence = current.promise;
    if (outcome === "fulfilled") {
      previous.resolve();
    } else {
      previous.reject(new Error("older terminal write failed"));
    }
    await previous.promise.catch(() => {});
    await Promise.resolve();
    expect(entries.get(runId)).toBe(entry);
    const result = drain();
    registration.cleanup();
    current.resolve();
    expect(await result).toBe(true);
  },
);
