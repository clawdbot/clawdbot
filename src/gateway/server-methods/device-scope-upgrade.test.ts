import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";

const { getPairedDeviceMock, requestDevicePairingMock, resolveOperatorRolePolicyMock } = vi.hoisted(
  () => ({
    getPairedDeviceMock: vi.fn(),
    requestDevicePairingMock: vi.fn(),
    resolveOperatorRolePolicyMock: vi.fn(),
  }),
);

vi.mock("../../infra/device-pairing.js", () => ({
  getPairedDevice: getPairedDeviceMock,
  requestDevicePairing: requestDevicePairingMock,
}));

vi.mock("../operator-role-policy.js", () => ({
  resolveOperatorRolePolicy: resolveOperatorRolePolicyMock,
}));

import { scopeUpgradeHandlers } from "./device-scope-upgrade.js";

const GUEST_ROLE = {
  sessions: { others: "view" },
  agents: "*",
  scopes: ["operator.read", "operator.write"],
} satisfies GatewayOperatorRoleDefinition;

function createUpgradeContext() {
  const coordinator = {
    register: vi.fn(() => true),
    notify: vi.fn(),
    wait: vi.fn(),
  };
  return {
    broadcast: vi.fn(),
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn() },
    scopeUpgradeCoordinator: coordinator,
  };
}

function createUpgradeClient() {
  return {
    connId: "connection-1",
    authenticatedUserProfile: { profileId: "profile-1" },
    connect: {
      role: "operator",
      scopes: ["operator.read"],
      device: { id: "device-1", publicKey: "public-key-1" },
      client: { id: "control-ui", platform: "test", mode: "webchat" },
    },
  };
}

async function runUpgradeHandler(
  method: "device.scopes.requestUpgrade" | "device.scopes.waitUpgrade",
  params: Record<string, unknown>,
  context = createUpgradeContext(),
) {
  const respond = vi.fn();
  const client = createUpgradeClient();
  await expectDefined(
    scopeUpgradeHandlers[method],
    `${method} handler`,
  )({
    params,
    respond,
    context,
    client,
  } as never);
  return { respond, context, client };
}

describe("device scope upgrade role ceiling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPairedDeviceMock.mockResolvedValue({
      deviceId: "device-1",
      publicKey: "public-key-1",
      approvedAtMs: 1,
      tokens: { operator: { token: "old-token", scopes: ["operator.read"] } },
    });
    requestDevicePairingMock.mockResolvedValue({
      request: { requestId: "request-1" },
      expiresAtMs: Date.now() + 60_000,
      created: false,
    });
    resolveOperatorRolePolicyMock.mockReturnValue(undefined);
  });

  it("rejects scope requests outside the authenticated person's assigned role", async () => {
    resolveOperatorRolePolicyMock.mockReturnValue(GUEST_ROLE);

    const { respond } = await runUpgradeHandler("device.scopes.requestUpgrade", {
      scopes: ["operator.read", "operator.admin"],
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("assigned operator role"),
      }),
    );
    expect(requestDevicePairingMock).not.toHaveBeenCalled();
  });

  it("allows additional scopes that remain inside the assigned role ceiling", async () => {
    resolveOperatorRolePolicyMock.mockReturnValue(GUEST_ROLE);

    const { respond } = await runUpgradeHandler("device.scopes.requestUpgrade", {
      scopes: ["operator.read", "operator.write"],
    });

    expect(respond).toHaveBeenCalledWith(true, { requestId: "request-1" }, undefined);
    expect(requestDevicePairingMock).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["operator.read", "operator.write"] }),
    );
  });

  it("preserves unrestricted upgrades when no operator role resolves", async () => {
    const { respond } = await runUpgradeHandler("device.scopes.requestUpgrade", {
      scopes: ["operator.read", "operator.admin"],
    });

    expect(respond).toHaveBeenCalledWith(true, { requestId: "request-1" }, undefined);
    expect(requestDevicePairingMock).toHaveBeenCalledOnce();
  });

  it("rechecks the current role after approval before disclosing a stronger device token", async () => {
    const context = createUpgradeContext();
    let finishApproval: ((result: object) => void) | undefined;
    context.scopeUpgradeCoordinator.wait.mockImplementation(
      async () =>
        await new Promise<object>((resolve) => {
          finishApproval = resolve;
        }),
    );
    const pending = runUpgradeHandler(
      "device.scopes.waitUpgrade",
      { requestId: "request-1" },
      context,
    );
    expect(finishApproval).toBeDefined();
    resolveOperatorRolePolicyMock.mockReturnValue(GUEST_ROLE);
    finishApproval?.({
      status: "approved",
      requestId: "request-1",
      deviceToken: "admin-token",
      scopes: ["operator.read", "operator.admin"],
    });
    const { respond } = await pending;

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("assigned operator role"),
      }),
    );
    expect(respond.mock.calls[0]?.[1]).toBeUndefined();
  });
});
