// Telegram tests cover preview streaming mode resolution.
import { describe, expect, it } from "vitest";
import { resolveTelegramPreviewStreamMode } from "./preview-streaming.js";

describe("resolveTelegramPreviewStreamMode", () => {
  it("prefers a session streaming override before account config", () => {
    expect(
      resolveTelegramPreviewStreamMode({
        streaming: { mode: "partial" },
        sessionStreamingMode: "progress",
      }),
    ).toBe("progress");
  });

  it("keeps the Telegram default when no config or session override is set", () => {
    expect(resolveTelegramPreviewStreamMode()).toBe("progress");
  });
});
