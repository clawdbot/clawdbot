import { vi } from "vitest";
import * as pairing from "../infra/device-pairing-store-readonly.js";
import * as push from "../infra/push-web.js";
import { createEventWebPushDelivery } from "./event-web-push.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";

/** Exercise real producers and fanout through notification policy, stopping at network delivery. */
export function createEventWebPushBroadcastHarness() {
  const subscriptions = vi.spyOn(push, "listBoundWebPushSubscriptions").mockReturnValue([
    {
      subscriptionId: "browser-subscription",
      endpoint: "https://push.example.test/browser",
      keys: { p256dh: "test-public-key", auth: "test-auth" },
      createdAtMs: 1,
      updatedAtMs: 1,
      deviceId: "browser",
      userProfileId: null,
      devicePreferences: { enabled: true, label: "", categories: { agentFinished: true } },
    },
  ]);
  const devices = vi.spyOn(pairing, "listPairedDevicesReadOnly").mockReturnValue([
    {
      deviceId: "browser",
      publicKey: "test-public-key",
      role: "operator",
      roles: ["operator"],
      scopes: ["operator.read"],
      approvedScopes: ["operator.read"],
      tokens: {
        operator: {
          token: "test-token",
          role: "operator",
          scopes: ["operator.read"],
          createdAtMs: 1,
        },
      },
      createdAtMs: 1,
      approvedAtMs: 1,
    },
  ]);
  const send = vi.fn<Awaited<ReturnType<typeof push.prepareWebPushNotificationSender>>>(
    async () => [],
  );
  const prepare = vi.spyOn(push, "prepareWebPushNotificationSender").mockResolvedValue(send);
  const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });
  const broadcaster = createGatewayBroadcaster({
    clients: new Set(),
    onBroadcast: (event, payload, opts) => delivery.handleEvent(event, payload, opts),
  });
  return {
    ...broadcaster,
    send,
    dispose() {
      subscriptions.mockRestore();
      devices.mockRestore();
      prepare.mockRestore();
    },
  };
}
