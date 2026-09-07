import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, unknown>,
    entriesCalls: [] as string[],
    exactReads: [] as string[],
    openSessionEntryReadView: vi.fn((scope: { storePath?: string }) => ({
      get: (key: string) => state.rows[key],
      entries: () => {
        state.entriesCalls.push(scope.storePath ?? "");
        return Object.entries(state.rows).map(([sessionKey, entry]) => ({ sessionKey, entry }));
      },
    })),
    loadExactSessionEntryReadOnly: vi.fn((scope: { sessionKey: string }) => {
      state.exactReads.push(scope.sessionKey);
      const entry = state.rows[scope.sessionKey];
      return entry ? { sessionKey: scope.sessionKey, entry } : undefined;
    }),
  };
  return state;
});

const getChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/sessions/session-accessor.js", () => ({
  openSessionEntryReadView: store.openSessionEntryReadView,
  loadExactSessionEntryReadOnly: store.loadExactSessionEntryReadOnly,
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: (_store: unknown, opts?: { agentId?: string }) =>
    `/tmp/${opts?.agentId ?? "main"}-sessions.sqlite`,
}));

vi.mock("../../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargetsSync: () => [
    { agentId: "main", storePath: "/tmp/main-sessions.sqlite" },
    { agentId: "main", storePath: "/tmp/secondary-sessions.sqlite" },
  ],
}));

vi.mock("../../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
  getChannelPlugin: getChannelPluginMock,
}));

import { resolveEffectiveCurrentChannelContext } from "./message-tool-discovery.js";

const CANONICAL_SPACE = "spaces/AAQA1bC2dEf";
const FOLDED_SPACE = "spaces/aaqa1bc2def";
const SESSION_KEY = `agent:main:googlechat:group:${FOLDED_SPACE}`;

function seedRoutableRow() {
  store.rows[SESSION_KEY] = {
    sessionId: "s1",
    updatedAt: 1,
    delivery: {
      kind: "external",
      route: { channel: "googlechat", target: { to: `googlechat:${CANONICAL_SPACE}` } },
      context: { channel: "googlechat", to: `googlechat:${CANONICAL_SPACE}` },
      origin: { provider: "googlechat", to: `googlechat:${CANONICAL_SPACE}` },
    },
  };
}

describe("canonical destination recovery stays bounded", () => {
  beforeEach(() => {
    store.rows = {};
    store.entriesCalls = [];
    store.exactReads = [];
    store.openSessionEntryReadView.mockClear();
    store.loadExactSessionEntryReadOnly.mockClear();
    getChannelPluginMock.mockReset();
    getChannelPluginMock.mockReturnValue({
      config: { listAccountIds: () => ["default"] },
      messaging: { targetIdComparison: "case-sensitive" },
    });
  });

  it("recovers the canonical casing without enumerating the store", () => {
    seedRoutableRow();

    const result = resolveEffectiveCurrentChannelContext(
      {
        currentChannelProvider: "webchat",
        agentSessionKey: SESSION_KEY,
      },
      { config: {}, action: "send", params: {} },
    );

    expect(result.currentChannelId).toBe(CANONICAL_SPACE);
    expect(result.currentMessagingTarget).toBe(CANONICAL_SPACE);
    expect(store.entriesCalls).toEqual([]);
    expect(store.exactReads).toEqual([SESSION_KEY]);
  });

  it("does not enumerate when this session has no stored delivery row", () => {
    const result = resolveEffectiveCurrentChannelContext(
      {
        currentChannelProvider: "webchat",
        agentSessionKey: SESSION_KEY,
      },
      { config: {}, action: "send", params: {} },
    );

    expect(result.currentChannelId).toBe(FOLDED_SPACE);
    expect(store.entriesCalls).toEqual([]);
    expect(store.exactReads).toEqual([SESSION_KEY]);
  });

  it("does not enumerate when the stored row carries no external delivery", () => {
    store.rows[SESSION_KEY] = { sessionId: "s1", updatedAt: 1, delivery: { kind: "internal" } };

    const result = resolveEffectiveCurrentChannelContext(
      {
        currentChannelProvider: "webchat",
        agentSessionKey: SESSION_KEY,
      },
      { config: {}, action: "send", params: {} },
    );

    expect(result.currentChannelId).toBe(FOLDED_SPACE);
    expect(store.entriesCalls).toEqual([]);
    expect(store.exactReads).toEqual([SESSION_KEY]);
  });

  it("keeps the inferred route when the exact store cannot be read", () => {
    store.loadExactSessionEntryReadOnly.mockImplementationOnce(() => {
      throw new Error("store is unreadable");
    });
    const result = resolveEffectiveCurrentChannelContext(
      { currentChannelProvider: "webchat", agentSessionKey: SESSION_KEY },
      { config: {}, action: "send", params: {} },
    );
    expect(result.currentMessagingTarget).toBe(FOLDED_SPACE);
    expect(store.entriesCalls).toEqual([]);
  });

  it("does not recover delivery from a replacement session at the same key", () => {
    seedRoutableRow();
    const result = resolveEffectiveCurrentChannelContext(
      {
        currentChannelProvider: "webchat",
        agentSessionKey: SESSION_KEY,
        sessionId: "previous-session",
      },
      { config: {}, action: "send", params: {} },
    );
    expect(result.currentMessagingTarget).toBe(FOLDED_SPACE);
    expect(store.exactReads).toEqual([SESSION_KEY]);
    expect(store.entriesCalls).toEqual([]);
  });

  it("reads no store at all for a channel with lowercase-canonical target ids", () => {
    getChannelPluginMock.mockReturnValue({ messaging: { targetIdComparison: "lowercase" } });
    seedRoutableRow();

    resolveEffectiveCurrentChannelContext(
      {
        currentChannelProvider: "webchat",
        agentSessionKey: SESSION_KEY,
      },
      { config: {}, action: "send", params: {} },
    );

    expect(store.exactReads).toEqual([]);
    expect(store.entriesCalls).toEqual([]);
    expect(store.openSessionEntryReadView).not.toHaveBeenCalled();
  });
});
