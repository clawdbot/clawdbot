// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createSessionCapability } from "./index.ts";
import type { SessionGateway } from "./session-capability.ts";

function createGateway(request: ReturnType<typeof vi.fn>, scopes: string[]): SessionGateway {
  const client = { request } as unknown as GatewayBrowserClient;
  return {
    snapshot: {
      client,
      phase: "connected",
      sessionKey: "agent:main:main",
      assistantAgentId: "main",
      hello: {
        auth: { role: "operator", scopes },
        features: { methods: ["sessions.groups.list", "sessions.groups.put"] },
      } as GatewayHelloOk,
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("legacy session group migration", () => {
  it("does not migrate browser groups without operator.write", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem("openclaw:sessions:custom-groups", JSON.stringify(["Research"]));
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        return { groups: [] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessionCapability(createGateway(request, ["operator.read"]));

    await sessions.groupsLoad();

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("sessions.groups.list", {});
    expect(localStorage.getItem("openclaw:sessions:custom-groups")).toBe(
      JSON.stringify(["Research"]),
    );
    sessions.dispose();
  });

  it("migrates browser groups with operator.write", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem("openclaw:sessions:custom-groups", JSON.stringify(["Research"]));
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        return { groups: [] };
      }
      if (method === "sessions.groups.put") {
        return { groups: [{ name: "Research" }] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const sessions = createSessionCapability(createGateway(request, ["operator.write"]));

    await sessions.groupsLoad();

    expect(request).toHaveBeenCalledWith("sessions.groups.put", { names: ["Research"] });
    expect(sessions.state.groups).toEqual(["Research"]);
    expect(localStorage.getItem("openclaw:sessions:custom-groups")).toBeNull();
    sessions.dispose();
  });
});
