/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-sharing.test/"} */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionMembersListEvidenceResult,
  SessionVisibility,
  SessionsListResult,
} from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createSessionContext,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatSessionSharingState } from "./components/chat-session-sharing.ts";

type SharingPane = TestChatPane & {
  loadSessionSharing: (row: GatewaySessionRow, force?: boolean) => Promise<void>;
  sessionSharingCacheKey: (sessionKey: string) => string;
  sessionSharingStates: Map<string, ChatSessionSharingState>;
  setSessionMember: (row: GatewaySessionRow, identityId: string, member: boolean) => Promise<void>;
  setSessionVisibility: (row: GatewaySessionRow, visibility: SessionVisibility) => Promise<void>;
};

const SHARING_METHODS = [
  "session.visibility.set",
  "session.members.listEvidence",
  "session.members.add",
  "session.members.remove",
];

function setSharingAuthorization(
  pane: SharingPane,
  params: {
    methods?: string[];
    phase?: "connected" | "reconnecting";
    scopes?: string[];
  } = {},
): void {
  const snapshot = pane.context.gateway.snapshot;
  snapshot.phase = params.phase ?? "connected";
  snapshot.hello = {
    ...snapshot.hello,
    auth: {
      role: "operator",
      scopes: params.scopes ?? ["operator.admin"],
    },
    features: {
      ...snapshot.hello?.features,
      methods: params.methods ?? SHARING_METHODS,
    },
  } as typeof snapshot.hello;
}

function createSharingTestChatPane(params: Parameters<typeof createTestChatPane>[0]) {
  const result = createTestChatPane(params);
  setSharingAuthorization(result.pane as SharingPane);
  result.state.sessionsResult = sharingSessionsResult(sessionRow());
  result.state.sessionsResultAgentId = "main";
  return result;
}

function sessionRow(): GatewaySessionRow {
  return {
    key: "agent:main:current",
    kind: "direct",
    sessionId: "session-current",
    updatedAt: 1,
    visibility: "draft",
    sharingRole: "owner",
  };
}

function sharingSessionsResult(row: GatewaySessionRow): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: 1,
    defaults: {
      modelProvider: null,
      model: null,
      contextTokens: null,
    },
    sessions: [row],
  };
}

function sharingResult(row: GatewaySessionRow): SessionMembersListEvidenceResult {
  return {
    sessionKey: row.key,
    members: [],
    identities: [],
    role: "owner",
    allowedVisibilities: ["shared", "draft"],
  };
}

function replaceConnection(
  pane: SharingPane,
  state: ChatPageHost,
  client: GatewayBrowserClient,
  sessions: SessionCapability,
): void {
  pane.connectionGeneration += 1;
  pane.context = createSessionContext(client, sessions);
  setSharingAuthorization(pane);
  pane.state = state;
  state.client = client;
  state.connected = true;
  state.connectionEpoch = pane.connectionGeneration;
  pane.connectedClient = client;
}

function installReplacementConnection(
  pane: SharingPane,
  state: ChatPageHost,
  row: GatewaySessionRow,
) {
  const request = vi.fn();
  const sessions = createSessionCapabilityFixture({
    refreshReplacement: vi.fn(),
  });
  replaceConnection(pane, state, createGatewayBrowserClientFixture({ request }), sessions);
  const cacheKey = pane.sessionSharingCacheKey(row.key);
  const sharingState: ChatSessionSharingState = {
    loading: false,
    result: sharingResult(row),
  };
  pane.sessionSharingStates = new Map([[cacheKey, sharingState]]);
  return { cacheKey, request, sessions, sharingState };
}

const mutations = [
  {
    name: "visibility",
    method: "session.visibility.set",
    invoke: (pane: SharingPane, row: GatewaySessionRow) => pane.setSessionVisibility(row, "shared"),
  },
  {
    name: "member",
    method: "session.members.add",
    invoke: (pane: SharingPane, row: GatewaySessionRow) =>
      pane.setSessionMember(row, "identity-alice", true),
  },
] as const;

