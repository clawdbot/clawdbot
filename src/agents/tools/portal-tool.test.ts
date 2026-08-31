import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type {
  PortalCloseResult,
  PortalListResult,
  PortalSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  DEFAULT_GATEWAY_HTTP_TOOL_DENY,
  GATEWAY_OWNER_ONLY_CORE_TOOLS,
} from "../../security/dangerous-tools.js";
import type {
  AgentToolGatewayRequestCaller,
  InProcessGatewayCaller,
} from "./in-process-gateway.js";
import { createPortalTool } from "./portal-tool.js";

type AgentToolGatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];

const portal: PortalSummary = {
  id: "p3000",
  title: "App",
  port: 3000,
  listenPort: 43123,
  tokenQuery: `openclaw_portal=${"a".repeat(64)}`,
  url: `http://127.0.0.1:43123/?openclaw_portal=${"a".repeat(64)}`,
  publicUrl: "http://127.0.0.1:43123/",
  createdAtMs: 1,
};

function recorder() {
  const calls: Array<[string, unknown]> = [];
  const requestScopes: Array<[string, readonly string[] | undefined]> = [];
  const reply = (method: string) => {
    if (method === "portal.list") {
      return { portals: [portal] } as PortalListResult;
    }
    if (method === "portal.close") {
      return { closed: true } as PortalCloseResult;
    }
    return portal;
  };
  const callGateway: InProcessGatewayCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    calls.push([method, params]);
    return reply(method) as T;
  };
  const callGatewayRequest: AgentToolGatewayRequestCaller = async <T>(
    request: AgentToolGatewayRequest,
  ): Promise<T> => {
    calls.push([request.method, request.params ?? {}]);
    requestScopes.push([request.method, request.scopes]);
    return reply(request.method) as T;
  };
  return { calls, requestScopes, callGateway, callGatewayRequest };
}

describe("portal tool", () => {
  it("uses a flat closed action schema and owner-only security gate", () => {
    const tool = createPortalTool();
    expect(tool.parameters).toMatchObject({
      additionalProperties: false,
      properties: { action: { enum: ["open", "list", "close"] } },
    });
    expect(Value.Check(tool.parameters, { action: "open", port: 3000, path: "/app" })).toBe(true);
    expect(Value.Check(tool.parameters, { action: "open", port: 0 })).toBe(false);
    expect(Value.Check(tool.parameters, { action: "open", port: 3000, path: "app" })).toBe(false);
    expect(Value.Check(tool.parameters, { action: "unknown" })).toBe(false);
    expect(GATEWAY_OWNER_ONLY_CORE_TOOLS).toContain("portal");
    expect(DEFAULT_GATEWAY_HTTP_TOOL_DENY).toContain("portal");
  });

  it("maps open, list, and close through the in-process gateway caller", async () => {
    const recorded = recorder();
    const tool = createPortalTool({
      callGateway: recorded.callGateway,
      callGatewayRequest: recorded.callGatewayRequest,
    });
    const opened = await tool.execute("open", {
      action: "open",
      port: 3000,
      title: "App",
      description: "Preview",
      path: "/app",
    });
    const listed = await tool.execute("list", { action: "list" });
    const closed = await tool.execute("close", { action: "close", id: "p3000" });

    expect(recorded.calls).toEqual([
      ["portal.open", { port: 3000, title: "App", description: "Preview", path: "/app" }],
      ["portal.list", {}],
      ["portal.close", { id: "p3000" }],
    ]);
    expect(opened.details).toEqual(portal);
    expect(opened.content[0]).toMatchObject({
      type: "text",
      text: `Portal available at ${portal.url}. Pass PUBLIC_URL=${portal.publicUrl} and PORT=${portal.port} when starting the dev server. The operator can see it in the Control UI Portals page.`,
    });
    expect(listed.details).toEqual({ portals: [portal] });
    // Listing asks for write scope so the bearer URL is not redacted away from a
    // caller that can mint the same portal through action=open.
    expect(recorded.requestScopes).toEqual([["portal.list", ["operator.write"]]]);
    expect((listed.details as PortalListResult).portals[0]?.url).toBe(portal.url);
    expect(closed.details).toEqual({ closed: true });
    expect(Value.Check(tool.outputSchema!, opened.details)).toBe(true);
    expect(Value.Check(tool.outputSchema!, listed.details)).toBe(true);
    expect(Value.Check(tool.outputSchema!, closed.details)).toBe(true);
  });

  it("rejects action-specific missing and malformed fields before RPC", async () => {
    const recorded = recorder();
    const tool = createPortalTool({
      callGateway: recorded.callGateway,
      callGatewayRequest: recorded.callGatewayRequest,
    });

    await expect(tool.execute("open", { action: "open" })).rejects.toThrow("port required");
    await expect(tool.execute("open", { action: "open", port: 3000, path: "app" })).rejects.toThrow(
      "path must start with /",
    );
    await expect(tool.execute("close", { action: "close" })).rejects.toThrow("id required");
    expect(recorded.calls).toEqual([]);
  });
});
