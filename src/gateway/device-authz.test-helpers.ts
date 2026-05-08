import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { WebSocket } from "ws";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  type DeviceIdentity,
} from "../infra/device-identity.js";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
  rotateDeviceToken,
} from "../infra/device-pairing.js";
import { trackConnectChallengeNonce } from "./test-helpers.js";

export function resolveDeviceIdentityPath(name: string): string {
  const root = process.env.OPENCLAW_STATE_DIR ?? process.env.HOME ?? os.tmpdir();
  return path.join(root, "test-device-identities", `${name}.json`);
}

export function loadDeviceIdentity(name: string): {
  identityPath: string;
  identity: DeviceIdentity;
  publicKey: string;
} {
  const identityPath = resolveDeviceIdentityPath(name);
  const identity = loadOrCreateDeviceIdentity(identityPath);
  return {
    identityPath,
    identity,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
  };
}

export async function pairDeviceIdentity(params: {
  name: string;
  role: "node" | "operator";
  scopes: string[];
  clientId?: string;
  clientMode?: string;
}): Promise<{
  identityPath: string;
  identity: DeviceIdentity;
  publicKey: string;
}> {
  const loaded = loadDeviceIdentity(params.name);
  const request = await requestDevicePairing({
    deviceId: loaded.identity.deviceId,
    publicKey: loaded.publicKey,
    role: params.role,
    scopes: params.scopes,
    clientId: params.clientId,
    clientMode: params.clientMode,
  });
  await approveDevicePairing(request.request.requestId, {
    callerScopes: params.scopes,
  });
  return loaded;
}

export async function issueOperatorToken(params: {
  name: string;
  approvedScopes: string[];
  tokenScopes?: string[];
  clientId?: string;
  clientMode?: string;
}): Promise<{
  deviceId: string;
  identityPath: string;
  token: string;
}> {
  const paired = await pairDeviceIdentity({
    name: params.name,
    role: "operator",
    scopes: params.approvedScopes,
    clientId: params.clientId,
    clientMode: params.clientMode,
  });
  if (params.tokenScopes) {
    const rotated = await rotateDeviceToken({
      deviceId: paired.identity.deviceId,
      role: "operator",
      scopes: params.tokenScopes,
    });
    expect(rotated.ok).toBe(true);
    const token = rotated.ok ? rotated.entry.token : "";
    if (!token) {
      throw new Error(`expected rotated operator token for device ${paired.identity.deviceId}`);
    }
    return {
      deviceId: paired.identity.deviceId,
      identityPath: paired.identityPath,
      token,
    };
  }

  const device = await getPairedDevice(paired.identity.deviceId);
  const token = device?.tokens?.operator?.token ?? "";
  if (!token) {
    throw new Error(`expected operator token for paired device ${paired.identity.deviceId}`);
  }
  expect(device?.approvedScopes).toEqual(params.approvedScopes);
  return {
    deviceId: paired.identity.deviceId,
    identityPath: paired.identityPath,
    token,
  };
}

export async function openTrackedWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws open")), 5_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return ws;
}
