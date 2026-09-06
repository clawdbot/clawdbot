// Tests inbound dedupe state for repeated message ids.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import {
  claimInboundDedupe,
  commitInboundDedupe,
  releaseOwnedInboundDedupe,
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

function claimMessage(ctx: MsgContext, owner?: object) {
  const result = claimInboundDedupe(ctx, { owner });
  expect(result.status).toBe("claimed");
  if (result.status !== "claimed") {
    throw new Error(`expected claimed inbound dedupe result, got ${result.status}`);
  }
  return result;
}

describe("inbound dedupe", () => {
  afterEach(() => {
    resetInboundDedupe();
  });

  it("deduplicates inbound messages with equivalent numeric and string thread ids", () => {
    const key = claimMessage({ ...sharedInboundContext, MessageThreadId: 77 }).key;
    resetInboundDedupe();
    expect(claimMessage({ ...sharedInboundContext, MessageThreadId: "77" }).key).toBe(key);
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
    commitInboundDedupe(firstClaim);

    const secondClaim = claimInboundDedupe({
      ...firstTarget,
      CommandTargetSessionKey: "agent:main:discord:channel:c1:thread:thread-1",
    });
    expect(secondClaim.status).toBe("claimed");
    expect(claimInboundDedupe(firstTarget)).toEqual({
      status: "duplicate",
      key: firstClaim.key,
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
      const firstClaimKey = firstClaim.key;
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "inflight",
        key: firstClaimKey,
      });
      inboundB.releaseInboundDedupe(firstClaim);
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
      const owner = {};
      const firstClaim = inboundA.claimInboundDedupe(sharedInboundContext, { owner });
      expect(firstClaim.status).toBe("claimed");
      if (firstClaim.status !== "claimed") {
        throw new Error(`expected claimed inbound dedupe result, got ${firstClaim.status}`);
      }
      const firstClaimKey = firstClaim.key;
      inboundA.commitInboundDedupe(firstClaim);
      expect(inboundB.claimInboundDedupe(sharedInboundContext)).toEqual({
        status: "duplicate",
        key: firstClaimKey,
      });
      inboundB.releaseOwnedInboundDedupe(owner);
      expect(inboundA.claimInboundDedupe(sharedInboundContext).status).toBe("claimed");
    } finally {
      inboundA.resetInboundDedupe();
      inboundB.resetInboundDedupe();
    }
  });

  it("frees a committed entry for its owner and never for a stale owner after recommit", () => {
    const owner = {};
    const firstClaim = claimMessage(sharedInboundContext, owner);
    commitInboundDedupe(firstClaim);
    releaseOwnedInboundDedupe(owner);
    expect(claimInboundDedupe(sharedInboundContext).status).toBe("claimed");

    // The key expired and a newer dispatch re-committed under a different
    // owner; the abandoned owner must not free the replacement entry.
    resetInboundDedupe();
    const staleOwner = {};
    const staleClaim = claimMessage(sharedInboundContext, staleOwner);
    commitInboundDedupe(staleClaim);
    resetInboundDedupe();
    const currentOwner = {};
    const currentClaim = claimMessage(sharedInboundContext, currentOwner);
    commitInboundDedupe(currentClaim);
    releaseOwnedInboundDedupe(staleOwner);
    expect(claimInboundDedupe(sharedInboundContext).status).toBe("duplicate");
    releaseOwnedInboundDedupe(currentOwner);
    expect(claimInboundDedupe(sharedInboundContext).status).toBe("claimed");
  });

  it("fences late finalization after abandonment without releasing the retry's claim", () => {
    const owner = {};
    const original = claimMessage(sharedInboundContext, owner);
    releaseOwnedInboundDedupe(owner);

    const retryOwner = {};
    const retry = claimMessage(sharedInboundContext, retryOwner);
    commitInboundDedupe(original);
    expect(claimInboundDedupe(sharedInboundContext).status).toBe("inflight");

    commitInboundDedupe(retry);
    commitInboundDedupe(retry);
    releaseOwnedInboundDedupe(owner);
    expect(claimInboundDedupe(sharedInboundContext).status).toBe("duplicate");

    releaseOwnedInboundDedupe(retryOwner);
    expect(claimInboundDedupe(sharedInboundContext).status).toBe("claimed");
  });

  it.each([
    { name: "message", context: { MessageSid: "msg-2" } },
    { name: "peer", context: { OriginatingTo: "channel:c2" } },
    { name: "thread", context: { MessageThreadId: "thread-2" } },
    { name: "account", context: { AccountId: "other-account" } },
    { name: "channel", context: { OriginatingChannel: "telegram" } },
    { name: "agent", context: { SessionKey: "agent:other:discord:channel:c1" } },
  ])("does not release a different $name when an owner is abandoned", ({ context }) => {
    const owner = {};
    const otherContext = { ...sharedInboundContext, ...context };
    commitInboundDedupe(claimMessage(sharedInboundContext, owner));
    commitInboundDedupe(claimMessage(otherContext, {}));

    releaseOwnedInboundDedupe(owner);

    expect(claimInboundDedupe(sharedInboundContext).status).toBe("claimed");
    expect(claimInboundDedupe(otherContext).status).toBe("duplicate");
  });
});
