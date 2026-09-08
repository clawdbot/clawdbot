// Tests inbound dedupe state for repeated message ids.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function claim(ctx: MsgContext) {
  const result = claimInboundDedupe(ctx);
  expect(result.status).toBe("claimed");
  if (result.status !== "claimed") {
    throw new Error(`expected claimed inbound dedupe result, got ${result.status}`);
  }
  return result;
}

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

  it("refuses one physical inbound re-entering under a different session scope", () => {
    // A mid-turn model-fallback / harness re-entry can re-present the SAME physical
    // inbound under a different resolved session scope (main vs direct). Route +
    // provider messageId are identical, so admission must refuse the re-entry
    // instead of admitting a duplicate run that re-delivers the final. Before the
    // session-independent key this second claim returned "claimed" (two runs).
    const agentScope: MsgContext = {
      ...sharedInboundContext,
      SessionKey: "agent:main:discord:channel:c1",
    };
    // Re-entry that resolves a DIFFERENT session scope for the same physical
    // inbound: here the session context is absent (empty scope). Previously this
    // produced a distinct dedupe key and was admitted as a second run.
    const reentryWithoutSession: MsgContext = {
      ...sharedInboundContext,
      SessionKey: undefined,
    };

    const firstPass = claim(agentScope);
    // In-flight re-entry under a different scope must NOT get its own claim.
    expect(claimInboundDedupe(reentryWithoutSession).status).toBe("inflight");
    firstPass.commit();
    // After the first pass commits, the re-entry is a hard duplicate.
    expect(claimInboundDedupe(reentryWithoutSession).status).toBe("duplicate");
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
