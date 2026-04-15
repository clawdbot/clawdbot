import { describe, expect, it } from "vitest";
import { buildSlackBlocksFallbackText } from "./blocks-fallback.js";

describe("buildSlackBlocksFallbackText", () => {
  it("prefers header text", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "header", text: { type: "plain_text", text: "Deploy status" } },
      ] as never),
    ).toBe("Deploy status");
  });

  it("uses image alt text", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "image", image_url: "https://example.com/image.png", alt_text: "Latency chart" },
      ] as never),
    ).toBe("Latency chart");
  });

  it("uses generic defaults for file and unknown blocks", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "file", source: "remote", external_id: "F123" },
      ] as never),
    ).toBe("Shared a file");
    expect(buildSlackBlocksFallbackText([{ type: "divider" }] as never)).toBe(
      "Shared a Block Kit message",
    );
  });
});
