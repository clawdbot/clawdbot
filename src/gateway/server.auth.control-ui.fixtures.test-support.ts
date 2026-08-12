import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import {
  createSignedDevice,
  startTestGatewayServer,
  startServer,
  startServerWithClient,
  TEST_OPERATOR_CLIENT,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

const operatorIdentityPathByPrefix = new Map<string, string>();

export function expectArrayIncludes(actual: unknown, expectedValues: string[]): void {
  expect(Array.isArray(actual)).toBe(true);
  const values = actual as unknown[];
  for (const expected of expectedValues) {
    expect(values).toContain(expected);
  }
}

export const buildSignedDeviceForIdentity = async (params: {
  identityPath: string;
  client: { id: string; mode: string };
  nonce: string;
  scopes: string[];
  role?: "operator" | "node";
}) => {
  const { device } = await createSignedDevice({
    token: "secret",
    scopes: params.scopes,
    clientId: params.client.id,
    clientMode: params.client.mode,
    role: params.role ?? "operator",
    identityPath: params.identityPath,
    nonce: params.nonce,
  });
  return device;
};

export const REMOTE_BOOTSTRAP_HEADERS = {
  "x-forwarded-for": "10.0.0.14",
};

export const createOperatorIdentityFixture = async (identityPrefix: string) => {
  const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
  let identityPath = operatorIdentityPathByPrefix.get(identityPrefix);
  if (!identityPath) {
    const poolId = process.env.VITEST_POOL_ID ?? "0";
    identityPath = path.join(os.tmpdir(), `${identityPrefix}${process.pid}-${poolId}.sqlite`);
    operatorIdentityPathByPrefix.set(identityPrefix, identityPath);
  }
  const identity = loadOrCreateDeviceIdentity({ path: identityPath });
  return {
    identityPath,
    identity,
    client: { ...TEST_OPERATOR_CLIENT },
  };
};

export const startControlUiServerWithOperatorIdentity = async (
  identityPrefix = "openclaw-device-scope-",
) => {
  const { server, port, prevToken } = await startControlUiServer("secret");
  const { identityPath, identity, client } = await createOperatorIdentityFixture(identityPrefix);
  return { server, port, prevToken, identityPath, identity, client };
};

export const withControlUiGatewayServer = async <T>(
  fn: (ctx: {
    port: number;
    server: Awaited<ReturnType<typeof startTestGatewayServer>>;
  }) => Promise<T>,
): Promise<T> => {
  return await withGatewayServer(fn, {
    serverOptions: { controlUiEnabled: true },
  });
};

export const startControlUiServerWithClient = async (
  token?: string,
  opts?: Parameters<typeof startServerWithClient>[1],
) => {
  return await startServerWithClient(token, {
    ...opts,
    controlUiEnabled: true,
  });
};

export const startControlUiServer = async (
  token?: string,
  opts?: Parameters<typeof startServer>[1],
) => {
  return await startServer(token, {
    ...opts,
    controlUiEnabled: true,
  });
};

// Tampers with the persisted paired record through the store seam to

export const seedApprovedOperatorReadPairing = async (params: {
  identityPrefix: string;
  clientId: string;
  clientMode: string;
  displayName: string;
  platform: string;
  scopes?: string[];
}): Promise<{ identityPath: string; identity: { deviceId: string } }> => {
  const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
  const { approveDevicePairing, requestDevicePairing } = await import("../infra/device-pairing.js");
  const { identityPath, identity } = await createOperatorIdentityFixture(params.identityPrefix);
  const scopes = params.scopes ?? ["operator.read"];
  const devicePublicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const seeded = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: devicePublicKey,
    role: "operator",
    scopes,
    clientId: params.clientId,
    clientMode: params.clientMode,
    displayName: params.displayName,
    platform: params.platform,
  });
  await approveDevicePairing(seeded.request.requestId, {
    callerScopes: ["operator.admin"],
  });
  return { identityPath, identity: { deviceId: identity.deviceId } };
};
