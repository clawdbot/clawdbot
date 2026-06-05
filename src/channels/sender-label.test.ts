// Sender label tests cover display-label formatting for channel senders.
import { describe, expect, it } from "vitest";
import { listSenderLabelCandidates, resolveSenderLabel } from "./sender-label.js";

describe("resolveSenderLabel", () => {
  it("prefers display + identifier when both are available", () => {
    expect(
      resolveSenderLabel({
        name: " Alice ",
        e164: " +15551234567 ",
      }),
    ).toBe("Alice (+15551234567)");
  });

  it("falls back to identifier-only labels", () => {
    expect(
      resolveSenderLabel({
        id: " user-123 ",
      }),
    ).toBe("user-123");
  });

  it("returns null when all values are empty", () => {
    expect(
      resolveSenderLabel({
        name: " ",
        username: "",
        tag: "   ",
      }),
    ).toBeNull();
  });
});

describe("listSenderLabelCandidates", () => {
  it("returns unique normalized candidates plus resolved label", () => {
    expect(
      listSenderLabelCandidates({
        name: "Alice",
        username: "alice",
        tag: "alice",
        e164: "+15551234567",
        id: "user-123",
      }),
    ).toEqual(["Alice", "alice", "+15551234567", "user-123", "Alice (+15551234567)"]);
  });
});
