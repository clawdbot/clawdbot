import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks();

const { callGateway } = await import("./call.js");
const { probeGateway } = await import("./probe.js");
const { storeDeviceAuthToken } = await import("../infra/device-auth-store.js");
const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem } =
  await import("../infra/device-identity.js");
const { approveDevicePairing, requestDevicePairing } = await import("../infra/device-pairing.js");

function requireGatewayToken(): string {
  const token =
    typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
      ? ((testState.gatewayAuth as { token?: string }).token ?? "")
      : "";
  expect(token).toBeTruthy();
  return token;
}

function statePath(...parts: string[]): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  expect(stateDir).toBeTruthy();
  return path.join(stateDir ?? "", ...parts);
}

async function seedCachedOperatorToken(scopes: string[]): Promise<void> {
  const identity = loadOrCreateDeviceIdentity();
  const pairing = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    displayName: "vitest probe",
    platform: process.platform,
    clientId: "test",
    clientMode: "probe",
    role: "operator",
    scopes,
    silent: true,
  });
  const approved = await approveDevicePairing(pairing.request.requestId, {
    callerScopes: scopes,
  });
  expect(approved?.status).toBe("approved");
  const token =
    approved?.status === "approved" ? (approved.device.tokens?.operator?.token ?? "") : "";
  expect(token).toBeTruthy();
  storeDeviceAuthToken({
    deviceId: identity.deviceId,
    role: "operator",
    token,
    scopes,
  });
}

describe("probeGateway auth integration", () => {
  it("keeps direct local authenticated status RPCs device-bound", async () => {
    const token = requireGatewayToken();

    await withGatewayServer(async ({ port }) => {
      const status = await callGateway({
        url: `ws://127.0.0.1:${port}`,
        token,
        method: "status",
        timeoutMs: 5_000,
      });

      expect(status).toBeTruthy();
    });
  });

  it("keeps first-time local authenticated probes non-mutating", async () => {
    const token = requireGatewayToken();

    await withGatewayServer(async ({ port }) => {
      const result = await probeGateway({
        url: `ws://127.0.0.1:${port}`,
        auth: { token },
        timeoutMs: 5_000,
      });

      expect(result.ok).toBe(false);
      expect(result.health).toBeNull();
      expect(result.status).toBeNull();
      expect(result.configSnapshot).toBeNull();
      expect(result.auth.capability).toBe("connected_no_operator_scope");
      expect(fs.existsSync(statePath("devices", "paired.json"))).toBe(false);
      expect(fs.existsSync(statePath("devices", "pending.json"))).toBe(false);
      expect(fs.existsSync(statePath("identity", "device-auth.json"))).toBe(false);
    });
  });

  it("keeps detail RPCs available for local authenticated probes with cached device auth", async () => {
    const token = requireGatewayToken();
    await seedCachedOperatorToken(["operator.read"]);

    await withGatewayServer(async ({ port }) => {
      const result = await probeGateway({
        url: `ws://127.0.0.1:${port}`,
        auth: { token },
        timeoutMs: 5_000,
      });

      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(result.health).not.toBeNull();
      expect(result.status).not.toBeNull();
      expect(result.configSnapshot).not.toBeNull();
    });
  });
});