describe("chat pane sharing authorization", () => {
  it("allows read-scoped owners to load sharing data but not mutate it", async () => {
    const row = sessionRow();
    const request = vi.fn(async (method: string) => {
      if (method === "session.members.listEvidence") {
        return sharingResult(row);
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const sessions = createSessionCapabilityFixture({
      refreshReplacement: vi.fn(),
    });
    const { pane: testPane } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    const pane = testPane as SharingPane;
    setSharingAuthorization(pane, { scopes: ["operator.read"] });

    await pane.loadSessionSharing(row);
    await pane.setSessionVisibility(row, "shared");
    await pane.setSessionMember(row, "identity-alice", true);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "session.members.listEvidence",
      expect.objectContaining({ sessionKey: row.key }),
    );
    expect(sessions.refreshReplacement).not.toHaveBeenCalled();
  });

  it("allows write and admin scoped owners to mutate sharing", async () => {
    for (const scope of ["operator.write", "operator.admin"]) {
      const row = sessionRow();
      const request = vi.fn(async (method: string) => {
        if (method === "session.members.listEvidence") {
          return sharingResult(row);
        }
        return {};
      });
      const sessions = createSessionCapabilityFixture({
        refreshReplacement: vi.fn(async () => undefined),
      });
      const { pane: testPane } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions,
      });
      const pane = testPane as SharingPane;
      setSharingAuthorization(pane, { scopes: [scope] });

      await pane.setSessionVisibility(row, "shared");
      await pane.setSessionMember(row, "identity-alice", true);

      expect(request).toHaveBeenCalledWith(
        "session.visibility.set",
        expect.objectContaining({ sessionKey: row.key }),
      );
      expect(request).toHaveBeenCalledWith(
        "session.members.add",
        expect.objectContaining({ sessionKey: row.key }),
      );
    }
  });

  it("refuses sharing requests for non-managers and disconnected snapshots", async () => {
    for (const authorization of [
      { row: { ...sessionRow(), sharingRole: "member" as const } },
      { row: sessionRow(), phase: "reconnecting" as const },
    ]) {
      const request = vi.fn();
      const sessions = createSessionCapabilityFixture({
        refreshReplacement: vi.fn(),
      });
      const { pane: testPane } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions,
      });
      const pane = testPane as SharingPane;
      setSharingAuthorization(pane, {
        phase: authorization.phase,
        scopes: ["operator.admin"],
      });

      await pane.loadSessionSharing(authorization.row);
      await pane.setSessionVisibility(authorization.row, "shared");
      await pane.setSessionMember(authorization.row, "identity-alice", true);

      expect(request).not.toHaveBeenCalled();
      expect(sessions.refreshReplacement).not.toHaveBeenCalled();
    }
  });

  it("refuses explicitly unadvertised sharing methods", async () => {
    const row = sessionRow();
    const request = vi.fn(async () => sharingResult(row));
    const sessions = createSessionCapabilityFixture({
      refreshReplacement: vi.fn(),
    });
    const { pane: testPane } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    const pane = testPane as SharingPane;
    setSharingAuthorization(pane, {
      methods: ["session.members.listEvidence"],
      scopes: ["operator.admin"],
    });

    await pane.loadSessionSharing(row);
    await pane.setSessionVisibility(row, "shared");
    await pane.setSessionMember(row, "identity-alice", true);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "session.members.listEvidence",
      expect.objectContaining({ sessionKey: row.key }),
    );
  });

  it.each([
    {
      name: "a replacement session",
      current: { ...sessionRow(), sessionId: "session-replacement" },
    },
    {
      name: "a current non-manager role",
      current: { ...sessionRow(), sharingRole: "member" as const },
    },
  ])("refuses callbacks retained from $name", async ({ current }) => {
    const request = vi.fn();
    const sessions = createSessionCapabilityFixture({
      refreshReplacement: vi.fn(),
    });
    const { pane: testPane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    const pane = testPane as SharingPane;
    const stale = sessionRow();
    state.sessionsResult = sharingSessionsResult(current);

    await pane.loadSessionSharing(stale);
    await pane.setSessionVisibility(stale, "shared");
    await pane.setSessionMember(stale, "identity-alice", true);

    expect(request).not.toHaveBeenCalled();
    expect(sessions.refreshReplacement).not.toHaveBeenCalled();
  });

  it("releases a stale same-key sharing load for the replacement session", async () => {
    const stale = sessionRow();
    const replacement = { ...sessionRow(), sessionId: "session-replacement" };
    const listed = createDeferred<SessionMembersListEvidenceResult>();
    const request = vi.fn((method: string) => {
      if (method !== "session.members.listEvidence") {
        throw new Error(`unexpected request: ${method}`);
      }
      return request.mock.calls.length === 1
        ? listed.promise
        : Promise.resolve(sharingResult(replacement));
    });
    const sessions = createSessionCapabilityFixture({
      refreshReplacement: vi.fn(),
    });
    const { pane: testPane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    const pane = testPane as SharingPane;
    const pending = pane.loadSessionSharing(stale);
    state.sessionsResult = sharingSessionsResult(replacement);
    listed.resolve(sharingResult(stale));
    await pending;

    expect(pane.sessionSharingStates.has(pane.sessionSharingCacheKey(stale.key))).toBe(false);

    await pane.loadSessionSharing(replacement);

    expect(request).toHaveBeenCalledTimes(2);
    expect(pane.sessionSharingStates.get(pane.sessionSharingCacheKey(replacement.key))).toEqual({
      loading: false,
      result: sharingResult(replacement),
    });
  });

  it("drops a sharing load failure after leaving and returning", async () => {
    const row = sessionRow();
    const listed = createDeferred<SessionMembersListEvidenceResult>();
    const request = vi.fn(() => listed.promise);
    const { pane: testPane } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    const pane = testPane as SharingPane;
    const pending = pane.loadSessionSharing(row);
    pane.presented = false;
    pane.presented = true;

    listed.reject(new Error("stale sharing load failed"));
    await pending;

    expect(pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))).toBeUndefined();
  });
});

