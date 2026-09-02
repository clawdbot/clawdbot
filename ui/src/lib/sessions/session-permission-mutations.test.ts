// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

it("keeps a confirmed permission mode when its list refresh fails", async () => {
  const key = "agent:main:permission-refresh";
  const sessionId = "permission-refresh-generation";
  let listCalls = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      listCalls += 1;
      if (listCalls > 1) {
        throw new Error("Roster refresh unavailable");
      }
      return sessionsResult(
        [
          {
            key,
            kind: "direct",
            label: "Permission refresh",
            permissionMode: "guarded",
            sessionId,
            updatedAt: 1,
          },
        ],
        1,
      );
    }
    if (method === "sessions.patch") {
      return {
        key,
        entry: { permissionMode: "workspace", sessionId, updatedAt: 2 },
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  const sessions = createSessionCapability(gateway);

  await sessions.refresh({ force: true });
  const result = await sessions.patch(key, { permissionMode: "workspace" });

  expect(result).toMatchObject({ listRefreshError: "Roster refresh unavailable" });
  expect(sessions.state.result?.sessions).toEqual([
    expect.objectContaining({
      key,
      label: "Permission refresh",
      permissionMode: "workspace",
      sessionId,
      updatedAt: 2,
    }),
  ]);
  expect(sessions.state.error).toContain("Roster refresh unavailable");
  sessions.dispose();
});
