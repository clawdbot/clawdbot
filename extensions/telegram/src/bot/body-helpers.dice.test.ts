// Telegram tests cover the canonical body producer for messages that carry no text.
import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { resolveTelegramNonTextBody } from "./body-helpers.js";

function diceMessage(dice: unknown): Message {
  return { dice } as Message;
}

describe("resolveTelegramNonTextBody", () => {
  it("renders a dice roll as a one-line marker", () => {
    expect(resolveTelegramNonTextBody(diceMessage({ emoji: "\u{1F3B2}", value: 4 }))).toEqual({
      kind: "dice",
      text: "[Dice \u{1F3B2} = 4]",
    });
  });

  it("covers the wider slot-machine range", () => {
    expect(resolveTelegramNonTextBody(diceMessage({ emoji: "\u{1F3B0}", value: 64 }))).toEqual({
      kind: "dice",
      text: "[Dice \u{1F3B0} = 64]",
    });
  });

  it("keeps a zero value rather than treating it as absent", () => {
    expect(resolveTelegramNonTextBody(diceMessage({ emoji: "\u{1F3AF}", value: 0 }))).toEqual({
      kind: "dice",
      text: "[Dice \u{1F3AF} = 0]",
    });
  });

  it("ignores a dice payload without a usable value", () => {
    expect(resolveTelegramNonTextBody(diceMessage({ emoji: "\u{1F3B2}" }))).toBeUndefined();
    expect(
      resolveTelegramNonTextBody(diceMessage({ emoji: "\u{1F3B2}", value: Number.NaN })),
    ).toBeUndefined();
  });

  it("ignores a dice payload without an emoji", () => {
    expect(resolveTelegramNonTextBody(diceMessage({ emoji: "   ", value: 3 }))).toBeUndefined();
  });

  it("returns nothing when the message carries neither location nor dice", () => {
    expect(resolveTelegramNonTextBody(diceMessage(undefined))).toBeUndefined();
  });

  it("reports a location separately, since only location counts as user text", () => {
    const located = {
      location: { latitude: 48.858844, longitude: 2.294351 },
    } as Message;
    expect(resolveTelegramNonTextBody(located)?.kind).toBe("location");
  });
});
