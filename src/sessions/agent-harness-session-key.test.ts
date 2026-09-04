import { describe, expect, it } from "vitest";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  MODEL_SELECTION_LOCK_REMOVAL_MESSAGE,
  isAgentHarnessSessionKey,
  isAgentHarnessSessionKeyOwnedBy,
  isValidAgentHarnessSessionStoreEntry,
  resolveAgentHarnessSessionIdMismatchError,
  resolveAgentHarnessSessionContextError,
  resolveAgentHarnessSessionStoreEntryError,
  resolveAgentHarnessSessionStoreTransitionError,
  resolveMissingAgentHarnessSessionError,
  resolveSessionPinnedHarnessId,
} from "./agent-harness-session-key.js";

describe("agent harness session keys", () => {
  it.each([
    "harness:codex:supervision:native-thread",
    "agent:main:harness:codex:supervision:native-thread",
  ])("recognizes the reserved namespace for %s", (sessionKey) => {
    expect(isAgentHarnessSessionKey(sessionKey)).toBe(true);
    expect(resolveMissingAgentHarnessSessionError(sessionKey, undefined)).toMatch(/reserved/i);
    expect(resolveMissingAgentHarnessSessionError(sessionKey, { sessionId: "existing" })).toBe(
      undefined,
    );
  });

  it("ties trusted creation to the matching persisted harness owner", () => {
    const key = "agent:main:harness:codex:supervision:native-thread";
    expect(isAgentHarnessSessionKeyOwnedBy(key, "codex")).toBe(true);
    expect(isAgentHarnessSessionKeyOwnedBy(key, "CODEX-APP-SERVER")).toBe(true);
    expect(isAgentHarnessSessionKeyOwnedBy(key, "other")).toBe(false);
    expect(isAgentHarnessSessionKeyOwnedBy("agent:main:ordinary", "codex")).toBe(false);
  });

  it("compares the exact owner segment instead of an owner-id prefix", () => {
    const key = "agent:main:harness:foo:bar:native-thread";
    expect(isAgentHarnessSessionKeyOwnedBy(key, "foo")).toBe(true);
    expect(isAgentHarnessSessionKeyOwnedBy(key, "foo:bar")).toBe(false);
    expect(
      resolveAgentHarnessSessionStoreEntryError(key, {
        agentHarnessId: "foo:bar",
        modelSelectionLocked: true,
        sessionId: "native-session",
      }),
    ).toBe(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
    expect(
      resolveAgentHarnessSessionStoreEntryError(key, {
        agentHarnessId: "foo",
        modelSelectionLocked: true,
        sessionId: "native-session",
      }),
    ).toBeUndefined();
  });

  it("validates durable lock metadata for reserved and ordinary rows", () => {
    const key = "agent:main:harness:codex:supervision:native-thread";
    expect(
      resolveAgentHarnessSessionStoreEntryError(key, {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      }),
    ).toBeUndefined();
    expect(
      resolveAgentHarnessSessionStoreEntryError(key, {
        agentHarnessId: "codex",
        modelSelectionLocked: false,
        sessionId: "native-session",
      }),
    ).toBeUndefined();
    expect(
      resolveAgentHarnessSessionStoreEntryError("agent:main:ordinary", {
        modelSelectionLocked: false,
      }),
    ).toBeUndefined();
    expect(
      isValidAgentHarnessSessionStoreEntry("agent:main:ordinary", {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      }),
    ).toBe(true);
    expect(
      resolveAgentHarnessSessionStoreEntryError("agent:main:ordinary", {
        modelSelectionLocked: true,
        sessionId: "native-session",
      }),
    ).toBeUndefined();
    expect(
      isValidAgentHarnessSessionStoreEntry("agent:main:ordinary", {
        modelSelectionLocked: true,
        sessionId: "native-session",
      }),
    ).toBe(false);
  });

  it("requires a valid durable row for protected reserved runtime contexts", () => {
    const key = "agent:main:harness:codex:supervision:native-thread";
    expect(resolveAgentHarnessSessionContextError(key, undefined)).toMatch(/reserved/i);
    expect(
      resolveAgentHarnessSessionContextError(key, {
        agentHarnessId: "codex",
        modelSelectionLocked: false,
        sessionId: "native-session",
      }),
    ).toBeUndefined();
    expect(
      resolveAgentHarnessSessionContextError(key, {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      }),
    ).toBe(AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE);
    expect(
      resolveAgentHarnessSessionContextError(key, {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      }),
    ).toBeUndefined();
    expect(
      resolveAgentHarnessSessionContextError("agent:main:ordinary", undefined),
    ).toBeUndefined();
  });

  it("keeps pre-existing unlocked harness-prefixed sessions ordinary", () => {
    const key = "agent:main:harness:notes";
    const entry = {
      agentHarnessId: "openclaw",
      sessionId: "legacy-session",
    };

    expect(resolveAgentHarnessSessionContextError(key, entry)).toBeUndefined();
    expect(resolveAgentHarnessSessionStoreEntryError(key, entry)).toBeUndefined();
    expect(resolveAgentHarnessSessionIdMismatchError(entry, "replacement-session")).toBeUndefined();
    expect(isValidAgentHarnessSessionStoreEntry(key, entry)).toBe(false);
  });

  it("rejects a caller-selected session id that would rotate a durable lock", () => {
    const entry = {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      sessionId: "native-session",
    };

    expect(resolveAgentHarnessSessionIdMismatchError(entry, "native-session")).toBeUndefined();
    expect(resolveAgentHarnessSessionIdMismatchError(entry, "replacement-session")).toBe(
      AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
    );
  });

  it.each([
    { label: "legacy model lock", agentHarnessId: undefined, pluginOwnerId: undefined },
    { label: "plugin runtime observation", agentHarnessId: "codex", pluginOwnerId: "model-owner" },
    { label: "plugin CLI observation", agentHarnessId: "claude-cli", pluginOwnerId: "model-owner" },
  ])("does not turn $label into harness ownership", ({ agentHarnessId, pluginOwnerId }) => {
    const entry = {
      modelSelectionLocked: true,
      sessionId: "ordinary-session",
      agentHarnessId,
      pluginOwnerId,
    };

    expect(resolveSessionPinnedHarnessId(entry)).toBeUndefined();
    expect(isValidAgentHarnessSessionStoreEntry("agent:main:ordinary", entry)).toBe(false);
    expect(resolveAgentHarnessSessionIdMismatchError(entry, "replacement-session")).toBeUndefined();
  });

  it("normalizes only an explicitly locked native harness", () => {
    const entry = { agentHarnessId: "CODEX-APP-SERVER", modelSelectionLocked: true };
    expect(resolveSessionPinnedHarnessId(entry)).toBe("codex");
    expect(
      resolveSessionPinnedHarnessId({ ...entry, modelSelectionLocked: false }),
    ).toBeUndefined();
  });

  it("allows plugin-owned observations to change without releasing the lock or identity", () => {
    const key = "agent:main:ordinary";
    const entry = {
      sessionId: "session",
      modelSelectionLocked: true,
      pluginOwnerId: "model-owner",
    };
    const before = new Map([[key, entry]]);
    const next = { ...entry, agentHarnessId: "codex" };
    expect(
      resolveAgentHarnessSessionStoreTransitionError({ before, store: { [key]: next } }),
    ).toBeUndefined();
    expect(
      resolveAgentHarnessSessionStoreTransitionError({
        before: new Map([[key, next]]),
        store: { [key]: { ...next, agentHarnessId: "claude-cli" } },
      }),
    ).toBeUndefined();
    for (const patch of [
      { pluginOwnerId: undefined },
      { pluginOwnerId: "other" },
      { modelSelectionLocked: false },
    ]) {
      expect(
        resolveAgentHarnessSessionStoreTransitionError({
          before,
          store: { [key]: { ...next, ...patch } },
        }),
      ).toBe(MODEL_SELECTION_LOCK_REMOVAL_MESSAGE);
    }
    expect(
      resolveAgentHarnessSessionStoreTransitionError({
        before,
        store: { [key]: { ...next, sessionId: "replacement" } },
      }),
    ).toBe(AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE);
  });

  it("rejects mixed plugin ownership in the reserved native namespace", () => {
    const key = "agent:main:harness:codex:thread";
    const entry = {
      sessionId: "session",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      pluginOwnerId: "model-owner",
    };
    expect(resolveAgentHarnessSessionStoreEntryError(key, entry)).toBe(
      AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
    );
    expect(isValidAgentHarnessSessionStoreEntry(key, entry)).toBe(false);
  });
});
