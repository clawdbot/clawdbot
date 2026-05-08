import { describe, expect, it } from "vitest";
import { formatDecisionSummary } from "./runner.entries.js";
import type { MediaUnderstandingDecision } from "./types.js";

describe("media-understanding formatDecisionSummary guards", () => {
  it("formats skipped summary when decision.attachments is undefined", () => {
    expect(
      formatDecisionSummary({
        capability: "image",
        outcome: "skipped",
        attachments: undefined as unknown as MediaUnderstandingDecision["attachments"],
      }),
    ).toBe("image: skipped");
  });

  it("counts malformed attachment attempts as unchosen", () => {
    expect(
      formatDecisionSummary({
        capability: "video",
        outcome: "skipped",
        attachments: [{ attachmentIndex: 0, attempts: { bad: true } }],
      } as unknown as MediaUnderstandingDecision),
    ).toBe("video: skipped (0/1)");
  });

  it("ignores non-string provider/model/reason fields", () => {
    expect(
      formatDecisionSummary({
        capability: "audio",
        outcome: "failed",
        attachments: [
          {
            attachmentIndex: 0,
            chosen: {
              outcome: "failed",
              provider: { bad: true },
              model: 42,
            },
            attempts: [{ reason: { malformed: true } }],
          },
        ],
      } as unknown as MediaUnderstandingDecision),
    ).toBe("audio: failed (0/1)");
  });
});
