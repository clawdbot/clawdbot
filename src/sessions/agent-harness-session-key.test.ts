import { describe, expect, it } from "vitest";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  isAgentHarnessSessionKeyOwnedBy,
  isValidAgentHarnessSessionStoreEntry,
  resolveAgentHarnessSessionIdMismatchError,
  resolveAgentHarnessSessionContextError,
  resolveAgentHarnessSessionStoreEntryError,
  resolveMissingAgentHarnessSessionError,
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

  it("does not turn a legacy model-selection lock into harness ownership", () => {
    const entry = {
      modelSelectionLocked: true,
      sessionId: "ordinary-session",
    };

    expect(resolveAgentHarnessSessionIdMismatchError(entry, "replacement-session")).toBeUndefined();
  });
});
