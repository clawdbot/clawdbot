// Verifies canonical and provider-owned TUI session event routing.
import { describe, expect, it } from "vitest";
import { matchesSelectedTuiSession } from "./tui-session-events.js";
import type { TuiStateAccess } from "./tui-types.js";

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
