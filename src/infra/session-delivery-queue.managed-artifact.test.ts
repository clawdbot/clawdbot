import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { enqueueSessionDelivery } from "./session-delivery-queue.js";

function managedArtifactDelivery() {
  return {
    receipt: {
      kind: "delegate-artifact" as const,
      dispatchId: "dispatch-1",
      recipientSessionKey: "agent:main:main",
      recipientSessionId: "session-1",
    },
    projection: {
      artifacts: [],
      arrivalContext: {
        deliveryClass: "delegate result" as const,
        deliveryMode: "announced" as const,
        dispatchId: "dispatch-1",
        producer: { sessionKey: "agent:main:child", runId: "run-1" },
        completionId: "completion-1",
        binding: {
          recipientSessionKey: "agent:main:main",
          recipientSessionId: "session-1",
        },
        dispatchAcceptedAt: 1,
        completedAt: 2,
        deliveredAt: 3,
        policyVersion: 1 as const,
        availability: "available" as const,
      },
    },
  };
}

describe("managed artifact session deliveries", () => {
  it("requires an expected session id for managed returns", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-managed-" }, async (tempDir) => {
      await expect(
        enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "managed return",
            managedDelegateArtifactDelivery: managedArtifactDelivery(),
          } as unknown as Parameters<typeof enqueueSessionDelivery>[0],
          tempDir,
        ),
      ).rejects.toThrow("invalid generic session delivery payload: invalid shape");
    });
  });

  it("accepts a managed return bound to the expected session id", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-managed-" }, async (tempDir) => {
      await expect(
        enqueueSessionDelivery(
          {
            kind: "systemEvent",
            sessionKey: "agent:main:main",
            text: "managed return",
            expectedSessionId: "session-1",
            managedDelegateArtifactDelivery: managedArtifactDelivery(),
          },
          tempDir,
        ),
      ).resolves.toEqual(expect.any(String));
    });
  });
});
