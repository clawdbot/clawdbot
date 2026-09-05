import { describe, expect, it } from "vitest";
import { resolveStreamingReply } from "./embedded-agent-subscribe.handlers.messages.stream.js";

describe("resolveStreamingReply", () => {
  it("appends visible text across long blank runs without stalling the media scan", () => {
    const delta = `before${"\n".repeat(60_000)}after`;
    const started = performance.now();
    expect(
      resolveStreamingReply({
        evtType: "text_delta",
        next: delta,
        previousText: "",
        previousCleaned: "",
        visibleDelta: delta,
        appendDelta: delta,
        parsedStreamDirectives: { text: delta, replyToTag: false, isSilent: false },
      }),
    ).toEqual({ text: delta, delta, replace: false, hasText: true });
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
