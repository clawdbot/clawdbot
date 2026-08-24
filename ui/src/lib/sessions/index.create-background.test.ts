import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSessionCapability } from "./index.ts";

it("claims created placement while carrying work metadata through background reconciliation", async () => {
  let resolveList: (result: SessionsListResult) => void = () => undefined;
  const pendingList = new Promise<SessionsListResult>((resolve) => {
    resolveList = resolve;
  });
  const key = "agent:main:created-in-background";
  const request = vi.fn(async (method: string, _params?: unknown) => {
    if (method === "sessions.create") {
      return {
        key,
        session: {
          key,
          kind: "direct",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          thinkingLevel: "xhigh",
          updatedAt: 1,
        },
      };
    }
    if (method === "sessions.list") {
      return await pendingList;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const sessions = createSessionCapability({
    snapshot: {
      client,
      phase: "connected" as const,
      hello: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
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
  expect(sessions.state.agentId).toBeNull();
  expect(sessions.state.result?.sessions).toContainEqual(
    expect.objectContaining({ key, thinkingLevel: "xhigh" }),
  );
  const listRequest = request.mock.calls.find(([method]) => method === "sessions.list");
  expect(listRequest?.[1]).not.toHaveProperty("agentId");

  resolveList({
    ts: 2,
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      {
        key,
        kind: "direct",
        updatedAt: 2,
        worktree: { id: "wt-1", branch: "openclaw/task", repoRoot: "/repo" },
      },
    ],
  });
  await waitForFast(() => expect(sessions.isPreparedWorkSession(key)).toBe(false));
  expect(created).toHaveBeenCalledOnce();
  expect(sessions.isPreparedWorkSession(key)).toBe(false);
  expect(sessions.state.agentId).toBeNull();
  sessions.dispose();
});

it.each([
  ["with a projected response row", true],
  ["without a projected response row", false],
])("moves an agent-scoped roster to the created session owner %s", async (_label, includeRow) => {
  let resolveResearchList: (result: SessionsListResult) => void = () => undefined;
  const researchList = new Promise<SessionsListResult>((resolve) => {
    resolveResearchList = resolve;
  });
  const key = "agent:research:created-in-background";
  const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
    if (method === "sessions.create") {
      return {
        key,
        ...(includeRow
          ? { session: { key, kind: "direct", agentId: "research", updatedAt: 2 } }
          : {}),
      };
    }
    if (method === "sessions.list") {
      if (params?.agentId === "research") {
        return await researchList;
      }
      return {
        ts: 1,
        path: "agent:main",
        count: 1,
        defaults: { modelProvider: "openai", model: "main-default", contextTokens: 111 },
        sessions: [{ key: "agent:main:existing", kind: "direct", agentId: "main", updatedAt: 1 }],
      } satisfies SessionsListResult;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const sessions = createSessionCapability({
    snapshot: {
      client,
      phase: "connected" as const,
      hello: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:existing",
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  await sessions.refresh({ agentId: "main", force: true });
  expect(sessions.state.result?.defaults.model).toBe("main-default");

  await expect(
    sessions.createResult({ agentId: "research" }, { reconciliation: "background" }),
  ).resolves.toMatchObject({ key });

  expect(sessions.state.agentId).toBe("research");
  if (includeRow) {
    expect(sessions.state.result?.sessions).toEqual([
      expect.objectContaining({ key, agentId: "research" }),
    ]);
    expect(sessions.state.result?.defaults).toEqual({
      modelProvider: null,
      model: null,
      contextTokens: null,
    });
  } else {
    expect(sessions.state.result).toBeNull();
  }
  expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ agentId: "research" });

  resolveResearchList({
    ts: 3,
    path: "agent:research",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [{ key, kind: "direct", agentId: "research", updatedAt: 3 }],
  });
  await waitForFast(() => expect(sessions.state.loading).toBe(false));
  expect(sessions.state.agentId).toBe("research");
  sessions.dispose();
});

it("retires prepared work placement when the session is deleted", async () => {
  const key = "agent:main:deleted-worktree";
  const emptyList: SessionsListResult = {
    ts: 2,
    path: "(multiple)",
    count: 0,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [],
  };
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
  const sessions = createSessionCapability({
    snapshot: {
      client,
      phase: "connected" as const,
      hello: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });

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
  const sessions = createSessionCapability({
    snapshot: {
      client,
      phase: "connected" as const,
      hello: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });

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
