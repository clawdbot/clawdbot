import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeUpgradeResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
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

const FULL_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
];

const ROLE_SCOPE_CASES = [
  {
    name: "admin implies the full Control UI scope set",
    allowedScopes: ["operator.admin"],
    scopes: FULL_SCOPES,
    allowed: true,
  },
  {
    name: "write implies read and talk",
    allowedScopes: ["operator.write"],
    scopes: ["operator.read", "operator.talk"],
    allowed: true,
  },
  {
    name: "exact scopes within the guest ceiling",
    allowedScopes: GUEST_ROLE.scopes,
    scopes: GUEST_ROLE.scopes,
    allowed: true,
  },
  {
    name: "no operator role policy",
    allowedScopes: undefined,
    scopes: FULL_SCOPES,
    allowed: true,
  },
  {
    name: "guest cannot request admin",
    allowedScopes: GUEST_ROLE.scopes,
    scopes: FULL_SCOPES,
    allowed: false,
  },
  {
    name: "empty ceiling denies read",
    allowedScopes: [],
    scopes: ["operator.read"],
    allowed: false,
  },
  {
    name: "read does not imply write",
    allowedScopes: ["operator.read"],
    scopes: ["operator.read", "operator.write"],
    allowed: false,
  },
  {
    name: "write does not imply approvals",
    allowedScopes: ["operator.write"],
    scopes: ["operator.read", "operator.approvals"],
    allowed: false,
  },
];

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

  describe.each(ROLE_SCOPE_CASES)("$name", ({ allowedScopes, scopes, allowed }) => {
    const rolePolicy = allowedScopes ? { ...GUEST_ROLE, scopes: allowedScopes } : undefined;
    const roleDenial = expect.objectContaining({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("assigned operator role"),
    });

    it("enforces the ceiling when requesting approval", async () => {
      resolveOperatorRolePolicyMock.mockReturnValue(rolePolicy);

      const { respond, context } = await runUpgradeHandler("device.scopes.requestUpgrade", {
        scopes,
      });

      expect(respond).toHaveBeenCalledOnce();
      if (!allowed) {
        expect(respond).toHaveBeenCalledWith(false, undefined, roleDenial);
        expect(requestDevicePairingMock).not.toHaveBeenCalled();
        expect(context.scopeUpgradeCoordinator.register).not.toHaveBeenCalled();
        return;
      }
      expect(respond).toHaveBeenCalledWith(true, { requestId: "request-1" }, undefined);
      expect(requestDevicePairingMock).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: scopes.toSorted(), silent: false }),
      );
      expect(context.scopeUpgradeCoordinator.register).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "request-1",
          owner: { deviceId: "device-1", publicKey: "public-key-1" },
          requestedScopes: scopes.toSorted(),
          initialToken: "old-token",
          initialApprovedAtMs: 1,
        }),
      );
    });

    it("uses the current role after waiting before disclosing the approved token", async () => {
      const context = createUpgradeContext();
      const approval = createDeferred<ScopeUpgradeResult>();
      context.scopeUpgradeCoordinator.wait.mockReturnValue(approval.promise);
      resolveOperatorRolePolicyMock.mockReturnValue({
        ...GUEST_ROLE,
        scopes: allowed ? [] : ["operator.admin"],
      });
      const pending = runUpgradeHandler(
        "device.scopes.waitUpgrade",
        { requestId: "request-1" },
        context,
      );
      expect(context.scopeUpgradeCoordinator.wait).toHaveBeenCalledWith("request-1", {
        deviceId: "device-1",
        publicKey: "public-key-1",
      });
      resolveOperatorRolePolicyMock.mockReturnValue(rolePolicy);
      const result: ScopeUpgradeResult = {
        status: "approved",
        requestId: "request-1",
        deviceToken: "upgraded-token",
        scopes,
      };
      approval.resolve(result);
      const { respond } = await pending;

      expect(respond).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(
        allowed,
        allowed ? result : undefined,
        allowed ? undefined : roleDenial,
      );
    });
  });

  it.each(["rejected", "expired"] as const)("returns an unchanged %s result", async (status) => {
    resolveOperatorRolePolicyMock.mockReturnValue({ ...GUEST_ROLE, scopes: [] });
    const context = createUpgradeContext();
    const result: ScopeUpgradeResult = { status, requestId: "request-1" };
    context.scopeUpgradeCoordinator.wait.mockResolvedValue(result);

    const { respond } = await runUpgradeHandler(
      "device.scopes.waitUpgrade",
      { requestId: "request-1" },
      context,
    );

    expect(respond).toHaveBeenCalledWith(true, result, undefined);
  });

  it.each([
    { scopes: ["operator.read", "operator.unknown"], message: "unknown operator scope" },
    { scopes: ["operator.approvals"], message: "current scopes" },
  ])("rejects $message even with an admin ceiling", async ({ scopes, message }) => {
    resolveOperatorRolePolicyMock.mockReturnValue({ ...GUEST_ROLE, scopes: FULL_SCOPES });

    const { respond } = await runUpgradeHandler("device.scopes.requestUpgrade", { scopes });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining(message),
      }),
    );
    expect(requestDevicePairingMock).not.toHaveBeenCalled();
  });
});
