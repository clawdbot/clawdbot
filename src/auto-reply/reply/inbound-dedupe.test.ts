// Tests inbound dedupe state for repeated message ids.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import { claimInboundDedupe, resetInboundDedupe } from "./inbound-dedupe.js";

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

function claimKey(ctx: MsgContext): string {
  const result = claimInboundDedupe(ctx, { inFlight: new Set() });
  expect(result.status).toBe("claimed");
  if (result.status !== "claimed") {
    throw new Error(`expected claimed inbound dedupe result, got ${result.status}`);
  }
  return result.key;
}

describe("inbound dedupe", () => {
  afterEach(() => {
    resetInboundDedupe();
  });

  it("deduplicates inbound messages with equivalent numeric and string thread ids", () => {
    expect(claimKey({ ...sharedInboundContext, MessageThreadId: 77 })).toBe(
      claimKey({ ...sharedInboundContext, MessageThreadId: "77" }),
    );
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
      const firstClaimKey = firstClaim.key;
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "inflight",
        key: firstClaimKey,
      });
      inboundB.releaseInboundDedupe(firstClaimKey);
      expect(inboundA.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "claimed",
        key: firstClaimKey,
      });
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
      const firstClaimKey = firstClaim.key;
      inboundA.commitInboundDedupe(firstClaimKey);
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "duplicate",
        key: firstClaimKey,
      });
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });
});
