// Tests inbound dedupe state for repeated message ids.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import { buildInboundDedupeKey, resetInboundDedupe } from "./inbound-dedupe.js";

type InboundDedupeClaimResult = ReturnType<typeof import("./inbound-dedupe.js").claimInboundDedupe>;

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

function expectClaimed(result: InboundDedupeClaimResult, expectedKey: string): string {
  expect(result).toEqual({ status: "claimed", key: expectedKey });
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
    expect(
      buildInboundDedupeKey({
        ...sharedInboundContext,
        MessageThreadId: 77,
      }),
    ).toBe(
      buildInboundDedupeKey({
        ...sharedInboundContext,
        MessageThreadId: "77",
      }),
    );
  });

  it("shares claim/release state across distinct module instances", async () => {
    const expectedKey = buildInboundDedupeKey(sharedInboundContext);
    if (!expectedKey) {
      throw new Error("expected inbound dedupe key");
    }
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
      const firstClaimKey = expectClaimed(firstClaim, expectedKey);
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "inflight",
        key: expectedKey,
      });
      inboundB.releaseInboundDedupe(firstClaimKey);
      expect(inboundA.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "claimed",
        key: expectedKey,
      });
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });

  it("shares claim/commit state across distinct module instances", async () => {
    const expectedKey = buildInboundDedupeKey(sharedInboundContext);
    if (!expectedKey) {
      throw new Error("expected inbound dedupe key");
    }
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
      const firstClaimKey = expectClaimed(firstClaim, expectedKey);
      inboundA.commitInboundDedupe(firstClaimKey);
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "duplicate",
        key: expectedKey,
      });
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });
});
