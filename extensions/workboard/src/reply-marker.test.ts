import type { WorkboardCard } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import {
  addWorkboardMarker,
  registerWorkboardReplyMarker,
  selectPrimaryWorkboardCard,
} from "./reply-marker.js";

function card(overrides: Partial<WorkboardCard> = {}): WorkboardCard {
  return {
    id: "c8808a63-a412-4fc7-acdb-662dec762799",
    title: "Sensitive internal card: Alice",
    status: "running",
    priority: "normal",
    labels: [],
    position: 1,
    createdAt: 1,
    updatedAt: 2,
    sessionKey: "agent:main:chat",
    metadata: {
      claim: {
        ownerId: "franck",
        token: "token",
        claimedAt: 10,
        lastHeartbeatAt: 10,
        expiresAt: Date.now() + 60_000,
      },
    },
    ...overrides,
  } as WorkboardCard;
}

describe("Workboard reply marker", () => {
  it("prefixes visible text with only the latest active card ID", () => {
    const first = card({ id: "first", updatedAt: 20 });
    const second = card({
      id: "second",
      updatedAt: 30,
      metadata: { claim: { ...first.metadata!.claim!, claimedAt: 20 } },
    });
    const primary = selectPrimaryWorkboardCard([first, second], "agent:main:chat", 50);

    expect(addWorkboardMarker({ text: "Progress" }, primary)).toEqual({
      text: "Workboard: second\nProgress",
    });
  });

  it("does not leak markers across sessions or completed claims", () => {
    expect(addWorkboardMarker({ text: "Unrelated" }, undefined)).toEqual({ text: "Unrelated" });
    expect(
      selectPrimaryWorkboardCard([card({ status: "done" })], "agent:main:chat", 50),
    ).toBeUndefined();
  });

  it("honors silent and strict-format bypasses", () => {
    const active = card();
    expect(addWorkboardMarker({ text: "NO_REPLY" }, active)).toEqual({ text: "NO_REPLY" });
    expect(addWorkboardMarker({ text: '{"ok":true}', workboardMarker: "omit" }, active)).toEqual({
      text: '{"ok":true}',
      workboardMarker: "omit",
    });
  });

  it("registers the marker at the reply payload boundary", async () => {
    const on = vi.fn();
    const store = { list: vi.fn().mockResolvedValue([card()]) };
    registerWorkboardReplyMarker({ api: { on } as never, store: store as never });

    const handler = on.mock.calls[0]?.[1] as (
      event: { payload: { text: string }; sessionKey: string },
      ctx: { sessionKey: string },
    ) => Promise<{ payload: { text: string } } | undefined>;
    await expect(
      handler(
        { payload: { text: "Result" }, sessionKey: "agent:main:chat" },
        { sessionKey: "agent:main:chat" },
      ),
    ).resolves.toEqual({
      payload: { text: "Workboard: c8808a63-a412-4fc7-acdb-662dec762799\nResult" },
    });
  });
});
