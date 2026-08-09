// Extension relay protocol frame parsing.
import { describe, expect, it } from "vitest";
import { parseExtensionMessage } from "./relay-protocol.js";

describe("parseExtensionMessage", () => {
  const validHello = {
    type: "hello",
    userAgent: "Mozilla/5.0 Chrome/144.0.0.0",
    browserVersion: "Chrome/144.0.0.0",
    extensionVersion: "2.0.0",
    tabs: [{ tabId: 1, url: "https://example.com", title: "Example", active: true }],
  };

  it("accepts known frame types", () => {
    expect(parseExtensionMessage(JSON.stringify(validHello))).toEqual(validHello);
    expect(parseExtensionMessage(JSON.stringify({ type: "pong" }))).toEqual({ type: "pong" });
    expect(
      parseExtensionMessage(JSON.stringify({ type: "result", seq: 3, result: { ok: true } })),
    ).toMatchObject({ type: "result", seq: 3 });
    expect(
      parseExtensionMessage(
        JSON.stringify({
          type: "pageShare",
          requestId: 7,
          payload: { url: "https://example.com", title: "Example", content: "Body" },
        }),
      ),
    ).toMatchObject({ type: "pageShare", requestId: 7 });
    // Frame parsing intentionally recognizes only the discriminator. The bridge
    // owns payload validation and returns a correlated error.
    expect(parseExtensionMessage(JSON.stringify({ type: "pageShare" }))).toEqual({
      type: "pageShare",
    });
  });

  it.each([
    ["missing identity", { ...validHello, userAgent: undefined }],
    ["empty browser version", { ...validHello, browserVersion: "" }],
    ["oversized user agent", { ...validHello, userAgent: "x".repeat(2_049) }],
    ["an extra hello field", { ...validHello, extra: true }],
    ["non-array tabs", { ...validHello, tabs: {} }],
    [
      "a fractional tab id",
      { ...validHello, tabs: [{ tabId: 1.5, url: "", title: "", active: true }] },
    ],
    [
      "an extra tab field",
      {
        ...validHello,
        tabs: [{ tabId: 1, url: "", title: "", active: true, incognito: false }],
      },
    ],
    [
      "duplicate tab ids",
      {
        ...validHello,
        tabs: [
          { tabId: 1, url: "https://one.example", title: "One", active: true },
          { tabId: 1, url: "https://two.example", title: "Two", active: false },
        ],
      },
    ],
  ])("rejects a hello with %s", (_label, hello) => {
    expect(parseExtensionMessage(JSON.stringify(hello))).toBeNull();
  });

  it("rejects malformed or unknown frames", () => {
    expect(parseExtensionMessage("not json")).toBeNull();
    expect(parseExtensionMessage(JSON.stringify({ type: "evil" }))).toBeNull();
    expect(parseExtensionMessage(JSON.stringify({ noType: true }))).toBeNull();
    expect(parseExtensionMessage(JSON.stringify(42))).toBeNull();
  });
});
