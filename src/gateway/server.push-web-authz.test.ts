import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test("protects Web Push ownership through authenticated browser RPCs and profile handoff", async () => {
  const origin = "https://control.example.com";
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile({
    gateway: { auth, trustedProxies: ["127.0.0.1"], controlUi: { allowedOrigins: [origin] } },
  });
  const identities = tempDirs.make("openclaw-push-owners-");
  const endpoint = "https://push.example.test/owner-subscription";
  const keys = { p256dh: "browser-p256dh", auth: "browser-auth" };

  await withGatewayServer(async ({ port }) => {
    const connect = async (email: string, device: string) => {
      const ws = await openWs(port, {
        origin,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        "x-forwarded-user": email,
      });
      try {
        const response = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes: ["operator.read", "operator.write"],
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: path.join(identities, `${device}.sqlite`),
          browserOrigin: origin,
        });
        expect(response.ok, JSON.stringify(response.error)).toBe(true);
        return ws;
      } catch (error) {
        ws.close();
        throw error;
      }
    };
    const owner = await connect("alice@example.com", "first");
    const clients = [owner];
    try {
      expect((await rpcReq(owner, "push.web.subscribe", { endpoint, keys })).ok).toBe(true);
      expect(
        (
          await rpcReq(owner, "push.web.preferences.set", {
            endpoint,
            scope: "device",
            preferences: { enabled: false, label: "Owner browser" },
          })
        ).ok,
      ).toBe(true);
      const otherDevice = await connect("alice@example.com", "second");
      clients.push(otherDevice);
      const otherProfile = await connect("bob@example.com", "first");
      clients.push(otherProfile);
      for (const client of [otherDevice, otherProfile]) {
        for (const method of [
          "push.web.unsubscribe",
          "push.web.preferences.get",
          "push.web.preferences.set",
        ]) {
          expect(
            await rpcReq(client, method, {
              endpoint,
              ...(method.endsWith(".set")
                ? { scope: "device", preferences: { enabled: true, label: "" } }
                : {}),
            }),
          ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        }
        expect(
          await rpcReq(client, "push.web.subscribe", {
            endpoint,
            keys: { p256dh: "forged-p256dh", auth: "forged-auth" },
          }),
        ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      }
      expect(await rpcReq(owner, "push.web.preferences.get", { endpoint })).toMatchObject({
        ok: true,
        payload: { durableIdentity: true, device: { enabled: false, label: "Owner browser" } },
      });
      // A real browser account switch retains the subscription material, and
      // transfers ownership without leaking the former account's overrides.
      expect((await rpcReq(otherProfile, "push.web.subscribe", { endpoint, keys })).ok).toBe(true);
      expect(await rpcReq(otherProfile, "push.web.preferences.get", { endpoint })).toMatchObject({
        ok: true,
        payload: { device: { enabled: true, label: "" } },
      });
      expect(await rpcReq(owner, "push.web.unsubscribe", { endpoint })).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(await rpcReq(otherProfile, "push.web.unsubscribe", { endpoint })).toMatchObject({
        ok: true,
        payload: { removed: true },
      });
    } finally {
      for (const client of clients) {
        client.close();
      }
    }
  });
});
