import { describe, expect, it, vi } from "vitest";
// @vitest-environment node
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "./session-capability.test-support.ts";

describe("createSessionCapability group mutations", () => {
  it("adds a group through the atomic sessions.groups.add RPC", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "sessions.groups.add") {
        return {
          ok: true,
          groups: [{ name: params.name as string, position: 0 }],
        };
      }
      if (method === "sessions.groups.list") {
        return { groups: [{ name: "New", position: 0 }] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, [
      "sessions.groups.add",
      "sessions.groups.list",
    ]);
    const sessions = createTestSessionCapability(gateway);

    await sessions.groupsAdd("New");

    expect(sessions.state.groups).toEqual(["New"]);
    expect(request).toHaveBeenCalledWith("sessions.groups.add", { name: "New" });
    expect(request).not.toHaveBeenCalledWith("sessions.groups.put", expect.any(Object));
    sessions.dispose();
  });

  it("reorders groups through the atomic sessions.groups.reorder RPC", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "sessions.groups.reorder") {
        return {
          ok: true,
          groups: (params.names as string[]).map((name, position) => ({ name, position })),
          sectionOrder: params.sectionOrder,
        };
      }
      if (method === "sessions.groups.list") {
        return {
          groups: [
            { name: "Beta", position: 0 },
            { name: "Alpha", position: 1 },
          ],
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, [
      "sessions.groups.reorder",
      "sessions.groups.list",
    ]);
    const sessions = createTestSessionCapability(gateway);

    await sessions.groupsReorder(
      ["Beta", "Alpha"],
      ["work", "category:Beta", "category:Alpha", "ungrouped"],
    );

    expect(sessions.state.groups).toEqual(["Beta", "Alpha"]);
    expect(request).toHaveBeenCalledWith("sessions.groups.reorder", {
      names: ["Beta", "Alpha"],
      sectionOrder: ["work", "category:Beta", "category:Alpha", "ungrouped"],
    });
    expect(request).not.toHaveBeenCalledWith("sessions.groups.put", expect.any(Object));
    sessions.dispose();
  });
});
