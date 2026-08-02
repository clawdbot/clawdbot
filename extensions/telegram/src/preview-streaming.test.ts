import { describe, expect, it } from "vitest";
import { resolveTelegramBlockStreamingEnabled } from "./preview-streaming.js";

describe("resolveTelegramBlockStreamingEnabled", () => {
  it("lets an available explicit preview override the inherited block default", () => {
    expect(
      resolveTelegramBlockStreamingEnabled({
        account: { streaming: { mode: "partial" } },
        previewAvailable: true,
        legacyBlockStreamingDefault: "on",
      }),
    ).toBe(false);
  });

  it("preserves inherited block delivery without an eligible preview", () => {
    expect(
      resolveTelegramBlockStreamingEnabled({
        account: { streaming: { mode: "partial" } },
        previewAvailable: false,
        legacyBlockStreamingDefault: "on",
      }),
    ).toBe(true);
  });

  it("keeps explicit block configuration authoritative", () => {
    expect(
      resolveTelegramBlockStreamingEnabled({
        account: { streaming: { mode: "partial", block: { enabled: true } } },
        previewAvailable: true,
      }),
    ).toBe(true);
  });
});
