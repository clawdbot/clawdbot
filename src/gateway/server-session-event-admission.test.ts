import { describe, expect, it } from "vitest";
import { emitSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { prepareGatewayTranscriptEventDispatch } from "./server-session-event-admission.js";

describe("prepareGatewayTranscriptEventDispatch", () => {
  it("captures identity before lazy dispatch crosses a reset", () => {
    const sessionKey = "agent:main:main";
    const prepared = prepareGatewayTranscriptEventDispatch({
      target: {
        agentId: "main",
        sessionId: "session-before",
        sessionKey,
      },
      message: { role: "user", content: "stale" },
    });

    try {
      expect(prepared.event.identityMutationFence?.isCurrent()).toBe(true);
      emitSessionIdentityMutation({
        kind: "reset",
        previous: { sessionId: "session-before", sessionKeys: [sessionKey] },
        current: { sessionId: "session-after", sessionKeys: [sessionKey] },
      });
      expect(prepared.event.identityMutationFence?.isCurrent()).toBe(false);
    } finally {
      prepared.release();
    }
  });
});
