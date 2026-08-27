import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSessionCapability } from "./index.ts";

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
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          modelOverrideSource: null,
          worktree: { id: "wt-1", branch: "openclaw/task", repoRoot: "/repo" },
        },
      ],
    });
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
