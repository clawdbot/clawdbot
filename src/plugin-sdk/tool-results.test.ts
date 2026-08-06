import { describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("../agents/tools/common.js", () => {
  throw new Error("tool-results must not load the broad agent tool helpers");
});

import { jsonResult, textResult, yieldToolResult, type AgentToolResult } from "./tool-results.js";

describe("tool result helpers", () => {
  it("preserves typed JSON details", () => {
    const payload = { ok: true, messageId: "msg-1" };
    const result = jsonResult(payload);

    expectTypeOf(result).toEqualTypeOf<AgentToolResult<typeof payload>>();
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: payload,
    });
  });

  it("keeps model text separate from typed details", () => {
    const details = { ok: true, messageId: "msg-1" };
    const result = textResult("Message sent.", details);

    expectTypeOf(result).toEqualTypeOf<AgentToolResult<typeof details>>();
    expect(result).toEqual({
      content: [{ type: "text", text: "Message sent." }],
      details,
    });
  });

  it("builds a yielding tool result", () => {
    const details = { status: "pending", cardId: "card-1" };
    const result = yieldToolResult({
      message: "Waiting for card response",
      details,
      text: "Card sent.",
    });

    expectTypeOf(result).toEqualTypeOf<AgentToolResult<typeof details>>();
    expect(result).toEqual({
      content: [{ type: "text", text: "Card sent." }],
      details,
      control: { type: "yield", message: "Waiting for card response" },
    });
  });
});