describe.each(mutations)("chat pane $name mutation connection ownership", (mutation) => {
  it.each(["resolve", "reject"] as const)(
    "drops a stale mutation when the previous connection later %s",
    async (completion) => {
      const response = createDeferred<unknown>();
      const oldRequest = vi.fn((method: string) => {
        if (method !== mutation.method) {
          throw new Error(`unexpected old-connection request: ${method}`);
        }
        return response.promise;
      });
      const oldSessions = createSessionCapabilityFixture({
        refreshReplacement: vi.fn(),
      });
      const { pane: testPane, state } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request: oldRequest }),
        sessions: oldSessions,
      });
      const pane = testPane as SharingPane;
      const row = sessionRow();
      const pending = mutation.invoke(pane, row);
      expect(oldRequest).toHaveBeenCalledWith(
        mutation.method,
        expect.objectContaining({ sessionKey: row.key }),
      );

      const replacement = installReplacementConnection(pane, state, row);

      if (completion === "resolve") {
        response.resolve({});
      } else {
        response.reject(new Error("old connection failed"));
      }
      await pending;

      expect(replacement.request).not.toHaveBeenCalled();
      expect(replacement.sessions.refreshReplacement).not.toHaveBeenCalled();
      expect(pane.sessionSharingStates.get(replacement.cacheKey)).toBe(replacement.sharingState);
      expect(state.lastError).toBeNull();
      expect(state.chatError).toBeNull();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "drops a stale same-key mutation when the replaced session later %s",
    async (completion) => {
      const response = createDeferred<unknown>();
      const request = vi.fn((method: string) => {
        if (method !== mutation.method) {
          throw new Error(`unexpected request: ${method}`);
        }
        return response.promise;
      });
      const sessions = createSessionCapabilityFixture({
        refreshReplacement: vi.fn(),
      });
      const { pane: testPane, state } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions,
      });
      const pane = testPane as SharingPane;
      const stale = sessionRow();
      const pending = mutation.invoke(pane, stale);
      expect(request).toHaveBeenCalledWith(
        mutation.method,
        expect.objectContaining({ sessionKey: stale.key }),
      );

      const replacement = { ...stale, sessionId: "session-replacement" };
      state.sessionsResult = sharingSessionsResult(replacement);
      const cacheKey = pane.sessionSharingCacheKey(replacement.key);
      const replacementState: ChatSessionSharingState = {
        loading: false,
        result: sharingResult(replacement),
      };
      pane.sessionSharingStates = new Map([[cacheKey, replacementState]]);

      if (completion === "resolve") {
        response.resolve({});
      } else {
        response.reject(new Error("stale mutation failed"));
      }
      await pending;

      expect(request).toHaveBeenCalledTimes(1);
      expect(sessions.refreshReplacement).not.toHaveBeenCalled();
      expect(pane.sessionSharingStates.get(cacheKey)).toBe(replacementState);
      expect(state.lastError).toBeNull();
      expect(state.chatError).toBeNull();
    },
  );

  it("keeps a previous-session failure out of the newly selected session", async () => {
    const response = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method !== mutation.method) {
        throw new Error(`unexpected request: ${method}`);
      }
      return response.promise;
    });
    const sessions = createSessionCapabilityFixture({
      refreshReplacement: vi.fn(),
    });
    const { pane: testPane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    const pane = testPane as SharingPane;
    const previous = sessionRow();
    const selected = {
      ...sessionRow(),
      key: "agent:main:selected",
      sessionId: "session-selected",
    };
    state.sessionsResult = {
      ...sharingSessionsResult(previous),
      count: 2,
      sessions: [previous, selected],
    };
    const pending = mutation.invoke(pane, previous);
    state.sessionKey = selected.key;

    response.reject(new Error(`${mutation.name} failed after session switch`));
    await pending;

    expect(pane.sessionSharingStates.get(pane.sessionSharingCacheKey(previous.key))).toMatchObject({
      loading: false,
      error: `${mutation.name} failed after session switch`,
    });
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(sessions.refreshReplacement).not.toHaveBeenCalled();
  });

  it("drops a failure after leaving and returning to the retained pane", async () => {
    const response = createDeferred<unknown>();
    const request = vi.fn((method: string) => {
      if (method !== mutation.method) {
        throw new Error(`unexpected request: ${method}`);
      }
      return response.promise;
    });
    const sessions = createSessionCapabilityFixture({
      refreshReplacement: vi.fn(),
    });
    const { pane: testPane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    const pane = testPane as SharingPane;
    const row = sessionRow();
    const pending = mutation.invoke(pane, row);
    pane.presented = false;
    pane.presented = true;

    response.reject(new Error(`stale ${mutation.name} failed`));
    await pending;

    expect(pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))).toBeUndefined();
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(sessions.refreshReplacement).not.toHaveBeenCalled();
  });

  it("preserves the current connection failure in the sharing cache", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === mutation.method) {
        throw new Error(`${mutation.name} failed`);
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const sessions = createSessionCapabilityFixture({
      refreshReplacement: vi.fn(),
    });
    const { pane: testPane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    const pane = testPane as SharingPane;
    const row = sessionRow();

    await mutation.invoke(pane, row);

    expect(pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))).toMatchObject({
      loading: false,
      error: `${mutation.name} failed`,
    });
    expect(state.lastError).toBe(`${mutation.name} failed`);
    expect(state.chatError).toBe(state.lastError);
    expect(sessions.refreshReplacement).not.toHaveBeenCalled();
  });
});

