import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSessionCapability } from "./index.ts";

it("returns a created session before background list reconciliation finishes", async () => {
  let resolveList: (result: SessionsListResult) => void = () => undefined;
  const pendingList = new Promise<SessionsListResult>((resolve) => {
    resolveList = resolve;
  });
  const key = "agent:main:created-in-background";
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.create") {
      return { key };
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
    sessions.createResult({ agentId: "main" }, { reconciliation: "background" }),
  ).resolves.toMatchObject({ key });
  expect(created).not.toHaveBeenCalled();

  resolveList({
    ts: 2,
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [{ key, kind: "direct", updatedAt: 2 }],
  });
  await waitForFast(() => expect(created).toHaveBeenCalledWith(key));
  sessions.dispose();
});
