import { describe, expect, it } from "vitest";
import { createChatSendActiveRunOwnership } from "./chat-send-active-run-ownership.js";

describe("createChatSendActiveRunOwnership", () => {
  it("keeps gateway fallback for plain non-agent replies", () => {
    const ownership = createChatSendActiveRunOwnership();
    expect(ownership.shouldFinalizeAsNonAgent(false)).toBe(true);
    expect(ownership.shouldTerminalize()).toBe(false);
  });

  it("skips fallback after a steered turn is adopted by the active run", () => {
    const ownership = createChatSendActiveRunOwnership();
    ownership.markActiveRunTurnAdopted();
    expect(ownership.shouldFinalizeAsNonAgent(false)).toBe(false);
    expect(ownership.shouldTerminalize()).toBe(true);
  });

  it("skips fallback when a followup was queued behind the active run", () => {
    const ownership = createChatSendActiveRunOwnership();
    ownership.markQueuedFollowupEnqueued();
    expect(ownership.shouldFinalizeAsNonAgent(false)).toBe(false);
    expect(ownership.shouldTerminalize()).toBe(true);
  });

  it("skips fallback once an agent run owns the turn", () => {
    const ownership = createChatSendActiveRunOwnership();
    expect(ownership.shouldFinalizeAsNonAgent(true)).toBe(false);
  });
});
