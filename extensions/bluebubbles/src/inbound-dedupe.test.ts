import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetBlueBubblesInboundDedupForTest,
  claimBlueBubblesInboundMessage,
  resolveBlueBubblesInboundDedupeKey,
} from "./inbound-dedupe.js";

async function claimAndFinalize(guid: string | undefined, accountId: string): Promise<string> {
  const claim = await claimBlueBubblesInboundMessage({ guid, accountId });
  if (claim.kind === "claimed") {
    await claim.finalize();
  }
  return claim.kind;
}

describe("claimBlueBubblesInboundMessage", () => {
  beforeEach(() => {
    _resetBlueBubblesInboundDedupForTest();
  });

  it("claims a new guid and rejects committed duplicates", async () => {
    expect(await claimAndFinalize("g1", "acc")).toBe("claimed");
    expect(await claimAndFinalize("g1", "acc")).toBe("duplicate");
  });

  it("scopes dedupe per account", async () => {
    expect(await claimAndFinalize("g1", "a")).toBe("claimed");
    expect(await claimAndFinalize("g1", "b")).toBe("claimed");
  });

  it("reports skip when guid is missing or blank", async () => {
    expect((await claimBlueBubblesInboundMessage({ guid: undefined, accountId: "acc" })).kind).toBe(
      "skip",
    );
    expect((await claimBlueBubblesInboundMessage({ guid: "", accountId: "acc" })).kind).toBe(
      "skip",
    );
    expect((await claimBlueBubblesInboundMessage({ guid: "   ", accountId: "acc" })).kind).toBe(
      "skip",
    );
  });

  it("rejects overlong guids to cap on-disk size", async () => {
    const huge = "x".repeat(10_000);
    expect((await claimBlueBubblesInboundMessage({ guid: huge, accountId: "acc" })).kind).toBe(
      "skip",
    );
  });

  it("releases the claim so a later replay can retry after a transient failure", async () => {
    const first = await claimBlueBubblesInboundMessage({ guid: "g1", accountId: "acc" });
    expect(first.kind).toBe("claimed");
    if (first.kind === "claimed") {
      first.release();
    }
    // Released claims should be re-claimable on the next delivery.
    expect(await claimAndFinalize("g1", "acc")).toBe("claimed");
  });
});

describe("resolveBlueBubblesInboundDedupeKey", () => {
  it("returns messageId for new-message events", () => {
    expect(resolveBlueBubblesInboundDedupeKey({ messageId: "msg-1" })).toBe("msg-1");
  });

  it("returns associatedMessageGuid for balloon events", () => {
    expect(
      resolveBlueBubblesInboundDedupeKey({
        messageId: "balloon-1",
        balloonBundleId: "com.apple.messages.URLBalloonProvider",
        associatedMessageGuid: "msg-1",
      }),
    ).toBe("msg-1");
  });

  it("suffixes key with :updated for updated-message events", () => {
    expect(
      resolveBlueBubblesInboundDedupeKey({ messageId: "msg-1", eventType: "updated-message" }),
    ).toBe("msg-1:updated");
  });

  it("updated-message and new-message for same GUID produce distinct keys", () => {
    const newKey = resolveBlueBubblesInboundDedupeKey({ messageId: "msg-1" });
    const updatedKey = resolveBlueBubblesInboundDedupeKey({
      messageId: "msg-1",
      eventType: "updated-message",
    });
    expect(newKey).not.toBe(updatedKey);
  });

  it("returns undefined when messageId is missing", () => {
    expect(resolveBlueBubblesInboundDedupeKey({})).toBeUndefined();
  });
});
