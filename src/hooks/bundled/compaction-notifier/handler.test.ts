import { describe, expect, it } from "vitest";
import type { InternalHookEvent } from "../../internal-hook-types.js";
import handler from "./handler.js";

function createAfterEvent(tokensBefore: number, tokensAfter: number): InternalHookEvent {
  return {
    type: "session",
    action: "compact:after",
    sessionKey: "agent:main:main",
    context: { tokensBefore, tokensAfter },
    timestamp: new Date(),
    messages: [],
  };
}

describe("compaction notifier", () => {
  it("includes the token delta for a strict decrease", async () => {
    const event = createAfterEvent(999, 321);

    await handler(event);

    expect(event.messages).toEqual([
      "✅ Context compacted (999 → 321 tokens). Continuing from where I left off.",
    ]);
  });

  it.each([
    { tokensBefore: 20, tokensAfter: 30 },
    { tokensBefore: 36, tokensAfter: 36 },
  ])(
    "does not include a growth arrow for $tokensBefore -> $tokensAfter token counts",
    async ({ tokensBefore, tokensAfter }) => {
      const event = createAfterEvent(tokensBefore, tokensAfter);

      await handler(event);

      expect(event.messages).toEqual(["✅ Context compacted. Continuing from where I left off."]);
    },
  );
});
