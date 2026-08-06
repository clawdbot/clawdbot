// Extension relay protocol frame parsing.
import { describe, expect, it } from "vitest";
import { parseExtensionMessage } from "./relay-protocol.js";

describe("parseExtensionMessage", () => {
  it("accepts known frame types", () => {
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

  it("rejects malformed or unknown frames", () => {
    expect(parseExtensionMessage("not json")).toBeNull();
    expect(parseExtensionMessage(JSON.stringify({ type: "evil" }))).toBeNull();
    expect(parseExtensionMessage(JSON.stringify({ noType: true }))).toBeNull();
    expect(parseExtensionMessage(JSON.stringify(42))).toBeNull();
  });
});
