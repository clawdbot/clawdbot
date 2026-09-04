import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createGatewayHarness,
  createSessionCapabilityHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

it.each(["none", "newer", "failed-before-list", "failed-after-list"])(
  "reconciles created placement without retiring a newer model claim (%s)",
  async (claim) => {
    let resolveList: (result: SessionsListResult) => void = () => undefined;
    const pendingList = new Promise<SessionsListResult>((resolve) => {
      resolveList = resolve;
    });
    const key = "agent:main:created-in-background";
    let rejectPatch: (error: Error) => void = () => undefined;
    let resolvePatch: (result: unknown) => void = () => undefined;
    const pendingPatch = new Promise<unknown>((resolve, reject) => {
      resolvePatch = resolve;
      rejectPatch = reject;
    });
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.create") {
        return { key };
      }
      if (method === "sessions.list") {
        return await pendingList;
      }
      if (method === "sessions.patch") {
        return await pendingPatch;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { sessions } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );
    const created = vi.fn();
    sessions.subscribeCreated(created);

    await expect(
      sessions.createResult(
        { agentId: "main", model: "openai/gpt-5.6-sol", worktree: true },
        { reconciliation: "background" },
      ),
    ).resolves.toMatchObject({ key });
    expect(created).toHaveBeenCalledOnce();
    expect(created).toHaveBeenCalledWith(key);
    expect(sessions.isPreparedWorkSession(key)).toBe(true);
    expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-5.6-sol");
    const patch =
      claim !== "none"
        ? sessions
            .patch(key, { model: claim === "newer" ? "openai/gpt-5.6-sol" : "openai/gpt-5-mini" })
            .catch((error: unknown) => error)
        : null;
    if (claim === "failed-before-list") {
      rejectPatch(new Error("model rejected"));
      expect(await patch).toEqual(new Error("model rejected"));
      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-5.6-sol");
    }

    resolveList(
      sessionsResult(
        [
          {
            key,
            kind: "direct",
            updatedAt: 2,
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            modelOverrideSource: null,
            worktree: { id: "wt-1", branch: "openclaw/task", repoRoot: "/repo" },
          },
        ],
        2,
      ),
    );
    await waitForFast(() => expect(sessions.isPreparedWorkSession(key)).toBe(false));
    if (claim === "failed-after-list") {
      expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-5-mini");
      rejectPatch(new Error("model rejected"));
      expect(await patch).toEqual(new Error("model rejected"));
    }
    expect(created).toHaveBeenCalledOnce();
    expect(sessions.isPreparedWorkSession(key)).toBe(false);
    expect(sessions.state.modelOverrides[key]).toBe(
      claim === "newer" ? "openai/gpt-5.6-sol" : undefined,
    );
    if (claim === "newer") {
      resolvePatch({ ok: true, key, entry: {} });
      await patch;
      expect(sessions.state.modelOverrides[key]).toBeUndefined();
    }
    sessions.dispose();
  },
);
it.each([
  {
    label: "versioned event",
    event: { thinkingLevel: "medium", updatedAt: 2 },
    settleWithEvent: true,
  },
  {
    label: "unversioned event",
    event: { sessionId: "created-session", thinkingLevel: "medium" },
    settleWithEvent: false,
  },
])("claims created placement through background reconciliation ($label)", async (testCase) => {
  let resolveList: (result: SessionsListResult) => void = () => undefined;
  const pendingList = new Promise<SessionsListResult>((resolve) => {
    resolveList = resolve;
  });
  let resolveAppendList: (result: SessionsListResult) => void = () => undefined;
  const pendingAppendList = new Promise<SessionsListResult>((resolve) => {
    resolveAppendList = resolve;
  });
  let resolveCanonicalList: (result: SessionsListResult) => void = () => undefined;
  const pendingCanonicalList = new Promise<SessionsListResult>((resolve) => {
    resolveCanonicalList = resolve;
  });
  let listCalls = 0;
  const key = "agent:main:created-in-background";
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.create") {
      return {
        key,
        entry: {
          sessionId: "created-session",
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          thinkingLevel: "xhigh",
          updatedAt: 1,
        },
      };
    }
    if (method === "sessions.list") {
      listCalls += 1;
      if (listCalls === 1) {
        return sessionsResult([{ key: "agent:main:main", kind: "direct", updatedAt: 1 }], 1);
      }
      if (listCalls === 2) {
        return await pendingList;
      }
      if (listCalls === 3 && !testCase.settleWithEvent) {
        return await pendingAppendList;
      }
      return await pendingCanonicalList;
    }
    if (method === "sessions.patch") {
      throw new Error("thinking rejected");
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { sessions } = createSessionCapabilityHarness(
    request as unknown as GatewayBrowserClient["request"],
  );
  const created = vi.fn();
  sessions.subscribeCreated(created);
  await sessions.refresh({ force: true });

  await expect(
    sessions.createResult(
      { agentId: "main", model: "openai/gpt-5.6-sol", worktree: true },
      { reconciliation: "background" },
    ),
  ).resolves.toMatchObject({ key });
  expect(created).toHaveBeenCalledOnce();
  expect(created).toHaveBeenCalledWith(key);
  expect(sessions.isPreparedWorkSession(key)).toBe(true);
  expect(sessions.state.modelOverrides[key]).toBe("openai/gpt-5.6-sol");
  expect(sessions.think(key)).toBe("xhigh");
  const stateChanged = vi.fn();
  const stopState = sessions.subscribe(stateChanged);
  expect(
    sessions.reconcileChanged({
      sessionKey: key,
      key,
      kind: "direct",
      ...testCase.event,
    }).applied,
  ).toBe(true);
  expect(sessions.think(key)).toBe("medium");
  expect(stateChanged).toHaveBeenCalledOnce();

  resolveList(
    sessionsResult(
      [
        {
          key,
          kind: "direct",
          thinkingLevel: "xhigh",
          updatedAt: 2,
          worktree: { id: "wt-1", branch: "openclaw/task", repoRoot: "/repo" },
        },
      ],
      2,
    ),
  );
  await waitForFast(() => expect(sessions.isPreparedWorkSession(key)).toBe(false));
  expect(sessions.think(key)).toBe("medium");
  await expect(sessions.patch(key, { thinkingLevel: "medium" })).rejects.toThrow(
    "thinking rejected",
  );
  expect(sessions.think(key)).toBe("medium");
  if (testCase.settleWithEvent) {
    expect(
      sessions.reconcileChanged({
        sessionKey: key,
        key,
        kind: "direct",
        thinkingLevel: "medium",
        updatedAt: 3,
      }).applied,
    ).toBe(true);
    expect(sessions.think(key)).toBeUndefined();
  } else {
    const appendRefresh = sessions.refresh({ append: true, offset: 1, force: true });
    resolveAppendList(sessionsResult([], 3));
    await appendRefresh;
    expect(sessions.think(key)).toBe("medium");
  }
  const canonicalRefresh = sessions.refresh({ force: true });
  const canonicalThinkingLevel = testCase.settleWithEvent ? "medium" : "high";
  resolveCanonicalList(
    sessionsResult(
      [{ key, kind: "direct", thinkingLevel: canonicalThinkingLevel, updatedAt: 3 }],
      3,
    ),
  );
  await canonicalRefresh;
  expect(sessions.think(key)).toBeUndefined();
  expect(sessions.state.result?.sessions[0]?.thinkingLevel).toBe(canonicalThinkingLevel);
  expect(created).toHaveBeenCalledOnce();
  expect(sessions.isPreparedWorkSession(key)).toBe(false);
  stopState();
  sessions.dispose();
});

