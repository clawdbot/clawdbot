// Device pairing approval tests cover operator pairing scopes, trusted-proxy
// admin flows, pending pairing state, and approval authorization.
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  getPairedDevice,
  getPendingDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

await Promise.all([
  import("./server.js"),
  import("../infra/device-identity.js"),
  import("../infra/device-pairing.js"),
]);

const CONTROL_UI_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
  version: "1.0.0",
  platform: "web",
  mode: GATEWAY_CLIENT_MODES.WEBCHAT,
};
const TRUSTED_PROXY_ORIGIN = "https://localhost";
const TRUSTED_PROXY_HEADERS = {
  origin: TRUSTED_PROXY_ORIGIN,
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
  "x-forwarded-user": "operator@example.com",
};

async function issuePairingOnlyOperator(name: string) {
  return await issueOperatorToken({
    name,
    approvedScopes: ["operator.admin"],
    tokenScopes: ["operator.pairing"],
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
}

async function issueAdminOperator(name: string) {
  return await issueOperatorToken({
    name,
    approvedScopes: ["operator.admin"],
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
}

async function requestOperatorDevicePairing(params: {
  identity: ReturnType<typeof loadDeviceIdentity>;
  scopes: string[];
}) {
  return await requestDevicePairingForRole({
    identity: params.identity,
    role: "operator",
    scopes: params.scopes,
  });
}

async function requestDevicePairingForRole(params: {
  identity: ReturnType<typeof loadDeviceIdentity>;
  role: "node" | "operator";
  scopes: string[];
  roles?: string[];
}) {
  return await requestDevicePairing({
    deviceId: params.identity.identity.deviceId,
    publicKey: params.identity.publicKey,
    role: params.role,
    roles: params.roles,
    scopes: params.scopes,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
  });
}

async function openPairingSession(
  port: number,
  operator: Awaited<ReturnType<typeof issueOperatorToken>>,
): Promise<WebSocket> {
  const pairingWs = await openTrackedWs(port);
  await connectOk(pairingWs, {
    skipDefaultAuth: true,
    deviceToken: operator.token,
    deviceIdentityPath: operator.identityPath,
    scopes: ["operator.pairing"],
  });
  return pairingWs;
}

async function openSharedAuthPairingSession(
  port: number,
  operator: Awaited<ReturnType<typeof issueOperatorToken>>,
  scopes: string[],
): Promise<WebSocket> {
  const pairingWs = await openTrackedWs(port);
  await connectOk(pairingWs, {
    token: "secret",
    deviceIdentityPath: operator.identityPath,
    scopes,
  });
  return pairingWs;
}

async function startTrustedProxyServerWithClient(scopes: string[]) {
  const { replaceConfigFile } = await import("../config/config.js");
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  await replaceConfigFile({
    nextConfig: {
      gateway: {
        auth,
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: [TRUSTED_PROXY_ORIGIN],
        },
      },
    },
    afterWrite: { mode: "auto" },
  });
  return await startServerWithClient(undefined, {
    auth,
    wsHeaders: {
      ...TRUSTED_PROXY_HEADERS,
      "x-openclaw-scopes": scopes.join(","),
    },
  });
}

async function openTrustedProxyPairingSession(
  port: number,
  operator: Awaited<ReturnType<typeof issueOperatorToken>>,
  scopes: string[],
): Promise<WebSocket> {
  const pairingWs = await openTrackedWs(port, {
    ...TRUSTED_PROXY_HEADERS,
    "x-openclaw-scopes": scopes.join(","),
  });
  await connectOk(pairingWs, {
    skipDefaultAuth: true,
    client: CONTROL_UI_CLIENT,
    deviceIdentityPath: operator.identityPath,
    scopes,
  });
  return pairingWs;
}

type StartedGateway = Awaited<ReturnType<typeof startServerWithClient>>;
type LoadedDeviceIdentity = ReturnType<typeof loadDeviceIdentity>;
type PendingPairingRequest = Awaited<ReturnType<typeof requestDevicePairing>>;
type IssuedOperatorToken = Awaited<ReturnType<typeof issueOperatorToken>>;

async function openSharedAuthApprovalSession(params: {
  port: number;
  approver: IssuedOperatorToken;
  pending: LoadedDeviceIdentity;
  role: "node" | "operator";
  roles?: string[];
  scopes: string[];
}) {
  const request = await requestDevicePairingForRole({
    identity: params.pending,
    role: params.role,
    roles: params.roles,
    scopes: params.scopes,
  });
  const pairingWs = await openSharedAuthPairingSession(params.port, params.approver, [
    "operator.pairing",
  ]);
  return { request, pairingWs };
}

async function approvePairingRequest(pairingWs: WebSocket, request: PendingPairingRequest) {
  return await rpcReq(pairingWs, "device.pair.approve", {
    requestId: request.request.requestId,
  });
}

async function rejectPairingRequest(pairingWs: WebSocket, request: PendingPairingRequest) {
  return await rpcReq(pairingWs, "device.pair.reject", {
    requestId: request.request.requestId,
  });
}

async function expectDeviceNotPaired(identity: LoadedDeviceIdentity) {
  const paired = await getPairedDevice(identity.identity.deviceId);
  expect(paired).toBeNull();
}

async function expectPairedDeviceScopes(identity: LoadedDeviceIdentity, scopes: string[]) {
  const paired = await getPairedDevice(identity.identity.deviceId);
  expect(paired?.approvedScopes).toEqual(scopes);
  return paired;
}

async function expectApprovalDeniedAndUnpaired(params: {
  pairingWs: WebSocket;
  request: PendingPairingRequest;
  pending: LoadedDeviceIdentity;
}) {
  const approve = await approvePairingRequest(params.pairingWs, params.request);
  expect(approve.ok).toBe(false);
  expect(approve.error?.message).toBe("device pairing approval denied");
  await expectDeviceNotPaired(params.pending);
}

async function closePairingTest(started: StartedGateway, pairingWs?: WebSocket) {
  pairingWs?.close();
  started.ws.close();
  await started.server.close();
  started.envSnapshot.restore();
}

describe("gateway device.pair.approve caller scope guard", () => {
  test("rejects approving device scopes above the caller session scopes", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issuePairingOnlyOperator("approve-attacker");
    const approverIdentity = loadDeviceIdentity("approve-attacker");

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestOperatorDevicePairing({
        identity: approverIdentity,
        scopes: ["operator.admin"],
      });
      pairingWs = await openPairingSession(started.port, approver);

      const approve = await approvePairingRequest(pairingWs, request);
      expect(approve.ok).toBe(false);
      expect(approve.error?.message).toBe("missing scope: operator.admin");

      await expectPairedDeviceScopes(approverIdentity, ["operator.admin"]);
    } finally {
      await closePairingTest(started, pairingWs);
    }
  });

  test("rejects node-role approval from a non-admin shared-auth session", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issuePairingOnlyOperator("approve-shared-node-attacker");
    const pending = loadDeviceIdentity("approve-shared-node-target");

    let pairingWs: WebSocket | undefined;
    try {
      const session = await openSharedAuthApprovalSession({
        port: started.port,
        approver,
        pending,
        role: "node",
        scopes: [],
      });
      pairingWs = session.pairingWs;

      await expectApprovalDeniedAndUnpaired({ pairingWs, request: session.request, pending });
    } finally {
      await closePairingTest(started, pairingWs);
    }
  });

  test("allows operator-role approval from a non-admin shared-auth session", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issuePairingOnlyOperator("approve-shared-operator-approver");
    const pending = loadDeviceIdentity("approve-shared-operator-target");

    let pairingWs: WebSocket | undefined;
    try {
      const session = await openSharedAuthApprovalSession({
        port: started.port,
        approver,
        pending,
        role: "operator",
        scopes: ["operator.pairing"],
      });
      pairingWs = session.pairingWs;

      const approve = await approvePairingRequest(pairingWs, session.request);
      expect(approve.ok).toBe(true);

      const paired = await getPairedDevice(pending.identity.deviceId);
      expect(paired?.role).toBe("operator");
      expect(paired?.tokens?.operator?.scopes).toEqual(["operator.pairing"]);
    } finally {
      await closePairingTest(started, pairingWs);
    }
  });

  test("rejects mixed operator/node approval from a non-admin shared-auth session", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issuePairingOnlyOperator("approve-shared-mixed-attacker");
    const pending = loadDeviceIdentity("approve-shared-mixed-target");

    let pairingWs: WebSocket | undefined;
    try {
      const session = await openSharedAuthApprovalSession({
        port: started.port,
        approver,
        pending,
        role: "operator",
        roles: ["operator", "node"],
        scopes: ["operator.pairing"],
      });
      pairingWs = session.pairingWs;

      await expectApprovalDeniedAndUnpaired({ pairingWs, request: session.request, pending });
    } finally {
      await closePairingTest(started, pairingWs);
    }
  });

  test("rejects node-role approval from a non-admin trusted-proxy Control UI session", async () => {
    const started = await startTrustedProxyServerWithClient(["operator.pairing"]);
    const approver = await issuePairingOnlyOperator("approve-proxy-node-attacker");
    const pending = loadDeviceIdentity("approve-proxy-node-target");

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestDevicePairingForRole({
        identity: pending,
        role: "node",
        scopes: [],
      });
      pairingWs = await openTrustedProxyPairingSession(started.port, approver, [
        "operator.pairing",
      ]);

      await expectApprovalDeniedAndUnpaired({ pairingWs, request, pending });
    } finally {
      await closePairingTest(started, pairingWs);
    }
  });

  test("allows node-role approval from an admin trusted-proxy Control UI session", async () => {
    const started = await startTrustedProxyServerWithClient(["operator.admin"]);
    const approver = await issueAdminOperator("approve-proxy-node-admin");
    const pending = loadDeviceIdentity("approve-proxy-node-admin-target");

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestDevicePairingForRole({
        identity: pending,
        role: "node",
        scopes: [],
      });
      pairingWs = await openTrustedProxyPairingSession(started.port, approver, ["operator.admin"]);

      const approve = await approvePairingRequest(pairingWs, request);
      expect(approve.ok).toBe(true);

      const paired = await getPairedDevice(pending.identity.deviceId);
      expect(paired?.role).toBe("node");
      expect(paired?.tokens?.node?.role).toBe("node");
    } finally {
      await closePairingTest(started, pairingWs);
    }
  });

  test("rejects approving another device from a non-admin paired-device session", async () => {
    const started = await startServerWithClient("secret");
    const approver = await issuePairingOnlyOperator("approve-cross-device-attacker");
    const pending = loadDeviceIdentity("approve-cross-device-target");

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestOperatorDevicePairing({
        identity: pending,
        scopes: ["operator.pairing"],
      });
      pairingWs = await openPairingSession(started.port, approver);

      await expectApprovalDeniedAndUnpaired({ pairingWs, request, pending });
    } finally {
      await closePairingTest(started, pairingWs);
    }
  });

  test("rejects rejecting another device from a non-admin paired-device session", async () => {
    const started = await startServerWithClient("secret");
    const attacker = await issuePairingOnlyOperator("reject-cross-device-attacker");
    const pending = loadDeviceIdentity("reject-cross-device-target");

    let pairingWs: WebSocket | undefined;
    try {
      const request = await requestOperatorDevicePairing({
        identity: pending,
        scopes: ["operator.pairing"],
      });
      pairingWs = await openPairingSession(started.port, attacker);

      const reject = await rejectPairingRequest(pairingWs, request);
      expect(reject.ok).toBe(false);
      expect(reject.error?.message).toBe("device pairing rejection denied");

      const stillPending = await getPendingDevicePairing(request.request.requestId);
      expect(stillPending?.requestId).toBe(request.request.requestId);
    } finally {
      await closePairingTest(started, pairingWs);
    }
  });
});
