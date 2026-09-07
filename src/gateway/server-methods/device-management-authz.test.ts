import { describe, expect, it } from "vitest";
import { resolveDeviceSessionAuthz } from "./device-management-authz.js";
import type { GatewayClient } from "./types.js";

function client(overrides: Partial<GatewayClient>): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "browser",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.pairing"],
      device: {
        id: "browser-1",
        publicKey: "public-key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
    },
    ...overrides,
  };
}

describe("device management authz", () => {
  it("keeps ordinary shared-auth device metadata untrusted", () => {
    expect(resolveDeviceSessionAuthz(client({}))).toEqual({
      callerDeviceId: null,
      callerScopes: ["operator.admin", "operator.pairing"],
      isAdminCaller: true,
    });
  });

  it("keeps device-token self-service behavior unchanged", () => {
    expect(resolveDeviceSessionAuthz(client({ isDeviceTokenAuth: true }))).toEqual({
      callerDeviceId: "browser-1",
      callerScopes: ["operator.admin", "operator.pairing"],
      isAdminCaller: true,
    });
  });
});