it.each([
  {
    label: "versioned removal",
    event: { archived: true, updatedAt: 2 },
    archivedFilter: undefined,
    expectedClaim: undefined,
    expectedCount: 0,
  },
  {
    label: "unversioned thinking removal",
    event: { archived: true, thinkingLevel: "medium" },
    archivedFilter: undefined,
    expectedClaim: undefined,
    expectedCount: 0,
  },
  {
    label: "stale versioned removal",
    event: { archived: true, updatedAt: 0 },
    archivedFilter: undefined,
    expectedClaim: "xhigh",
    expectedCount: 0,
  },
  {
    label: "retained archived row",
    event: { archived: true, updatedAt: 2 },
    archivedFilter: "all" as const,
    expectedClaim: "xhigh",
    expectedCount: 1,
  },
])(
  "reconciles a created thinking claim for a $label",
  async ({ event, archivedFilter, expectedClaim, expectedCount }) => {
    const key = "agent:main:created-then-archived";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.create") {
        return { key, entry: { thinkingLevel: "xhigh", updatedAt: 1 } };
      }
      if (method === "sessions.list") {
        return sessionsResult([{ key, kind: "direct", thinkingLevel: "high", updatedAt: 0 }], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { sessions } = createSessionCapabilityHarness(
      request as unknown as GatewayBrowserClient["request"],
    );

    await sessions.createResult({ agentId: "main" });
    expect(sessions.think(key)).toBe("xhigh");
    expect(
      sessions.reconcileChanged(
        { sessionKey: key, key, kind: "direct", ...event },
        archivedFilter ? { archivedFilter } : undefined,
      ).applied,
    ).toBe(true);
    expect(sessions.state.result?.sessions).toHaveLength(expectedCount);
    expect(sessions.think(key)).toBe(expectedClaim);
    sessions.dispose();
  },
);

it("retires a created thinking claim before replacement state is published", async () => {
  const key = "agent:main:created-before-reconnect";
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.create") {
      return { key, entry: { thinkingLevel: "xhigh", updatedAt: 1 } };
    }
    if (method === "sessions.list") {
      return sessionsResult([{ key, kind: "direct", thinkingLevel: "high", updatedAt: 0 }], 1);
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { gateway, publish } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  const sessions = createTestSessionCapability(gateway);

  await sessions.createResult({ agentId: "main" });
  expect(sessions.think(key)).toBe("xhigh");
  const publishedClaims: Array<string | undefined> = [];
  sessions.subscribe(() => publishedClaims.push(sessions.think(key)));

  publish(true, { request } as unknown as GatewayBrowserClient);
  expect(publishedClaims[0]).toBeUndefined();
  sessions.dispose();
});

it("isolates delayed raw-global thinking claims by agent", async () => {
  const pendingList = new Promise<SessionsListResult>(() => {
    // Keep both agents in the create-to-roster handoff for the assertion.
  });
  const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
    if (method === "sessions.create") {
      return {
        key: "global",
        entry: {
          thinkingLevel: params?.agentId === "alpha" ? "xhigh" : "medium",
          updatedAt: 1,
        },
      };
    }
    if (method === "sessions.list") {
      return await pendingList;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const sessions = createTestSessionCapability({
    snapshot: {
      client: { request } as unknown as GatewayBrowserClient,
      phase: "connected",
      hello: null,
      assistantAgentId: "main",
      sessionKey: "global",
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });

  await sessions.createResult({ agentId: "alpha" }, { reconciliation: "background" });
  await sessions.createResult({ agentId: "beta" }, { reconciliation: "background" });

  expect(sessions.think("global", "alpha")).toBe("xhigh");
  expect(sessions.think("global", "beta")).toBe("medium");
  expect(sessions.think("global", "main")).toBeUndefined();
  sessions.dispose();
});

it("retires prepared work placement when the session is deleted", async () => {
  const key = "agent:main:deleted-worktree";
  const emptyList = sessionsResult([], 2);
  const client = {
    request: vi.fn(async (method: string) => {
      if (method === "sessions.create") {
        return { key };
      }
      if (method === "sessions.delete") {
        return { deleted: true };
      }
      if (method === "sessions.list") {
        return emptyList;
      }
      throw new Error(`Unexpected request: ${method}`);
    }),
  } as unknown as GatewayBrowserClient;
  const { sessions } = createSessionCapabilityHarness(client.request.bind(client));

  await expect(
    sessions.createResult({ agentId: "main", worktree: true }, { reconciliation: "background" }),
  ).resolves.toMatchObject({ key });
  expect(sessions.isPreparedWorkSession(key)).toBe(true);

  await expect(sessions.delete(key)).resolves.toMatchObject({ deleted: true });
  // The key can be reused by a later ordinary thread, so it must not stay Coding.
  expect(sessions.isPreparedWorkSession(key)).toBe(false);
  sessions.dispose();
});

it("does not prepare rejected worktree or model selections", async () => {
  const key = "agent:main:rejected-worktree";
  const client = {
    request: vi.fn(async (method: string) => {
      if (method === "sessions.create") {
        throw new Error("agent workspace is not a git checkout");
      }
      throw new Error(`Unexpected request: ${method}`);
    }),
  } as unknown as GatewayBrowserClient;
  const { sessions } = createSessionCapabilityHarness(client.request.bind(client));

  await expect(
    sessions.createResult(
      { key, model: "openai/gpt-5.6-sol", worktree: true },
      { reconciliation: "background" },
    ),
  ).resolves.toBeNull();
  expect(sessions.isPreparedWorkSession(key)).toBe(false);
  expect(sessions.state.modelOverrides[key]).toBeUndefined();
  sessions.dispose();
});
