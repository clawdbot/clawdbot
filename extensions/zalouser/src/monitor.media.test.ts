import { describe, expect, it } from "vitest";
import { resolveInboundImageContentType } from "./monitor.js";

describe("resolveInboundImageContentType", () => {
  it("trusts a detected image/* MIME from saveRemoteMedia", () => {
    expect(resolveInboundImageContentType("image/png", "https://x/y.jpg")).toBe("image/png");
    expect(resolveInboundImageContentType("image/webp", "https://x/y.jpg")).toBe("image/webp");
  });

  it("overrides application/octet-stream using URL extension (Zalo CDN case)", () => {
    // Zalo CDN photos arrive with content-type application/octet-stream
    // (verified live against photo-stal-*.zdn.vn endpoints). Without this
    // override, kernel.resolveCurrentTurnImages rejects the photo because
    // MediaType does not start with image/* and the agent never sees the
    // vision block.
    expect(
      resolveInboundImageContentType(
        "application/octet-stream",
        "https://photo-stal-22.zdn.vn/gr/abc/photo.jpg",
      ),
    ).toBe("image/jpeg");
    expect(
      resolveInboundImageContentType("application/octet-stream", "https://x/y.png"),
    ).toBe("image/png");
    expect(
      resolveInboundImageContentType("application/octet-stream", "https://x/y.WEBP"),
    ).toBe("image/webp");
  });

  it("falls back to image/jpeg when both detected MIME and URL extension are absent", () => {
    expect(resolveInboundImageContentType(undefined, "https://x/path/no-extension")).toBe(
      "image/jpeg",
    );
    expect(resolveInboundImageContentType("", "https://x/path/no-extension")).toBe(
      "image/jpeg",
    );
  });

  it("ignores query string when parsing URL extension", () => {
    expect(
      resolveInboundImageContentType(
        "application/octet-stream",
        "https://x/y.png?token=abc&v=1",
      ),
    ).toBe("image/png");
  });

  it("is case-insensitive on URL extension", () => {
    expect(resolveInboundImageContentType("application/octet-stream", "https://x/y.JPEG")).toBe(
      "image/jpeg",
    );
    expect(resolveInboundImageContentType("application/octet-stream", "https://x/y.GIF")).toBe(
      "image/gif",
    );
  });

  it("falls back to image/jpeg for unknown image extensions", () => {
    expect(resolveInboundImageContentType("application/octet-stream", "https://x/y.heic")).toBe(
      "image/jpeg",
    );
    expect(resolveInboundImageContentType("application/octet-stream", "https://x/y.tiff")).toBe(
      "image/jpeg",
    );
  });
});
