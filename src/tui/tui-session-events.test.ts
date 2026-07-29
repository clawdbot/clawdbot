// Verifies canonical and provider-owned TUI session event routing.
import { describe, expect, it } from "vitest";
import { matchesSelectedTuiSession, readTuiSessionUserMessage } from "./tui-session-events.js";
import type { SessionMessageEvent, TuiStateAccess } from "./tui-types.js";

function makeState(overrides?: Partial<TuiStateAccess>): TuiStateAccess {
  return {
    agentDefaultId: "main",
    sessionMainKey: "agent:main:main",
    sessionScope: "global",
    agents: [],
    currentAgentId: "main",
    currentSessionKey: "agent:main:main",
    currentSessionId: "session-main",
    activeChatRunId: null,
    pendingSubmit: null,
    historyLoaded: true,
    sessionInfo: {},
    initialSessionApplied: true,
    isConnected: true,
    autoMessageSent: false,
    toolsExpanded: false,
    showThinking: false,
    connectionStatus: "connected",
    activityStatus: "idle",
    statusTimeout: null,
    lastCtrlCAt: 0,
    ...overrides,
  };
}

describe("matchesSelectedTuiSession", () => {
  it("accepts a selected canonical session and its request-key alias", () => {
    const state = makeState();

    expect(matchesSelectedTuiSession(state, { sessionKey: "agent:main:main" })).toBe(true);
    expect(matchesSelectedTuiSession(state, { sessionKey: "main" })).toBe(true);
  });

  it("rejects the same request key when owned by another canonical agent", () => {
    expect(matchesSelectedTuiSession(makeState(), { sessionKey: "agent:other:main" })).toBe(false);
  });

  it.each([
    {
      provider: "Matrix",
      selectedSessionKey: "agent:main:matrix:channel:!MixedRoom:example.org",
      otherSessionKey: "agent:main:matrix:channel:!mixedroom:example.org",
    },
    {
      provider: "Signal",
      selectedSessionKey: "agent:main:signal:group:AbC123=",
      otherSessionKey: "agent:main:signal:group:abc123=",
    },
  ])(
    "preserves case-sensitive $provider conversation ownership",
    ({ selectedSessionKey, otherSessionKey }) => {
      const state = makeState({ currentSessionKey: selectedSessionKey });

      expect(matchesSelectedTuiSession(state, { sessionKey: selectedSessionKey })).toBe(true);
      expect(matchesSelectedTuiSession(state, { sessionKey: otherSessionKey })).toBe(false);
    },
  );

  it("requires global session events to belong to the selected agent", () => {
    const state = makeState({ currentAgentId: "work", currentSessionKey: "global" });

    expect(matchesSelectedTuiSession(state, { sessionKey: "global", agentId: "work" })).toBe(true);
    expect(matchesSelectedTuiSession(state, { sessionKey: "global", agentId: "main" })).toBe(false);
    expect(matchesSelectedTuiSession(state, { sessionKey: "global" })).toBe(false);
  });

  it("accepts legacy global events only for the default agent", () => {
    expect(
      matchesSelectedTuiSession(makeState({ currentSessionKey: "global" }), {
        sessionKey: "global",
      }),
    ).toBe(true);
  });

  it("guards explicit owner claims on unscoped transcript aliases", () => {
    const state = makeState({ currentAgentId: "work", currentSessionKey: "agent:work:main" });

    expect(
      matchesSelectedTuiSession(
        state,
        { sessionKey: "main", agentId: "work" },
        { requireAliasOwnership: true },
      ),
    ).toBe(true);
    expect(
      matchesSelectedTuiSession(
        state,
        { sessionKey: "main", agentId: "main" },
        { requireAliasOwnership: true },
      ),
    ).toBe(false);
    expect(
      matchesSelectedTuiSession(state, { sessionKey: "main" }, { requireAliasOwnership: true }),
    ).toBe(false);
  });

  it("rejects empty and unrelated session events", () => {
    const state = makeState();

    expect(matchesSelectedTuiSession(state, {})).toBe(false);
    expect(matchesSelectedTuiSession(state, { sessionKey: "  " })).toBe(false);
    expect(matchesSelectedTuiSession(state, { sessionKey: "agent:main:other" })).toBe(false);
  });
});

