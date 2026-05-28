import { describe, expect, it } from "vitest";
import { applyAnthropicEphemeralCacheControlMarkers } from "./anthropic-cache-control-payload.js";

describe("applyAnthropicEphemeralCacheControlMarkers", () => {
  it("marks system text content as ephemeral and strips thinking cache markers", () => {
    const payload = {
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "draft", cache_control: { type: "ephemeral" } },
            { type: "text", text: "answer" },
          ],
        },
      ],
    } satisfies Record<string, unknown>;

    applyAnthropicEphemeralCacheControlMarkers(payload);

    expect(payload.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "draft" },
          { type: "text", text: "answer" },
        ],
      },
    ]);
  });
});
