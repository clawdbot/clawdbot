// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

it("publishes renamed group members atomically while the canonical refresh is pending", async () => {
  const refreshed = createDeferred<SessionsListResult>();
  let groupListCalls = 0;
  let listCalls = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.groups.list") {
      groupListCalls += 1;
      return { groups: [{ name: groupListCalls === 1 ? "Alpha" : "Beta" }] };
    }
    if (method === "sessions.groups.rename") {
      return { groups: [{ name: "Beta" }] };
    }
    if (method === "sessions.list") {
      listCalls += 1;
      return listCalls === 1
        ? sessionsResult(
            [
              {
                key: "agent:main:grouped",
                kind: "direct",
                sessionId: "grouped-session",
                updatedAt: 1,
                category: "Alpha",
              },
            ],
            1,
          )
        : await refreshed.promise;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const { gateway } = createGatewayHarness(client, [
    "sessions.groups.list",
    "sessions.groups.rename",
  ]);
  const sessions = createSessionCapability(gateway);

  await sessions.refresh({ force: true });
  await sessions.groupsLoad();
  await expect(sessions.groupsRename("Alpha", "Beta")).resolves.toBe("completed");

  expect(sessions.state.groups).toEqual(["Beta"]);
  expect(sessions.state.result?.sessions).toEqual([
    expect.objectContaining({ key: "agent:main:grouped", category: "Beta" }),
  ]);

  refreshed.resolve(
    sessionsResult(
      [
        {
          key: "agent:main:grouped",
          kind: "direct",
          sessionId: "grouped-session",
          updatedAt: 1,
          category: "Beta",
        },
      ],
      2,
    ),
  );
  sessions.dispose();
});
