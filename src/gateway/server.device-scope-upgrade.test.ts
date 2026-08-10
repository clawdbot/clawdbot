import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { issueOperatorToken, openTrackedWs } from "./device-authz.test-helpers.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startConnectedServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

await import("./server.js");

const FULL_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
];

describe("live device scope upgrade", () => {
  let started: Awaited<ReturnType<typeof startConnectedServerWithClient>>;

  beforeAll(async () => {
    started = await startConnectedServerWithClient("secret");
  });

  afterAll(async () => {
    started.ws.close();
    await started.server.close();
    started.envSnapshot.restore();
  });

  async function openLimitedDevice(name: string) {
    const paired = await issueOperatorToken({
      name,
      approvedScopes: ["operator.read"],
      clientId: GATEWAY_CLIENT_NAMES.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    const ws = await openTrackedWs(started.port);
    const hello = await connectOk(ws, {
      skipDefaultAuth: true,
      deviceToken: paired.token,
      deviceIdentityPath: paired.identityPath,
      scopes: ["operator.read"],
    });
    return { ...paired, ws, hello };
  }

  test("returns the rotated token after approval and reconnects with admin scopes", async () => {
    const limited = await openLimitedDevice("live-scope-upgrade-approved");
    let reconnected: Awaited<ReturnType<typeof openTrackedWs>> | undefined;
    try {
      const registration = await rpcReq<{ requestId: string }>(
        limited.ws,
        "device.scopes.requestUpgrade",
        { scopes: FULL_SCOPES },
      );
      expect(registration.ok).toBe(true);
      const requestId = registration.payload?.requestId;
      expect(requestId).toBeTypeOf("string");

      const wait = rpcReq<{
        status: string;
        requestId: string;
        deviceToken: string;
        scopes: string[];
      }>(limited.ws, "device.scopes.waitUpgrade", { requestId }, 10_000);
      const pairingList = await rpcReq<{
        pending: Array<{ requestId: string; deviceId: string; scopes?: string[] }>;
      }>(started.ws, "device.pair.list", {});
      const pending = pairingList.payload?.pending.find((entry) => entry.requestId === requestId);
      expect(pending).toMatchObject({ deviceId: limited.deviceId, scopes: FULL_SCOPES.toSorted() });

      const approval = await rpcReq(started.ws, "device.pair.approve", { requestId });
      expect(approval.ok).toBe(true);
      const resolved = await wait;
      expect(resolved.ok).toBe(true);
      expect(resolved.payload).toMatchObject({
        status: "approved",
        requestId,
        scopes: expect.arrayContaining(["operator.admin"]),
      });
      expect(resolved.payload?.deviceToken).not.toBe(limited.token);

      limited.ws.close();
      reconnected = await openTrackedWs(started.port);
      const hello = await connectOk(reconnected, {
        skipDefaultAuth: true,
        deviceToken: resolved.payload?.deviceToken,
        deviceIdentityPath: limited.identityPath,
        scopes: resolved.payload?.scopes,
      });
      const auth = (hello as { auth?: { scopes?: string[] } }).auth;
      expect(auth?.scopes).toContain("operator.admin");
    } finally {
      limited.ws.close();
      reconnected?.close();
    }
  });

  test("returns a typed rejected result", async () => {
    const limited = await openLimitedDevice("live-scope-upgrade-rejected");
    try {
      const registration = await rpcReq<{ requestId: string }>(
        limited.ws,
        "device.scopes.requestUpgrade",
        { scopes: FULL_SCOPES },
      );
      const requestId = registration.payload?.requestId;
      const wait = rpcReq<{ status: string; requestId: string }>(
        limited.ws,
        "device.scopes.waitUpgrade",
        { requestId },
        10_000,
      );
      expect((await rpcReq(started.ws, "device.pair.reject", { requestId })).ok).toBe(true);
      expect(await wait).toMatchObject({
        ok: true,
        payload: { status: "rejected", requestId },
      });
    } finally {
      limited.ws.close();
    }
  });

  test("requires a signed device identity", async () => {
    const ws = await openTrackedWs(started.port);
    try {
      await connectOk(ws, {
        token: "secret",
        device: null,
        scopes: ["operator.read"],
        client: {
          id: GATEWAY_CLIENT_NAMES.CLI,
          version: "1.0.0",
          platform: "test",
          mode: GATEWAY_CLIENT_MODES.CLI,
        },
      });
      const response = await rpcReq(ws, "device.scopes.requestUpgrade", {
        scopes: FULL_SCOPES,
      });
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          details: {
            code: "DEVICE_IDENTITY_REQUIRED",
            recommendedNextStep: "reopen_control_ui_securely",
          },
        },
      });
    } finally {
      ws.close();
    }
  });

  test("rejects a requested scope set narrower than the live connection", async () => {
    const limited = await openLimitedDevice("live-scope-upgrade-narrower");
    try {
      const response = await rpcReq(limited.ws, "device.scopes.requestUpgrade", {
        scopes: ["operator.approvals"],
      });
      expect(response).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
      expect(response.error?.message).toContain("current scopes");
    } finally {
      limited.ws.close();
    }
  });

  test("returns the existing request id for an equivalent pending upgrade", async () => {
    const limited = await openLimitedDevice("live-scope-upgrade-idempotent");
    try {
      const first = await rpcReq<{ requestId: string }>(
        limited.ws,
        "device.scopes.requestUpgrade",
        { scopes: FULL_SCOPES },
      );
      const second = await rpcReq<{ requestId: string }>(
        limited.ws,
        "device.scopes.requestUpgrade",
        { scopes: FULL_SCOPES },
      );
      expect(second.payload?.requestId).toBe(first.payload?.requestId);
      const pairingList = await rpcReq<{
        pending: Array<{ requestId: string; deviceId: string }>;
      }>(started.ws, "device.pair.list", {});
      expect(
        pairingList.payload?.pending.filter((entry) => entry.deviceId === limited.deviceId),
      ).toHaveLength(1);
      expect(
        (
          await rpcReq(started.ws, "device.pair.reject", {
            requestId: first.payload?.requestId,
          })
        ).ok,
      ).toBe(true);
    } finally {
      limited.ws.close();
    }
  });

  test("does not disclose upgrade results to another authenticated device", async () => {
    const owner = await openLimitedDevice("live-scope-upgrade-owner");
    const other = await openLimitedDevice("live-scope-upgrade-other");
    try {
      const registration = await rpcReq<{ requestId: string }>(
        owner.ws,
        "device.scopes.requestUpgrade",
        { scopes: FULL_SCOPES },
      );
      const requestId = registration.payload?.requestId;
      const crossDeviceWait = await rpcReq(other.ws, "device.scopes.waitUpgrade", { requestId });
      expect(crossDeviceWait).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "scope upgrade expired or not found" },
      });
      expect((await rpcReq(started.ws, "device.pair.reject", { requestId })).ok).toBe(true);
    } finally {
      owner.ws.close();
      other.ws.close();
    }
  });
});
