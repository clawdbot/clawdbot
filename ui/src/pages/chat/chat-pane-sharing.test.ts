/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-sharing.test/"} */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSuggestion } from "../../../../packages/gateway-protocol/src/index.js";
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

const { confirmPublicShare, copyPublicShare } = vi.hoisted(() => ({
  confirmPublicShare: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
  copyPublicShare: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
}));
vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: confirmPublicShare }));
vi.mock("../../lib/clipboard.ts", () => ({ copyToClipboard: copyPublicShare }));
afterEach(() => {
  confirmPublicShare.mockReset();
  copyPublicShare.mockReset();
});

type SharingPane = TestChatPane & {
  loadSessionSharing: (row: GatewaySessionRow, force?: boolean) => Promise<void>;
  syncSelectedSessionSharing: (row: GatewaySessionRow | undefined) => void;
  sessionSharingCacheKey: (sessionKey: string) => string;
  sessionSharingStates: Map<string, ChatSessionSharingState>;
  setSessionMember: (row: GatewaySessionRow, identityId: string, member: boolean) => Promise<void>;
  setSessionVisibility: (row: GatewaySessionRow, visibility: SessionVisibility) => Promise<void>;
  setSessionPublicShare: (row: GatewaySessionRow, enabled: boolean) => Promise<void>;
  copySessionPublicLink: (row: GatewaySessionRow) => Promise<void>;
};

const SHARING_METHODS = [
  "session.visibility.set",
  "session.members.listEvidence",
  "session.members.add",
  "session.members.remove",
  "session.publicShare.set",
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

describe("public session sharing", () => {
  it.each(["draft", "read-only"] as const)(
    "hydrates a selected %s session's public state once on initial presentation",
    async (visibility) => {
      const row = { ...sessionRow(), visibility };
      const publicShare = { token: `v1.${"a".repeat(96)}`, createdAt: 1 };
      const request = vi.fn(async (method: string) => {
        if (method === "session.members.listEvidence") {
          return { ...sharingResult(row), publicShare };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const { pane: testPane, state } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: createSessionCapabilityFixture(),
      });
      const pane = testPane as SharingPane;
      state.sessionsResult = sharingSessionsResult(row);

      pane.syncSelectedSessionSharing(row);
      pane.syncSelectedSessionSharing(row);
      await vi.waitFor(() => {
        expect(
          pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))?.result?.publicShare,
        ).toEqual(publicShare);
      });
      pane.syncSelectedSessionSharing(row);

      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each([true, false])(
    "confirms publication, copies a mounted link (advertised=%s), and revokes independently of team visibility",
    async (advertised) => {
      const row = sessionRow();
      const publicShare = { token: `v1.${"a".repeat(96)}`, createdAt: 1 };
      let enabled = false;
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "session.publicShare.set") {
          enabled = asOptionalRecord(params)?.enabled === true;
          return { ok: true, sessionKey: row.key, ...(enabled ? { publicShare } : {}) };
        }
        if (method === "session.members.listEvidence") {
          return { ...sharingResult(row), ...(enabled ? { publicShare } : {}) };
        }
        throw new Error(`Unexpected request: ${method}`);
      });
      const { pane: testPane } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request, gatewayUrl: "wss://example.test" }),
        sessions: createSessionCapabilityFixture(),
      });
      const pane = testPane as SharingPane;
      const hello = pane.context.gateway.snapshot.hello!;
      pane.context = { ...pane.context, basePath: "/control" };
      hello.controlUiUrl = advertised
        ? "https://example.test/control/?token=never-copy"
        : undefined;
      confirmPublicShare.mockResolvedValue(true);
      copyPublicShare.mockResolvedValue(true);
      await pane.setSessionPublicShare(row, true);
      expect(confirmPublicShare).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("existing and future conversation text"),
        }),
      );
      expect(request).toHaveBeenCalledWith("session.publicShare.set", {
        sessionKey: row.key,
        agentId: "main",
        expectedSessionId: "session-current",
        enabled: true,
      });
      await pane.copySessionPublicLink(row);
      expect(copyPublicShare).toHaveBeenCalledWith(
        `https://example.test/control/share/session?token=${publicShare.token}`,
        expect.any(Function),
      );
      await pane.setSessionPublicShare(row, false);
      expect(request).toHaveBeenCalledWith("session.publicShare.set", {
        sessionKey: row.key,
        agentId: "main",
        expectedSessionId: "session-current",
        enabled: false,
      });
      expect(confirmPublicShare).toHaveBeenCalledTimes(1);
      expect(request.mock.calls.every(([method]) => method !== "session.visibility.set")).toBe(
        true,
      );
      expect(
        pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))?.result?.publicShare,
      ).toBeUndefined();
    },
  );

  it("rehydrates public state after an off-screen publication succeeds", async () => {
    const row = sessionRow();
    const other = {
      ...sessionRow(),
      key: "agent:main:other",
      sessionId: "session-other",
    };
    const publicShare = { token: `v1.${"a".repeat(96)}`, createdAt: 1 };
    const mutation = createDeferred<{
      ok: true;
      sessionKey: string;
      publicShare: typeof publicShare;
    }>();
    let listCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "session.members.listEvidence") {
        listCount += 1;
        return Promise.resolve({
          ...sharingResult(row),
          ...(listCount > 1 ? { publicShare } : {}),
        });
      }
      if (method === "session.publicShare.set") {
        return mutation.promise;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { pane: testPane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    const pane = testPane as SharingPane;
    state.sessionKey = row.key;
    pane.syncSelectedSessionSharing(row);
    await vi.waitFor(() => {
      expect(listCount).toBe(1);
      expect(pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))?.loading).toBe(
        false,
      );
    });

    confirmPublicShare.mockResolvedValue(true);
    const pending = pane.setSessionPublicShare(row, true);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "session.publicShare.set",
        expect.objectContaining({ sessionKey: row.key }),
      ),
    );
    state.sessionKey = other.key;
    state.sessionsResult = sharingSessionsResult(other);
    mutation.resolve({ ok: true, sessionKey: row.key, publicShare });
    await pending;

    state.sessionKey = row.key;
    state.sessionsResult = sharingSessionsResult(row);
    pane.syncSelectedSessionSharing(row);
    await vi.waitFor(() => {
      expect(listCount).toBe(2);
      expect(
        pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))?.result?.publicShare,
      ).toEqual(publicShare);
    });
  });

  it("rehydrates after the post-publication refresh becomes stale off-screen", async () => {
    const row = sessionRow();
    const other = {
      ...sessionRow(),
      key: "agent:main:other",
      sessionId: "session-other",
    };
    const publicShare = { token: `v1.${"a".repeat(96)}`, createdAt: 1 };
    const refresh = createDeferred<SessionMembersListEvidenceResult>();
    let listCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "session.publicShare.set") {
        return Promise.resolve({ ok: true, sessionKey: row.key, publicShare });
      }
      if (method === "session.members.listEvidence") {
        listCount += 1;
        if (listCount === 2) {
          return refresh.promise;
        }
        return Promise.resolve({
          ...sharingResult(row),
          ...(listCount > 2 ? { publicShare } : {}),
        });
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { pane: testPane, state } = createSharingTestChatPane({
      client: createGatewayBrowserClientFixture({ request }),
      sessions: createSessionCapabilityFixture(),
    });
    const pane = testPane as SharingPane;
    state.sessionKey = row.key;
    pane.syncSelectedSessionSharing(row);
    await vi.waitFor(() => {
      expect(listCount).toBe(1);
      expect(pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))?.loading).toBe(
        false,
      );
    });

    confirmPublicShare.mockResolvedValue(true);
    const pending = pane.setSessionPublicShare(row, true);
    await vi.waitFor(() => expect(listCount).toBe(2));
    state.sessionKey = other.key;
    state.sessionsResult = sharingSessionsResult(other);
    refresh.resolve({ ...sharingResult(row), publicShare });
    await pending;

    state.sessionKey = row.key;
    state.sessionsResult = sharingSessionsResult(row);
    pane.syncSelectedSessionSharing(row);
    await vi.waitFor(() => {
      expect(listCount).toBe(3);
      expect(
        pane.sessionSharingStates.get(pane.sessionSharingCacheKey(row.key))?.result?.publicShare,
      ).toEqual(publicShare);
    });
  });

  it.each(["cancel", "session", "connection", "scope"] as const)(
    "does not publish after %s invalidates confirmation",
    async (change) => {
      const confirmation = createDeferred<boolean>();
      confirmPublicShare.mockReturnValue(confirmation.promise);
      const request = vi.fn();
      const { pane: testPane, state } = createSharingTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: createSessionCapabilityFixture(),
      });
      const pane = testPane as SharingPane;
      const row = sessionRow();
      const pending = pane.setSessionPublicShare(row, true);
      await vi.waitFor(() => expect(confirmPublicShare).toHaveBeenCalledOnce());
      if (change === "session") {
        state.sessionsResult = sharingSessionsResult({ ...row, sessionId: "replacement" });
      } else if (change === "connection") {
        pane.connectionGeneration += 1;
      } else if (change === "scope") {
        setSharingAuthorization(pane, { scopes: ["operator.read"] });
      }
      confirmation.resolve(change !== "cancel");
      await pending;
      expect(request).not.toHaveBeenCalled();
    },
  );
});

