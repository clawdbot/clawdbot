// Sender label tests cover display-label formatting for channel senders.
import { describe, expect, it } from "vitest";
import { resolveSenderLabel } from "./sender-label.js";

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

describe("resolveSenderLabel opaque ids", () => {
  it("never appends an opaque profile UUID to the display label", () => {
    expect(
      resolveSenderLabel({
        name: "steipete",
        id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
      }),
    ).toBe("steipete");
  });

  it("still appends disambiguating handles and numbers", () => {
    expect(resolveSenderLabel({ name: "Peter", e164: "+436641234567" })).toBe(
      "Peter (+436641234567)",
    );
    expect(resolveSenderLabel({ name: "Peter", id: "peter@example.com" })).toBe(
      "Peter (peter@example.com)",
    );
  });

  it("keeps a UUID-only identity as a last-resort label", () => {
    expect(resolveSenderLabel({ id: "c3e32452-0467-47e5-aafa-233cd5dae29f" })).toBe(
      "c3e32452-0467-47e5-aafa-233cd5dae29f",
    );
  });
});
