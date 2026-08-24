import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type {
  PortalOpenResult,
  PortalSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveCoreOperatorGatewayMethodScope } from "../methods/core-descriptors.js";
import type { GatewayPortalService } from "../portals/portal-service.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { portalHandlers } from "./portals.js";

const portal = {
  id: "p3000",
  title: "App",
  port: 3000,
  listenPort: 43123,
  tokenQuery: `openclaw_portal=${"a".repeat(64)}`,
  url: `http://127.0.0.1:43123/?openclaw_portal=${"a".repeat(64)}`,
  publicUrl: "http://127.0.0.1:43123/",
  createdAtMs: 1,
} satisfies PortalOpenResult;

function harness(service?: GatewayPortalService, scopes = ["operator.write"]) {
  const broadcast = vi.fn();
  const invoke = async (method: keyof typeof portalHandlers, params: Record<string, unknown>) => {
    const respond = vi.fn();
    await portalHandlers[method]!({
      params,
      respond,
      client: { connect: { scopes } } as never,
      context: { portalService: service, broadcast } as never,
    } as never);
    return respond;
  };
  return { broadcast, invoke };
}

describe("portal gateway methods", () => {
  it("registers list and mutations with least-privilege scopes", () => {
    expect(resolveCoreOperatorGatewayMethodScope("portal.list")).toBe("operator.read");
    expect(resolveCoreOperatorGatewayMethodScope("portal.open")).toBe("operator.write");
    expect(resolveCoreOperatorGatewayMethodScope("portal.close")).toBe("operator.write");
  });

  it("round-trips list, open, and idempotent close with replace-set broadcasts", async () => {
    let portals: PortalSummary[] = [];
    const service: GatewayPortalService = {
      list: () => portals,
      open: vi.fn(async () => {
        portals = [portal];
        return portal;
      }),
      close: vi.fn(async () => {
        portals = [];
      }),
      closeAll: vi.fn(async () => {}),
    };
    const { invoke, broadcast } = harness(service);

    expect((await invoke("portal.list", {})).mock.calls[0]).toEqual([
      true,
      { portals: [] },
      undefined,
    ]);
    expect((await invoke("portal.open", { port: 3000, title: "App" })).mock.calls[0]).toEqual([
      true,
      portal,
      undefined,
    ]);
    expect(service.open).toHaveBeenCalledWith({ targetPort: 3000, title: "App" });
    expect(broadcast).toHaveBeenLastCalledWith(
      "portal.changed",
      {
        portals: [
          {
            id: portal.id,
            title: portal.title,
            port: portal.port,
            listenPort: portal.listenPort,
            publicUrl: portal.publicUrl,
            createdAtMs: portal.createdAtMs,
          },
        ],
      },
      { dropIfSlow: true },
    );
    expect((await invoke("portal.close", { id: "missing" })).mock.calls[0]).toEqual([
      true,
      { closed: true },
      undefined,
    ]);
    expect(broadcast).toHaveBeenLastCalledWith(
      "portal.changed",
      { portals: [] },
      { dropIfSlow: true },
    );
  });

  it("returns portal credentials only to write-capable operators", async () => {
    const service: GatewayPortalService = {
      list: () => [portal],
      open: vi.fn(),
      close: vi.fn(),
      closeAll: vi.fn(),
    };

    const readResponse = await harness(service, ["operator.read"]).invoke("portal.list", {});
    expect(readResponse.mock.calls[0]?.[1]).toEqual({
      portals: [
        {
          id: portal.id,
          title: portal.title,
          port: portal.port,
          listenPort: portal.listenPort,
          publicUrl: portal.publicUrl,
          createdAtMs: portal.createdAtMs,
        },
      ],
    });

    const writeResponse = await harness(service, ["operator.write"]).invoke("portal.list", {});
    expect(writeResponse.mock.calls[0]?.[1]).toEqual({ portals: [portal] });

    const adminResponse = await harness(service, ["operator.admin"]).invoke("portal.list", {});
    expect(adminResponse.mock.calls[0]?.[1]).toEqual({ portals: [portal] });
  });

  it("rejects malformed requests before service access and reports absent transports", async () => {
    const service: GatewayPortalService = {
      list: vi.fn(() => []),
      open: vi.fn(),
      close: vi.fn(),
      closeAll: vi.fn(),
    };
    const invalid = await harness(service).invoke("portal.open", { port: 0 });
    expect(invalid).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(service.open).not.toHaveBeenCalled();

    const unavailable = await harness().invoke("portal.list", {});
    expect(unavailable).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST", message: "portals unavailable" }),
    );
  });

  it("returns Error messages without the Error prefix", async () => {
    const service: GatewayPortalService = {
      list: () => [],
      open: vi.fn(async () => {
        throw new Error("portal bind failed");
      }),
      close: vi.fn(async () => {}),
      closeAll: vi.fn(async () => {}),
    };

    const response = await harness(service).invoke("portal.open", { port: 3000 });
    expect(response).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: "portal bind failed" }),
    );
  });

  it("delivers portal changes only to read-capable operators", () => {
    const events = new Map<string, string[]>();
    const client = (id: string, role: "node" | "operator", scopes: string[]): GatewayWsClient => {
      events.set(id, []);
      return {
        connId: id,
        usesSharedGatewayAuth: false,
        connect: { role, scopes } as GatewayWsClient["connect"],
        socket: {
          readyState: WebSocket.OPEN,
          bufferedAmount: 0,
          close: vi.fn(),
          send: (value: string) =>
            events.get(id)?.push((JSON.parse(value) as { event: string }).event),
        } as never,
      };
    };
    const clients = new Set([
      client("pairing", "operator", ["operator.pairing"]),
      client("node", "node", ["operator.read"]),
      client("read", "operator", ["operator.read"]),
      client("write", "operator", ["operator.write"]),
    ]);
    createGatewayBroadcaster({ clients }).broadcast("portal.changed", { portals: [portal] });

    expect(events.get("pairing")).toEqual([]);
    expect(events.get("node")).toEqual([]);
    expect(events.get("read")).toEqual(["portal.changed"]);
    expect(events.get("write")).toEqual(["portal.changed"]);
  });
});