describe("readTuiSessionUserMessage", () => {
  it.each([
    {
      name: "image block",
      content: [{ type: "image", source: { type: "url", url: "/image.png" } }],
      media: undefined,
      expected: "Attached image",
    },
    {
      name: "document block",
      content: [
        {
          type: "attachment",
          attachment: { url: "/report.pdf", kind: "document", label: "report.pdf" },
        },
      ],
      media: undefined,
      expected: "Attached file: report.pdf",
    },
    {
      name: "canonical persisted media",
      content: "",
      media: [{ path: "/media/inbound/image.png", contentType: "image/png" }],
      expected: "Attached image",
    },
  ])("accepts an authoritative attachment-only $name event", ({ content, media, expected }) => {
    expect(
      readTuiSessionUserMessage({
        sessionKey: "agent:main:main",
        messageId: "attachment-user-1",
        message: {
          role: "user",
          content,
          __openclaw: {
            id: "attachment-user-1",
            idempotencyKey: "attachment-run-1:user",
            seq: 1,
            ...(media ? { media } : {}),
          },
        },
      } satisfies SessionMessageEvent),
    ).toEqual({
      messageId: "attachment-user-1",
      runId: "attachment-run-1",
      text: expected,
    });
  });

  it("recovers the durable prompt identity and owning chat run", () => {
    expect(
      readTuiSessionUserMessage({
        sessionKey: "agent:main:main",
        messageId: "user-1",
        message: {
          __openclaw: { id: "user-1", idempotencyKey: "run-1:user", seq: 1 },
          content: [{ type: "text", text: "shared prompt" }],
          role: "user",
        },
      } satisfies SessionMessageEvent),
    ).toEqual({ messageId: "user-1", runId: "run-1", text: "shared prompt" });
  });

  it("prefers persisted identity when a Gateway envelope names a different message and run", () => {
    expect(
      readTuiSessionUserMessage({
        clientRunId: "another-client-run",
        messageId: "another-client-message",
        messageSeq: 99,
        message: {
          role: "user",
          content: "authoritative persisted prompt",
          __openclaw: {
            id: "persisted-message",
            idempotencyKey: "persisted-run:user",
            seq: 7,
          },
        },
      } satisfies SessionMessageEvent),
    ).toEqual({
      messageId: "persisted-message",
      runId: "persisted-run",
      text: "authoritative persisted prompt",
    });
  });

  it("prefers persisted sequence over a conflicting Gateway envelope without a message ID", () => {
    expect(
      readTuiSessionUserMessage({
        messageSeq: 99,
        message: {
          role: "user",
          content: "sequenced persisted prompt",
          __openclaw: { seq: 7 },
        },
      }),
    ).toEqual({ messageId: "seq:7", text: "sequenced persisted prompt" });
  });

  it("normalizes exactly one persisted user-turn suffix", () => {
    expect(
      readTuiSessionUserMessage({
        clientRunId: "another-client-run",
        message: {
          role: "user",
          content: "nested user suffix",
          __openclaw: { id: "persisted-message", idempotencyKey: "actual:user:user" },
        },
      }),
    ).toEqual({
      messageId: "persisted-message",
      runId: "actual:user",
      text: "nested user suffix",
    });
  });

  it("keys imported messages by their complete provider and CLI session identity", () => {
    const readImportedMessage = (cliSessionId: string) =>
      readTuiSessionUserMessage({
        messageId: "native-or-other-provider-id",
        message: {
          role: "user",
          content: "imported prompt",
          __openclaw: {
            id: "provider-local-id",
            importedFrom: "claude-cli",
            cliSessionId,
            externalId: "provider-local-id",
          },
        },
      });

    expect(readImportedMessage("cli-session-1")).toEqual({
      messageId: `external:${JSON.stringify(["claude-cli", "cli-session-1", "provider-local-id"])}`,
      text: "imported prompt",
    });
    expect(readImportedMessage("cli-session-2")?.messageId).not.toBe(
      readImportedMessage("cli-session-1")?.messageId,
    );
  });

  it("uses the persisted transcript position for an incomplete imported identity", () => {
    expect(
      readTuiSessionUserMessage({
        messageId: "native-message",
        messageSeq: 99,
        message: {
          role: "user",
          content: "partially imported prompt",
          __openclaw: {
            id: "provider-local-id",
            importedFrom: "claude-cli",
            externalId: "provider-local-id",
            seq: 7,
          },
        },
      }),
    ).toEqual({ messageId: "imported-seq:7", text: "partially imported prompt" });
  });

  it("keeps distinct incomplete imports with the same provider-local ID separate", () => {
    const readImportedMessage = (seq: number) =>
      readTuiSessionUserMessage({
        message: {
          role: "user",
          content: `partially imported prompt ${seq}`,
          __openclaw: {
            id: "shared-provider-local-id",
            importedFrom: "claude-cli",
            seq,
          },
        },
      });

    expect(readImportedMessage(7)?.messageId).toBe("imported-seq:7");
    expect(readImportedMessage(8)?.messageId).toBe("imported-seq:8");
  });

  it("does not use envelope sequence to deduplicate incomplete imported ownership", () => {
    expect(
      readTuiSessionUserMessage({
        messageId: "native-message",
        messageSeq: 7,
        message: {
          role: "user",
          content: "imported prompt",
          __openclaw: {
            id: "provider-local-id",
            importedFrom: "claude-cli",
            externalId: "provider-local-id",
          },
        },
      }),
    ).toBeNull();
  });

  it("does not deduplicate imported messages without complete ownership or a persisted position", () => {
    expect(
      readTuiSessionUserMessage({
        messageId: "native-message",
        message: {
          role: "user",
          content: "imported prompt",
          __openclaw: {
            id: "provider-local-id",
            importedFrom: "claude-cli",
            externalId: "provider-local-id",
          },
        },
      }),
    ).toBeNull();
  });

  it("uses the authoritative transcript sequence when no message id is available", () => {
    expect(
      readTuiSessionUserMessage({
        messageSeq: 7,
        message: { content: "shared prompt", idempotencyKey: "run-7:user", role: "user" },
      }),
    ).toEqual({ messageId: "seq:7", runId: "run-7", text: "shared prompt" });
  });

  it("recovers the owning chat run from a metadata-free gateway envelope", () => {
    expect(
      readTuiSessionUserMessage({
        clientRunId: "run-envelope",
        messageId: "user-envelope",
        message: { content: "shared prompt", role: "user" },
      } satisfies SessionMessageEvent),
    ).toEqual({ messageId: "user-envelope", runId: "run-envelope", text: "shared prompt" });
  });

  it("rejects assistant and identity-free transcript messages", () => {
    expect(
      readTuiSessionUserMessage({
        messageId: "assistant-1",
        message: { content: "reply", role: "assistant" },
      }),
    ).toBeNull();
    expect(
      readTuiSessionUserMessage({ message: { content: "unidentified", role: "user" } }),
    ).toBeNull();
  });
});
