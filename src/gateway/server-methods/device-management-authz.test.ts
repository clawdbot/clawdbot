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
  it("binds a migration session to its signed device without admin power", () => {
    expect(
      resolveDeviceSessionAuthz(
        client({
          isControlUiDeviceAuthMigrationSession: true,
          isControlUiDeviceAuthMigration: true,
        }),
      ),
    ).toEqual({
      callerDeviceId: "browser-1",
      callerScopes: ["operator.admin", "operator.pairing"],
      isAdminCaller: false,
      isDeviceAuthMigrationCaller: true,
      isDeviceAuthMigrationSession: true,
    });
  });

  it("withholds device-management admin power from a device-less migration session", () => {
    expect(
      resolveDeviceSessionAuthz(
        client({
          isControlUiDeviceAuthMigrationSession: true,
          connect: {
            ...client({}).connect,
            device: undefined,
          },
        }),
      ),
    ).toMatchObject({
      callerDeviceId: null,
      isAdminCaller: false,
      isDeviceAuthMigrationCaller: false,
      isDeviceAuthMigrationSession: true,
    });
  });

  it("keeps ordinary shared-auth device metadata untrusted", () => {
    expect(resolveDeviceSessionAuthz(client({}))).toMatchObject({
      callerDeviceId: null,
      isAdminCaller: true,
      isDeviceAuthMigrationCaller: false,
    });
  });

  it("keeps device-token self-service behavior unchanged", () => {
    expect(resolveDeviceSessionAuthz(client({ isDeviceTokenAuth: true }))).toMatchObject({
      callerDeviceId: "browser-1",
      isAdminCaller: true,
      isDeviceAuthMigrationCaller: false,
    });
  });
});
