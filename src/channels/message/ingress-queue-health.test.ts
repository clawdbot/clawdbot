// Ingress queue health tests cover conservative active-lane pressure aggregation.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { INGRESS_CLAIM_LEASE_MS } from "./ingress-claim-owner.js";
import { countChannelIngressQueuePressure } from "./ingress-queue-health.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "./ingress-retry-policy.js";

async function recordAttempts(
  queue: ChannelIngressQueue<{ privatePayload: string }>,
  id: string,
  count: number,
  lastError?: string,
) {
  for (let attempt = 0; attempt < count; attempt += 1) {
    const claim = await queue.claim(id, { ownerId: "private-owner" });
    if (!claim) {
      throw new Error(`Expected ${id} claim ${attempt + 1}`);
    }
    await queue.release(claim, { lastError, releasedAt: 1_000 + attempt });
  }
}

describe("channel ingress queue health", () => {
  afterEach(() => vi.useRealTimers());

  it("reports durable pressured lanes without leaking private or null-lane rows", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-ingress-health-",
        applyEnv: false,
      },
      async ({ stateDir }) => {
        const now = 10 * INGRESS_CLAIM_LEASE_MS;
        vi.useFakeTimers();
        vi.setSystemTime(now);
        let clock = now;
        const queue = createChannelIngressQueue<{ privatePayload: string }>({
          channelId: "telegram",
          accountId: "ops",
          stateDir,
          now: () => clock,
        });

        await queue.enqueue(
          "retry-private-id",
          { privatePayload: "retry-private-payload" },
          { laneKey: "retry-private-lane", receivedAt: 100 },
        );
        await recordAttempts(
          queue,
          "retry-private-id",
          DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
          "retry-private-error",
        );
        await queue.enqueue(
          "retry-follower-private-id",
          { privatePayload: "retry-follower-private-payload" },
          { laneKey: "retry-private-lane", receivedAt: 200 },
        );

        await queue.enqueue(
          "ordinary-private-id",
          { privatePayload: "ordinary-private-payload" },
          { laneKey: "ordinary-private-lane", receivedAt: 300 },
        );
        await recordAttempts(queue, "ordinary-private-id", 1, "ordinary-private-error");
        await queue.enqueue(
          "no-error-private-id",
          { privatePayload: "no-error-private-payload" },
          { laneKey: "no-error-private-lane", receivedAt: 400 },
        );
        await recordAttempts(queue, "no-error-private-id", DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS);

        clock = now - INGRESS_CLAIM_LEASE_MS;
        await queue.enqueue(
          "stale-private-id",
          { privatePayload: "stale-private-payload" },
          { laneKey: "stale-private-lane", receivedAt: 500 },
        );
        const staleClaim = await queue.claim("stale-private-id", {
          ownerId: "stale-private-owner",
        });
        if (!staleClaim) {
          throw new Error("Expected stale claim");
        }
        clock = now;
        await queue.enqueue(
          "stale-follower-private-id",
          { privatePayload: "stale-follower-private-payload" },
          { laneKey: "stale-private-lane", receivedAt: 600 },
        );
        await queue.enqueue(
          "fresh-private-id",
          { privatePayload: "fresh-private-payload" },
          { laneKey: "fresh-private-lane", receivedAt: 700 },
        );
        const freshClaim = await queue.claim("fresh-private-id", {
          ownerId: "fresh-private-owner",
        });
        if (!freshClaim) {
          throw new Error("Expected fresh claim");
        }

        await queue.enqueue(
          "null-pressured-private-id",
          { privatePayload: "null-pressured-private-payload" },
          { receivedAt: 800 },
        );
        await recordAttempts(
          queue,
          "null-pressured-private-id",
          DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
          "null-pressured-private-error",
        );
        await queue.enqueue(
          "null-unrelated-private-id",
          { privatePayload: "null-unrelated-private-payload" },
          { receivedAt: 900 },
        );
        clock = now - INGRESS_CLAIM_LEASE_MS;
        await queue.enqueue(
          "null-stale-private-id",
          { privatePayload: "null-stale-private-payload" },
          { receivedAt: 1_000 },
        );
        const nullStaleClaim = await queue.claim("null-stale-private-id", {
          ownerId: "null-stale-private-owner",
        });
        if (!nullStaleClaim) {
          throw new Error("Expected null-lane stale claim");
        }
        clock = now;

        const pressure = countChannelIngressQueuePressure(stateDir);
        expect(pressure).toEqual([
          {
            channelId: "telegram",
            accountId: "ops",
            laneCount: 2,
            pendingCount: 3,
            claimedCount: 1,
            blockedCount: 2,
            oldestReceivedAt: 100,
          },
        ]);
        expect(JSON.stringify(pressure)).not.toMatch(
          /private-(?:id|lane|owner|payload|error)|retry-private|stale-private|null-(?:pressured|stale)/,
        );
      },
    );
  });
});
