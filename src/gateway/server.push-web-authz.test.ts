import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import { normalizeWebPushNotificationPreferences } from "../infra/push-web-preferences.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  onceMessage,
  openWs,
  rpcReq,
  testState,
  waitForWsClose,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test("protects browser and native notification ownership through authenticated RPCs and profile handoff", async () => {
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
    const connect = async (email: string, device: string, native = false) => {
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
          client: native
            ? { id: "openclaw-macos", version: "1.0.0", platform: "macos", mode: "ui" }
            : CONTROL_UI_CLIENT,
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

      const native = await connect("alice@example.com", "native-first", true);
      clients.push(native);
      const nativeOther = await connect("alice@example.com", "native-second", true);
      clients.push(nativeOther);
      const notifications: Array<{ client: typeof native; payload: unknown }> = [];
      const captureNotifications = (client: typeof native) => {
        client.on("message", (data) => {
          const frame = JSON.parse(rawDataToString(data)) as {
            type?: string;
            event?: string;
            payload?: unknown;
          };
          if (frame.type === "event" && frame.event === "notification") {
            notifications.push({ client, payload: frame.payload });
          }
        });
      };
      for (const client of [owner, native, nativeOther]) {
        captureNotifications(client);
      }
      expect(await rpcReq(native, "notifications.test", {})).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
      for (const client of [native, nativeOther]) {
        expect(await rpcReq(client, "notifications.subscribe", { enabled: true })).toMatchObject({
          ok: true,
          payload: {
            canManageUserPreferences: true,
            devicePersistence: "profile",
            device: { enabled: true, label: "" },
          },
        });
      }
      expect(
        (
          await rpcReq(owner, "push.web.preferences.set", {
            endpoint,
            scope: "user",
            preferences: normalizeWebPushNotificationPreferences({
              categories: { agentFinished: true },
              detailLevel: "identified",
            }),
          })
        ).ok,
      ).toBe(true);
      expect(await rpcReq(native, "notifications.preferences.get", {})).toMatchObject({
        ok: true,
        payload: { user: { categories: { agentFinished: true }, detailLevel: "identified" } },
      });
      expect(
        (
          await rpcReq(native, "notifications.preferences.set", {
            scope: "user",
            preferences: normalizeWebPushNotificationPreferences({
              categories: { agentQuestion: true },
            }),
          })
        ).ok,
      ).toBe(true);
      expect(await rpcReq(owner, "push.web.preferences.get", { endpoint })).toMatchObject({
        ok: true,
        payload: {
          user: { categories: { agentQuestion: true, agentFinished: false } },
          device: { enabled: false, label: "Owner browser" },
        },
      });
      expect(
        (
          await rpcReq(native, "notifications.preferences.set", {
            scope: "device",
            preferences: { enabled: false, label: "Native desk" },
          })
        ).ok,
      ).toBe(true);
      expect(await rpcReq(nativeOther, "notifications.preferences.get", {})).toMatchObject({
        ok: true,
        payload: {
          user: { categories: { agentQuestion: true } },
          device: { enabled: true, label: "" },
        },
      });
      const firstEvent = onceMessage(
        native,
        (frame) => frame.type === "event" && frame.event === "notification",
      );
      expect(await rpcReq(native, "notifications.test", {})).toMatchObject({
        ok: true,
        payload: { ok: true },
      });
      expect(await firstEvent).toMatchObject({
        payload: {
          action: "show",
          id: "openclaw-notification-test",
          title: "OpenClaw",
          body: "Notifications are working on this device.",
          path: "/settings/notifications",
          alert: true,
        },
      });
      // Responses on each other socket fence any preceding, incorrectly broadcast notification.
      expect((await rpcReq(nativeOther, "notifications.preferences.get", {})).ok).toBe(true);
      expect((await rpcReq(owner, "push.web.preferences.get", { endpoint })).ok).toBe(true);
      expect(notifications).toEqual([
        { client: native, payload: expect.objectContaining({ action: "show" }) },
      ]);

      native.close();
      expect(await waitForWsClose(native, 5_000)).toBe(true);
      const reconnected = await connect("alice@example.com", "native-first", true);
      clients.push(reconnected);
      captureNotifications(reconnected);
      for (const method of ["notifications.preferences.get", "notifications.test"]) {
        expect(await rpcReq(reconnected, method, {})).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST" },
        });
      }
      expect(await rpcReq(reconnected, "notifications.subscribe", { enabled: true })).toMatchObject(
        {
          ok: true,
          payload: { device: { enabled: false, label: "Native desk" } },
        },
      );
      const reconnectedEvent = onceMessage(
        reconnected,
        (frame) => frame.type === "event" && frame.event === "notification",
      );
      expect((await rpcReq(reconnected, "notifications.test", {})).ok).toBe(true);
      expect(await reconnectedEvent).toMatchObject({
        payload: { action: "show", id: "openclaw-notification-test" },
      });
      expect((await rpcReq(nativeOther, "notifications.preferences.get", {})).ok).toBe(true);
      expect((await rpcReq(owner, "push.web.preferences.get", { endpoint })).ok).toBe(true);
      expect(notifications.map(({ client }) => client)).toEqual([native, reconnected]);

      const switched = await connect("bob@example.com", "native-first", true);
      clients.push(switched);
      captureNotifications(switched);
      expect(await rpcReq(switched, "notifications.subscribe", { enabled: true })).toMatchObject({
        ok: true,
        payload: {
          user: { categories: { agentQuestion: false } },
          device: { enabled: true, label: "" },
        },
      });
      expect(
        (
          await rpcReq(switched, "notifications.preferences.set", {
            scope: "device",
            preferences: { enabled: true, label: "Bob native" },
          })
        ).ok,
      ).toBe(true);
      expect(await rpcReq(reconnected, "notifications.preferences.get", {})).toMatchObject({
        ok: true,
        payload: {
          user: { categories: { agentQuestion: true } },
          device: { enabled: false, label: "Native desk" },
        },
      });
      expect(await rpcReq(reconnected, "notifications.unsubscribe", {})).toMatchObject({
        ok: true,
        payload: { ok: true },
      });
      expect(notifications.at(-1)).toEqual({
        client: reconnected,
        payload: { action: "remove", id: "openclaw-notification-test" },
      });
      expect(await rpcReq(switched, "notifications.preferences.get", {})).toMatchObject({
        ok: true,
        payload: { device: { enabled: true, label: "Bob native" } },
      });
      expect((await rpcReq(nativeOther, "notifications.preferences.get", {})).ok).toBe(true);
      expect(notifications.map(({ client }) => client)).toEqual([native, reconnected, reconnected]);
      expect(await rpcReq(reconnected, "notifications.test", {})).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
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
