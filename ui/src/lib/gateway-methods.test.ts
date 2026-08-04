import { describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { canCallGatewayMethod } from "./gateway-methods.ts";

function snapshot(params: {
  connected?: boolean;
  methods?: string[];
  scopes?: string[];
  includeAuth?: boolean;
  includeScopes?: boolean;
}): ApplicationGatewaySnapshot {
  const connected = params.connected ?? true;
  return {
    client: connected ? ({} as ApplicationGatewaySnapshot["client"]) : null,
    phase: connected ? "connected" : "offline",
    offlineStable: !connected,
    hello: {
      auth:
        params.includeAuth === false
          ? undefined
          : {
              role: "operator",
              scopes:
                params.includeScopes === false ? undefined : (params.scopes ?? ["operator.admin"]),
            },
      features: params.methods === undefined ? {} : { methods: params.methods },
    } as ApplicationGatewaySnapshot["hello"],
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
}

describe("canCallGatewayMethod", () => {
  it("requires a connected client", () => {
    expect(
      canCallGatewayMethod(snapshot({ connected: false }), "skills.update", "operator.admin"),
    ).toBe(false);
  });

  it("blocks an explicitly unavailable method", () => {
    expect(
      canCallGatewayMethod(
        snapshot({ methods: [], scopes: ["operator.admin"] }),
        "skills.update",
        "operator.admin",
      ),
    ).toBe(false);
  });

  it("blocks an explicitly insufficient scope", () => {
    expect(
      canCallGatewayMethod(
        snapshot({ methods: ["skills.update"], scopes: ["operator.write"] }),
        "skills.update",
        "operator.admin",
      ),
    ).toBe(false);
  });

  it("honors operator scope implications", () => {
    const current = snapshot({
      methods: ["doctor.memory.backfillDreamDiary"],
      scopes: ["operator.write"],
    });
    expect(
      canCallGatewayMethod(current, "doctor.memory.backfillDreamDiary", "operator.write"),
    ).toBe(true);
    expect(canCallGatewayMethod(current, "doctor.memory.backfillDreamDiary", "operator.read")).toBe(
      true,
    );
  });

  it("preserves legacy behavior when methods or auth scopes are omitted", () => {
    expect(
      canCallGatewayMethod(snapshot({ includeAuth: false }), "skills.update", "operator.admin"),
    ).toBe(true);
    expect(
      canCallGatewayMethod(
        snapshot({ methods: ["skills.update"], includeScopes: false }),
        "skills.update",
        "operator.admin",
      ),
    ).toBe(true);
  });

  it("supports registered methods that are intentionally not advertised", () => {
    expect(
      canCallGatewayMethod(
        snapshot({ methods: [], scopes: ["operator.admin"] }),
        "config.openFile",
        "operator.admin",
        { requireAdvertisement: false },
      ),
    ).toBe(true);
  });
});