describe("chat pane sharing mutation phase ownership", () => {
  it.each(["resolve", "reject"] as const)(
    "drops a stale visibility session refresh when it later %s",
    async (completion) => {
      const refreshed = createDeferred();
      const request = vi.fn(async (method: string) => {
        if (method === "session.visibility.set") {
          return {};
        }
        throw new Error(`unexpected old-connection request: ${method}`);
      });
      const oldSessions = createSessionCapabilityFixture({
        refreshReplacement: vi.fn(() => refreshed.promise),
      });
      const { pane: testPane, state } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: oldSessions,
      });
      const pane = testPane as SharingPane;
      const row = sessionRow();
      const pending = pane.setSessionVisibility(row, "shared");
      await vi.waitFor(() => {
        expect(oldSessions.refreshReplacement).toHaveBeenCalledWith("main");
      });

      const replacement = installReplacementConnection(pane, state, row);
      if (completion === "resolve") {
        refreshed.resolve();
      } else {
        refreshed.reject(new Error("old session refresh failed"));
      }
      await pending;

      expect(replacement.request).not.toHaveBeenCalled();
      expect(replacement.sessions.refreshReplacement).not.toHaveBeenCalled();
      expect(pane.sessionSharingStates.get(replacement.cacheKey)).toBe(replacement.sharingState);
    },
  );

  describe.each(mutations)("$name sharing reload", ({ invoke, method, name }) => {
    it.each(["resolve", "reject"] as const)(
      "drops a stale sharing reload when it later %s",
      async (completion) => {
        const listed = createDeferred<SessionMembersListEvidenceResult>();
        const request = vi.fn((requestMethod: string) => {
          if (requestMethod === method) {
            return Promise.resolve({});
          }
          if (requestMethod === "session.members.listEvidence") {
            return listed.promise;
          }
          throw new Error(`unexpected old-connection request: ${requestMethod}`);
        });
        const oldSessions = createSessionCapabilityFixture({
          refreshReplacement: vi.fn(async () => undefined),
        });
        const { pane: testPane, state } = createSharingTestChatPane({
          client: createGatewayBrowserClientFixture({ request }),
          sessions: oldSessions,
        });
        const pane = testPane as SharingPane;
        const row = sessionRow();
        const pending = invoke(pane, row);
        await vi.waitFor(() => {
          expect(request).toHaveBeenCalledWith(
            "session.members.listEvidence",
            expect.objectContaining({ sessionKey: row.key }),
          );
        });

        const replacement = installReplacementConnection(pane, state, row);
        if (completion === "resolve") {
          listed.resolve(sharingResult(row));
        } else {
          listed.reject(new Error(`old ${name} sharing reload failed`));
        }
        await pending;

        expect(oldSessions.refreshReplacement).toHaveBeenCalledTimes(name === "visibility" ? 1 : 0);
        expect(replacement.request).not.toHaveBeenCalled();
        expect(replacement.sessions.refreshReplacement).not.toHaveBeenCalled();
        expect(pane.sessionSharingStates.get(replacement.cacheKey)).toBe(replacement.sharingState);
      },
    );
  });

  it("drops a stale member session refresh failure", async () => {
    const refreshed = createDeferred();
    const row = sessionRow();
    const request = vi.fn(async (method: string) => {
      if (method === "session.members.listEvidence") {
        return sharingResult(row);
      }
      if (method === "session.members.add") {
        return {};
      }
      throw new Error(`unexpected old-connection request: ${method}`);
    });
    const oldSessions = createSessionCapabilityFixture({
      refreshReplacement: vi.fn(() => refreshed.promise),
    });
    const { pane: testPane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: oldSessions,
    });
    const pane = testPane as SharingPane;
    const pending = pane.setSessionMember(row, "identity-alice", true);
    await vi.waitFor(() => {
      expect(oldSessions.refreshReplacement).toHaveBeenCalledWith("main");
    });

    const replacement = installReplacementConnection(pane, state, row);
    refreshed.reject(new Error("old member session refresh failed"));
    await pending;

    expect(replacement.request).not.toHaveBeenCalled();
    expect(replacement.sessions.refreshReplacement).not.toHaveBeenCalled();
    expect(pane.sessionSharingStates.get(replacement.cacheKey)).toBe(replacement.sharingState);
  });
});

