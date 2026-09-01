import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import * as devicePairing from "../infra/device-pairing.js";
import {
  issueOperatorToken,
  loadDeviceIdentity,
  openTrackedWs,
} from "./device-authz.test-helpers.js";
import {
  connectOk,
  connectReq,
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
const PAIRING_PENDING_TTL_MS = 5 * 60 * 1000;
const BROWSER_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const WRONG_BROWSER_ORIGIN = "chrome-extension://bcdefghijklmnopabcdefghijklmnopa";
const BROWSER_CLIENT = {
  id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT,
  version: "test",
  platform: "chrome",
  deviceFamily: "extension",
  mode: GATEWAY_CLIENT_MODES.UI,
};
const BROWSER_CAPS = [
  GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS,
  GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS,
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
      clientId: GATEWAY_CLIENT_IDS.TEST,
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

  async function openScopeLessDevice(name: string) {
    const paired = await issueOperatorToken({
      name,
      approvedScopes: [],
      clientId: GATEWAY_CLIENT_IDS.TEST,
      clientMode: GATEWAY_CLIENT_MODES.TEST,
    });
    const ws = await openTrackedWs(started.port);
    const hello = await connectOk(ws, {
      skipDefaultAuth: true,
      deviceToken: paired.token,
      deviceIdentityPath: paired.identityPath,
      scopes: [],
    });
    return { ...paired, ws, hello };
  }

  async function openLimitedBrowserDevice(name: string) {
    const { identityPath, identity } = loadDeviceIdentity(name);
    const ws = await openTrackedWs(started.port, { origin: BROWSER_ORIGIN });
    const hello = await connectOk(ws, {
      token: "secret",
      scopes: ["operator.read"],
      caps: BROWSER_CAPS,
      client: BROWSER_CLIENT,
      deviceIdentityPath: identityPath,
      prePairDevice: true,
      browserOrigin: BROWSER_ORIGIN,
    });
    const auth = (hello as { auth?: { deviceToken?: string } }).auth;
    expect(auth?.deviceToken).toBeTruthy();
    return {
      ws,
      identityPath,
      deviceId: identity.deviceId,
      deviceToken: auth?.deviceToken ?? "",
    };
  }

  test("lets a paired scope-less operator request access recovery", async () => {
    const limited = await openScopeLessDevice("live-scope-upgrade-scope-less");
    try {
      const registration = await rpcReq<{ requestId: string }>(
        limited.ws,
        "device.scopes.requestUpgrade",
        { scopes: FULL_SCOPES },
      );
      expect(registration.ok, JSON.stringify(registration.error)).toBe(true);
      expect(registration.payload?.requestId).toBeTypeOf("string");
    } finally {
      limited.ws.close();
    }
  });

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

  test("preserves a browser origin through approval and reconnects from the same origin", async () => {
    const limited = await openLimitedBrowserDevice("live-scope-upgrade-browser-origin");
    let reconnected: Awaited<ReturnType<typeof openTrackedWs>> | undefined;
    try {
      const registration = await rpcReq<{ requestId: string }>(
        limited.ws,
        "device.scopes.requestUpgrade",
        { scopes: FULL_SCOPES },
      );
      const requestId = registration.payload?.requestId;
      const wait = rpcReq<{
        status: string;
        deviceToken: string;
        scopes: string[];
      }>(limited.ws, "device.scopes.waitUpgrade", { requestId }, 10_000);
      expect((await rpcReq(started.ws, "device.pair.approve", { requestId })).ok).toBe(true);
      const resolved = await wait;
      expect(resolved).toMatchObject({
        ok: true,
        payload: { status: "approved", scopes: expect.arrayContaining(["operator.admin"]) },
      });

      expect((await devicePairing.getPairedDevice(limited.deviceId))?.browserOrigin).toBe(
        BROWSER_ORIGIN,
      );

      limited.ws.close();
      reconnected = await openTrackedWs(started.port, { origin: BROWSER_ORIGIN });
      const hello = await connectOk(reconnected, {
        skipDefaultAuth: true,
        deviceToken: resolved.payload?.deviceToken,
        deviceIdentityPath: limited.identityPath,
        scopes: resolved.payload?.scopes,
        caps: BROWSER_CAPS,
        client: BROWSER_CLIENT,
      });
      expect((hello as { auth?: { scopes?: string[] } }).auth?.scopes).toContain("operator.admin");
    } finally {
      limited.ws.close();
      reconnected?.close();
    }
  });

  test("rejects a scope-upgrade connection from a mismatched browser origin", async () => {
    const limited = await openLimitedBrowserDevice("live-scope-upgrade-wrong-browser-origin");
    limited.ws.close();
    const wrongOrigin = await openTrackedWs(started.port, { origin: WRONG_BROWSER_ORIGIN });
    try {
      const response = await connectReq(wrongOrigin, {
        skipDefaultAuth: true,
        deviceToken: limited.deviceToken,
        deviceIdentityPath: limited.identityPath,
        scopes: ["operator.read"],
        caps: BROWSER_CAPS,
        client: BROWSER_CLIENT,
      });
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe("NOT_PAIRED");
      expect(response.error?.message).toContain("dedicated paired device identity");
    } finally {
      wrongOrigin.close();
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

  test("coalesces concurrent waits for the same device request", async () => {
    const limited = await openLimitedDevice("live-scope-upgrade-concurrent-waits");
    const readPending = devicePairing.getPendingDevicePairing;
    let releaseRead = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const pendingSpy = vi
      .spyOn(devicePairing, "getPendingDevicePairing")
      .mockImplementation(async (...args) => {
        await readGate;
        return await readPending(...args);
      });
    let requestId: string | undefined;
    let waits: Array<Promise<unknown>> = [];
    try {
      const registration = await rpcReq<{ requestId: string }>(
        limited.ws,
        "device.scopes.requestUpgrade",
        { scopes: FULL_SCOPES },
      );
      requestId = registration.payload?.requestId;
      const firstWait = rpcReq<{ status: string; requestId: string }>(
        limited.ws,
        "device.scopes.waitUpgrade",
        { requestId },
        10_000,
      );
      const secondWait = rpcReq<{ status: string; requestId: string }>(
        limited.ws,
        "device.scopes.waitUpgrade",
        { requestId },
        10_000,
      );
      waits = [firstWait, secondWait];

      await vi.waitFor(() => expect(pendingSpy).toHaveBeenCalled());
      expect(pendingSpy).toHaveBeenCalledTimes(1);
      releaseRead();
      expect((await rpcReq(started.ws, "device.pair.reject", { requestId })).ok).toBe(true);
      await expect(firstWait).resolves.toMatchObject({
        ok: true,
        payload: { status: "rejected", requestId },
      });
      await expect(secondWait).resolves.toMatchObject({
        ok: true,
        payload: { status: "rejected", requestId },
      });
    } finally {
      releaseRead();
      if (requestId) {
        await rpcReq(started.ws, "device.pair.reject", { requestId }).catch(() => undefined);
      }
      await Promise.allSettled(waits);
      pendingSpy.mockRestore();
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
          id: GATEWAY_CLIENT_IDS.CLI,
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

  test("uses the refreshed durable deadline when retrying an existing upgrade", async () => {
    const limited = await openLimitedDevice("live-scope-upgrade-refreshed-deadline");
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const first = await rpcReq<{ requestId: string }>(
        limited.ws,
        "device.scopes.requestUpgrade",
        { scopes: FULL_SCOPES },
      );
      nowSpy.mockReturnValue(now + PAIRING_PENDING_TTL_MS - 1_000);
      const retry = await rpcReq<{ requestId: string }>(
        limited.ws,
        "device.scopes.requestUpgrade",
        { scopes: FULL_SCOPES },
      );
      expect(retry.payload?.requestId).toBe(first.payload?.requestId);

      nowSpy.mockReturnValue(now + PAIRING_PENDING_TTL_MS + 1_000);
      const requestId = retry.payload?.requestId;
      const wait = rpcReq<{ status: string; requestId: string }>(
        limited.ws,
        "device.scopes.waitUpgrade",
        { requestId },
        10_000,
      );
      expect((await rpcReq(started.ws, "device.pair.approve", { requestId })).ok).toBe(true);
      expect(await wait).toMatchObject({
        ok: true,
        payload: { status: "approved", requestId },
      });
    } finally {
      nowSpy.mockRestore();
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
