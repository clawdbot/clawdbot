// Tests inbound dedupe state for repeated message ids.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import {
  claimInboundDedupe,
  claimInboundFinalDelivery,
  resetInboundDedupe,
} from "./inbound-dedupe.js";

const sharedInboundContext: MsgContext = {
  Provider: "discord",
  Surface: "discord",
  From: "discord:user-1",
  To: "channel:c1",
  OriginatingChannel: "discord",
  OriginatingTo: "channel:c1",
  SessionKey: "agent:main:discord:channel:c1",
  MessageSid: "msg-1",
};

function claim(ctx: MsgContext) {
  const result = claimInboundDedupe(ctx);
  expect(result.status).toBe("claimed");
  if (result.status !== "claimed") {
    throw new Error(`expected claimed inbound dedupe result, got ${result.status}`);
  }
  return result;
}

describe("inbound final-delivery idempotency", () => {
  afterEach(() => {
    resetInboundDedupe();
    vi.useRealTimers();
  });

  it("claims the first final delivery and marks a fallback re-run's final as already delivered", () => {
    // First delivery attempt for this inbound wins the claim.
    expect(claimInboundFinalDelivery(sharedInboundContext)).toBe("claimed");
    // A model-fallback re-run of the SAME inbound must be told the final was
    // already delivered so it suppresses its duplicate send.
    expect(claimInboundFinalDelivery(sharedInboundContext)).toBe("already");
    expect(claimInboundFinalDelivery(sharedInboundContext)).toBe("already");
  });

  it("claims independently per distinct inbound message id", () => {
    expect(claimInboundFinalDelivery({ ...sharedInboundContext, MessageSid: "msg-a" })).toBe(
      "claimed",
    );
    expect(claimInboundFinalDelivery({ ...sharedInboundContext, MessageSid: "msg-b" })).toBe(
      "claimed",
    );
    expect(claimInboundFinalDelivery({ ...sharedInboundContext, MessageSid: "msg-a" })).toBe(
      "already",
    );
  });

  it("fails open when the inbound has no stable dedupe key", () => {
    // No MessageSid ⇒ no key ⇒ must never block a first delivery.
    const keyless: MsgContext = { ...sharedInboundContext, MessageSid: undefined };
    expect(claimInboundFinalDelivery(keyless)).toBe("unkeyed");
    expect(claimInboundFinalDelivery(keyless)).toBe("unkeyed");
  });

  it("resetInboundDedupe clears the final-delivery claim", () => {
    expect(claimInboundFinalDelivery(sharedInboundContext)).toBe("claimed");
    resetInboundDedupe();
    expect(claimInboundFinalDelivery(sharedInboundContext)).toBe("claimed");
  });
});

describe("inbound dedupe", () => {
  afterEach(() => {
    resetInboundDedupe();
    vi.useRealTimers();
  });

  it("deduplicates inbound messages with equivalent numeric and string thread ids", () => {
    claim({ ...sharedInboundContext, MessageThreadId: 77 }).commit();
    expect(claimInboundDedupe({ ...sharedInboundContext, MessageThreadId: "77" }).status).toBe(
      "duplicate",
    );
  });

  it.each([
    { CommandSource: "native", CommandBody: "/stop", CommandAuthorized: true },
    { CommandSource: "text", CommandBody: "/steer keep working", CommandAuthorized: true },
  ] as const)("admits each explicit target of one $CommandSource command once", (command) => {
    const firstTarget = {
      ...sharedInboundContext,
      ...command,
      MessageThreadId: "thread-1",
      CommandTargetSessionKey: "agent:main:discord:channel:c1",
    };
    const firstClaim = claimInboundDedupe(firstTarget);
    expect(firstClaim.status).toBe("claimed");
    if (firstClaim.status !== "claimed") {
      throw new Error("expected the first command target to be admitted");
    }
    firstClaim.commit();

    const secondClaim = claimInboundDedupe({
      ...firstTarget,
      CommandTargetSessionKey: "agent:main:discord:channel:c1:thread:thread-1",
    });
    expect(secondClaim.status).toBe("claimed");
    expect(claimInboundDedupe(firstTarget)).toEqual({
      status: "duplicate",
    });
  });

  it("shares claim/release state across distinct module instances", async () => {
    const inboundA = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=claim-a",
    );
    const inboundB = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=claim-b",
    );

    inboundA.resetInboundDedupe();
    inboundB.resetInboundDedupe();

    try {
      const firstClaim = inboundA.claimInboundDedupe(sharedInboundContext);
      expect(firstClaim.status).toBe("claimed");
      if (firstClaim.status !== "claimed") {
        throw new Error(`expected claimed inbound dedupe result, got ${firstClaim.status}`);
      }
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "inflight",
      });
      firstClaim.release();
      expect(inboundB.claimInboundDedupe(sharedInboundContext).status).toBe("claimed");
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });

  it("shares claim/commit state across distinct module instances", async () => {
    const inboundA = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=commit-a",
    );
    const inboundB = await importFreshModule<typeof import("./inbound-dedupe.js")>(
      import.meta.url,
      "./inbound-dedupe.js?scope=commit-b",
    );

    inboundA.resetInboundDedupe();
    inboundB.resetInboundDedupe();

    try {
      const firstClaim = inboundA.claimInboundDedupe(sharedInboundContext);
      expect(firstClaim.status).toBe("claimed");
      if (firstClaim.status !== "claimed") {
        throw new Error(`expected claimed inbound dedupe result, got ${firstClaim.status}`);
      }
      firstClaim.commit();
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "duplicate",
      });
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });

  it("cannot recommit a released claim or free its replacement", () => {
    const abandoned = claim(sharedInboundContext);
    abandoned.release();
    const replacement = claim(sharedInboundContext);
    abandoned.commit();
    abandoned.release();
    expect(claimInboundDedupe(sharedInboundContext).status).toBe("inflight");
    replacement.commit();
    abandoned.release();
    expect(claimInboundDedupe(sharedInboundContext).status).toBe("duplicate");
    replacement.release();
    expect(claimInboundDedupe(sharedInboundContext).status).toBe("claimed");
  });

  it("does not release a newer commit after the original entry expires", () => {
    vi.useFakeTimers();
    const expired = claim(sharedInboundContext);
    expired.commit();
    vi.advanceTimersByTime(20 * 60_000);
    const replacement = claim(sharedInboundContext);
    replacement.commit();
    expired.release();
    expect(claimInboundDedupe(sharedInboundContext).status).toBe("duplicate");
    replacement.release();
    expect(claimInboundDedupe(sharedInboundContext).status).toBe("claimed");
  });
});
