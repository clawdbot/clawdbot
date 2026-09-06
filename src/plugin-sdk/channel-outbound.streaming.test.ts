import { describe, expect, it } from "vitest";
import { resolveChannelStreamingPreviewToolProgress } from "./channel-outbound.js";

describe("channel-outbound tool-progress SDK defaults", () => {
  it("preserves the v2026.9.1 default when the second argument is omitted", () => {
    expect(resolveChannelStreamingPreviewToolProgress(undefined)).toBe(true);
    expect(resolveChannelStreamingPreviewToolProgress({ streaming: { mode: "progress" } })).toBe(
      true,
    );
  });

  it("preserves the default when a caller forwards undefined before the resolved mode", () => {
    expect(resolveChannelStreamingPreviewToolProgress(undefined, undefined, "progress")).toBe(true);
    expect(resolveChannelStreamingPreviewToolProgress(undefined, undefined, "partial")).toBe(true);
  });

  it("lets callers choose a default without overriding explicit configuration", () => {
    expect(resolveChannelStreamingPreviewToolProgress(undefined, false, "partial")).toBe(false);
    expect(resolveChannelStreamingPreviewToolProgress(undefined, false, "progress")).toBe(false);
    expect(resolveChannelStreamingPreviewToolProgress(undefined, true, "progress")).toBe(true);
    expect(
      resolveChannelStreamingPreviewToolProgress(
        { streaming: { progress: { toolProgress: true } } },
        false,
        "progress",
      ),
    ).toBe(true);
  });
});
