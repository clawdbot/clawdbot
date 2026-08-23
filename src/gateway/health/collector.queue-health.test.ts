// Queue health collector tests cover real SQLite dead letters and active ingress pressure.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({ session: { store: "/tmp/queue-health-sessions" } }),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => "/tmp/queue-health-sessions",
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  listSessionEntriesReadOnly: () => [],
}));

vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => [],
}));

const [collector, pluginRuntime, degradedState] = await Promise.all([
  import("./collector.js"),
  import("../../plugins/runtime.js"),
  import("../../plugins/runtime-degraded-state.js"),
]);
const pluginRegistrySnapshot = pluginRuntime.captureActivePluginRegistrySnapshot();
const degradedPluginsSnapshot = degradedState.listActiveDegradedPlugins();
const collectHealth = () =>
  collector.collectGatewayHealthSnapshot({ audience: "admin", probe: false, timeoutMs: 10 });

describe("queue health collector", () => {
  beforeEach(() => {
    pluginRuntime.setActivePluginRegistry(createEmptyPluginRegistry());
    degradedState.setActiveDegradedPlugins([]);
  });

  afterAll(() => {
    pluginRuntime.restoreActivePluginRegistrySnapshot(pluginRegistrySnapshot);
    degradedState.setActiveDegradedPlugins(degradedPluginsSnapshot);
  });

  it("includes outbound and ingress dead letters in the health snapshot", async () => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-health-dq-",
    });
    try {
      const { moveDeliveryQueueEntryToFailed, upsertDeliveryQueueEntry } =
        await import("../../infra/delivery-queue-sqlite.js");
      const clean = await collectHealth();
      expect(clean.deliveryQueues).toBeUndefined();

      upsertDeliveryQueueEntry({
        queueName: "outbound",
        entry: { id: "dead-1", enqueuedAt: 1_000, retryCount: 5, retainOnFailure: true },
      });
      moveDeliveryQueueEntryToFailed("outbound", "dead-1");
      const { createChannelIngressQueue } = await import("../../channels/message/ingress-queue.js");
      const ingressQueue = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
      });
      await ingressQueue.enqueue("dead-2", { text: "recover me" });
      const claim = await ingressQueue.claim("dead-2", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await ingressQueue.fail(claim, { reason: "handler-error", failedAt: 50_000 });

      const snap = await collectHealth();
      expect(snap.deliveryQueues).toEqual({
        failed: [{ queueName: "outbound", count: 1, oldestFailedAt: expect.any(Number) }],
        ingressFailed: [
          { channelId: "telegram", accountId: "ops", count: 1, oldestFailedAt: 50_000 },
        ],
      });
    } finally {
      await openClawState.cleanup();
    }
  });

  it("surfaces a retry-floor ingress lane with 55 blocked followers", async () => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-health-ingress-pressure-",
    });
    try {
      const { createChannelIngressQueue } = await import("../../channels/message/ingress-queue.js");
      const { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } =
        await import("../../channels/message/ingress-retry-policy.js");
      const now = Date.now();
      const ingressQueue = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
        now: () => now,
      });
      await ingressQueue.enqueue(
        "retry-head-private",
        { text: "private payload" },
        { laneKey: "private-lane", receivedAt: now - 60_000 },
      );
      for (let attempt = 0; attempt < DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS; attempt += 1) {
        const claim = await ingressQueue.claim("retry-head-private", { ownerId: "private-owner" });
        if (!claim) {
          throw new Error("Expected retry head claim");
        }
        await ingressQueue.release(claim, {
          lastError: "private handler error",
          releasedAt: now,
        });
      }
      for (let index = 0; index < 55; index += 1) {
        await ingressQueue.enqueue(
          `follower-private-${index}`,
          { text: `private follower ${index}` },
          { laneKey: "private-lane", receivedAt: now - 59_000 + index },
        );
      }
      await ingressQueue.enqueue(
        "ordinary-retry-private",
        { text: "ordinary retry" },
        { laneKey: "ordinary-private-lane", receivedAt: now - 30_000 },
      );
      const ordinaryClaim = await ingressQueue.claim("ordinary-retry-private", {
        ownerId: "private-owner",
      });
      if (!ordinaryClaim) {
        throw new Error("Expected ordinary retry claim");
      }
      await ingressQueue.release(ordinaryClaim, {
        lastError: "first attempt",
        releasedAt: now,
      });
      await ingressQueue.enqueue(
        "fresh-claim-private",
        { text: "fresh claim" },
        { laneKey: "fresh-private-lane", receivedAt: now - 10_000 },
      );
      const freshClaim = await ingressQueue.claim("fresh-claim-private", {
        ownerId: "private-owner",
      });
      if (!freshClaim) {
        throw new Error("Expected fresh claim");
      }

      const snap = await collectHealth();
      expect(snap.deliveryQueues).toEqual({
        failed: [],
        ingressPressure: [
          {
            channelId: "telegram",
            accountId: "ops",
            laneCount: 1,
            pendingCount: 56,
            claimedCount: 0,
            blockedCount: 55,
            oldestReceivedAt: now - 60_000,
          },
        ],
      });
      expect(JSON.stringify(snap.deliveryQueues)).not.toMatch(
        /private-lane|private-owner|private payload|private handler error|retry-head-private/,
      );
    } finally {
      await openClawState.cleanup();
    }
  });
});
