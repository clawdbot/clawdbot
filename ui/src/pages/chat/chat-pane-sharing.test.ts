/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-sharing.test/"} */

import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionMembersListResult,
  SessionVisibility,
} from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createSessionContext,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatSessionSharingState } from "./components/chat-session-sharing.ts";

type SharingPane = TestChatPane & {
  sessionSharingCacheKey: (sessionKey: string) => string;
  sessionSharingStates: Map<string, ChatSessionSharingState>;
  setSessionMember: (row: GatewaySessionRow, identityId: string, member: boolean) => Promise<void>;
  setSessionVisibility: (row: GatewaySessionRow, visibility: SessionVisibility) => Promise<void>;
};

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function sessionRow(): GatewaySessionRow {
  return {
    key: "agent:main:current",
    kind: "direct",
    updatedAt: 1,
    visibility: "draft",
    sharingRole: "owner",
  };
}

function sharingResult(row: GatewaySessionRow): SessionMembersListResult {
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
  const sessions = {
    refreshReplacement: vi.fn(),
  } as unknown as SessionCapability;
  replaceConnection(pane, state, { request } as unknown as GatewayBrowserClient, sessions);
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
      const oldSessions = {
        refreshReplacement: vi.fn(),
      } as unknown as SessionCapability;
      const { pane: testPane, state } = createTestChatPane({
        client: { request: oldRequest } as unknown as GatewayBrowserClient,
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
    },
  );

  it("preserves the current connection failure in the sharing cache", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === mutation.method) {
        throw new Error(`${mutation.name} failed`);
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const sessions = {
      refreshReplacement: vi.fn(),
    } as unknown as SessionCapability;
    const { pane: testPane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions,
    });
    const pane = testPane as SharingPane;
    const row = sessionRow();

    await mutation.invoke(pane, row);

    expect(pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))).toMatchObject({
      loading: false,
      error: `Error: ${mutation.name} failed`,
    });
    expect(sessions.refreshReplacement).not.toHaveBeenCalled();
  });
});

describe("chat pane sharing mutation phase ownership", () => {
  it.each(["resolve", "reject"] as const)(
    "drops a stale visibility session refresh when it later %s",
    async (completion) => {
      const refreshed = createDeferred<void>();
      const request = vi.fn(async (method: string) => {
        if (method === "session.visibility.set") {
          return {};
        }
        throw new Error(`unexpected old-connection request: ${method}`);
      });
      const oldSessions = {
        refreshReplacement: vi.fn(() => refreshed.promise),
      } as unknown as SessionCapability;
      const { pane: testPane, state } = createTestChatPane({
        client: { request } as unknown as GatewayBrowserClient,
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
        const listed = createDeferred<SessionMembersListResult>();
        const request = vi.fn((requestMethod: string) => {
          if (requestMethod === method) {
            return Promise.resolve({});
          }
          if (requestMethod === "session.members.list") {
            return listed.promise;
          }
          throw new Error(`unexpected old-connection request: ${requestMethod}`);
        });
        const oldSessions = {
          refreshReplacement: vi.fn(async () => undefined),
        } as unknown as SessionCapability;
        const { pane: testPane, state } = createTestChatPane({
          client: { request } as unknown as GatewayBrowserClient,
          sessions: oldSessions,
        });
        const pane = testPane as SharingPane;
        const row = sessionRow();
        const pending = invoke(pane, row);
        await vi.waitFor(() => {
          expect(request).toHaveBeenCalledWith(
            "session.members.list",
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
    const refreshed = createDeferred<void>();
    const row = sessionRow();
    const request = vi.fn(async (method: string) => {
      if (method === "session.members.list") {
        return sharingResult(row);
      }
      if (method === "session.members.add") {
        return {};
      }
      throw new Error(`unexpected old-connection request: ${method}`);
    });
    const oldSessions = {
      refreshReplacement: vi.fn(() => refreshed.promise),
    } as unknown as SessionCapability;
    const { pane: testPane, state } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
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
      if (method === "session.members.list") {
        return sharingResult(row);
      }
      return {};
    });
    const sessions = {
      refreshReplacement: vi.fn(async () => {
        calls.push("sessions.refreshReplacement");
      }),
    } as unknown as SessionCapability;
    const { pane: testPane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions,
    });
    const pane = testPane as SharingPane;

    await pane.setSessionVisibility(row, "shared");

    expect(calls).toEqual([
      "session.visibility.set",
      "sessions.refreshReplacement",
      "session.members.list",
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
      if (method === "session.members.list") {
        return sharingResult(row);
      }
      return {};
    });
    const sessions = {
      refreshReplacement: vi.fn(async () => {
        calls.push("sessions.refreshReplacement");
      }),
    } as unknown as SessionCapability;
    const { pane: testPane } = createTestChatPane({
      client: { request } as unknown as GatewayBrowserClient,
      sessions,
    });
    const pane = testPane as SharingPane;

    await pane.setSessionMember(row, "identity-alice", true);

    expect(calls).toEqual([
      "session.members.add",
      "session.members.list",
      "sessions.refreshReplacement",
    ]);
    expect(pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))?.result).toEqual(
      sharingResult(row),
    );
  });
});