describe("chat pane current sharing mutation refresh order", () => {
  it("refreshes sessions before sharing after a visibility change", async () => {
    const row = sessionRow();
    const calls: string[] = [];
    const request = vi.fn(async (method: string) => {
      calls.push(method);
      if (method === "session.members.listEvidence") {
        return sharingResult(row);
      }
      return {};
    });
    const sessions = createSessionCapabilityFixture({
      refreshReplacement: vi.fn(async () => {
        calls.push("sessions.refreshReplacement");
      }),
    });
    const { pane: testPane } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    const pane = testPane as SharingPane;

    await pane.setSessionVisibility(row, "shared");

    expect(calls).toEqual([
      "session.visibility.set",
      "sessions.refreshReplacement",
      "session.members.listEvidence",
    ]);
    expect(pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))?.result).toEqual(
      sharingResult(row),
    );
  });

  it("refreshes sharing before sessions after a member change", async () => {
    const row = sessionRow();
    const calls: string[] = [];
    const request = vi.fn(async (method: string) => {
      calls.push(method);
      if (method === "session.members.listEvidence") {
        return sharingResult(row);
      }
      return {};
    });
    const sessions = createSessionCapabilityFixture({
      refreshReplacement: vi.fn(async () => {
        calls.push("sessions.refreshReplacement");
      }),
    });
    const { pane: testPane } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions,
    });
    const pane = testPane as SharingPane;

    await pane.setSessionMember(row, "identity-alice", true);

    expect(calls).toEqual([
      "session.members.add",
      "session.members.listEvidence",
      "sessions.refreshReplacement",
    ]);
    expect(pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))?.result).toEqual(
      sharingResult(row),
    );
  });
});