describe("chat pane sharing authorization", () => {
  it.each(["draft", "shared"] as const)(
    "loads selected-global Work suggestions after visibility changes to %s",
    async (visibility) => {
      const pending: SessionSuggestion = {
        id: `pending-${visibility}`,
        sessionKey: "agent:work:main",
        agentId: "work",
        author: { type: "human", id: "alice", label: "Alice" },
        text: "still needs review",
        createdAt: 1,
        state: "pending",
      };
      const request = vi.fn(async () => ({ suggestions: [pending], role: "owner" as const }));
      const { pane, state } = createTestChatPane({
        client: createGatewayBrowserClientFixture({ request }),
        sessions: {} as SessionCapability,
      });
      state.sessionKey = "agent:work:main";
      state.assistantAgentId = "work";
      state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
      state.sessionsResultAgentId = "work";
      state.sessionsResult = sharingSessionsResult({
        ...sessionRow(),
        key: "global",
        kind: "global",
        visibility,
      });
      pane.presencePayload = {
        presence: [{ user: { id: "owner" } }, { user: { id: "alice" } }],
      };

      await pane.refreshSessionSuggestions();

      expect(request).toHaveBeenCalledWith("session.suggestions.list", {
        sessionKey: "agent:work:main",
        agentId: "work",
      });
      expect(pane.sessionSuggestions).toEqual([pending]);
      expect(pane.sessionSuggestionRole).toBe("owner");
    },
  );

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
        refreshReplacement: vi.fn(async () => null),
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
      const refreshed = createDeferred<SessionsListResult | null>();
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
        refreshed.resolve(null);
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
          refreshReplacement: vi.fn(async () => null),
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
    const refreshed = createDeferred<SessionsListResult | null>();
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
        return null;
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
        return null;
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
