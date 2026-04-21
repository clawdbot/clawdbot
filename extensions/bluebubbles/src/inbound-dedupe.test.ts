import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetBlueBubblesInboundDedupForTest,
  claimBlueBubblesInboundMessage,
  commitBlueBubblesCoalescedMessageIds,
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

describe("commitBlueBubblesCoalescedMessageIds", () => {
  beforeEach(() => {
    _resetBlueBubblesInboundDedupForTest();
  });

  it("marks every coalesced source messageId as seen so a later replay dedupes", async () => {
    // Primary was processed via claim+finalize by the debouncer flush.
    expect(await claimAndFinalize("primary", "acc")).toBe("claimed");
    // Secondaries reach dedupe through the bulk-commit path.
    await commitBlueBubblesCoalescedMessageIds({
      messageIds: ["secondary-1", "secondary-2"],
      accountId: "acc",
    });
    // A MessagePoller replay of any individual source event is now a duplicate
    // rather than a fresh agent turn — the core bug this helper exists to fix.
    expect(await claimAndFinalize("primary", "acc")).toBe("duplicate");
    expect(await claimAndFinalize("secondary-1", "acc")).toBe("duplicate");
    expect(await claimAndFinalize("secondary-2", "acc")).toBe("duplicate");
  });

  it("scopes coalesced commits per account", async () => {
    await commitBlueBubblesCoalescedMessageIds({
      messageIds: ["g1"],
      accountId: "a",
    });
    // Same messageId under a different account is still claimable.
    expect(await claimAndFinalize("g1", "a")).toBe("duplicate");
    expect(await claimAndFinalize("g1", "b")).toBe("claimed");
  });

  it("skips empty or overlong guids without throwing", async () => {
    await commitBlueBubblesCoalescedMessageIds({
      messageIds: ["", "   ", "x".repeat(10_000), "valid"],
      accountId: "acc",
    });
    expect(await claimAndFinalize("valid", "acc")).toBe("duplicate");
    // Overlong guid was skipped by sanitization, not committed.
    expect(await claimAndFinalize("x".repeat(10_000), "acc")).toBe("skip");
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
