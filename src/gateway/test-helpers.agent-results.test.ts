/**
 * Gateway agent-result test helper coverage.
 */
import { describe, expect, it } from "vitest";
import { extractPayloadText } from "./test-helpers.agent-results.js";

describe("extractPayloadText", () => {
  it("returns plain payload text unchanged", () => {
    expect(
      extractPayloadText({
        payloads: [{ text: "hello world" }],
      }),
    ).toBe("hello world");
  });

  it("extracts final text from Claude CLI stream-json payloads", () => {
    const streamJson = [
      JSON.stringify({
        type: "system",
        subtype: "init",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "CLI backend OK ABC123." }],
        },
      }),
      JSON.stringify({
        type: "result",
        result: "CLI backend OK ABC123.",
      }),
    ].join("\n");

    expect(
      extractPayloadText({
        payloads: [{ text: streamJson }],
      }),
    ).toBe("CLI backend OK ABC123.");
  });
});
