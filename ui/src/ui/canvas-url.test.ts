import { describe, expect, it } from "vitest";
import { resolveCanvasIframeUrl } from "./canvas-url.ts";

describe("resolveCanvasIframeUrl", () => {
  it("allows same-origin hosted canvas document paths", () => {
    expect(resolveCanvasIframeUrl("/__openclaw__/canvas/documents/cv_demo/index.html")).toBe(
      "/__openclaw__/canvas/documents/cv_demo/index.html",
    );
  });

  it("rewrites safe canvas paths through the scoped canvas host", () => {
    expect(
      resolveCanvasIframeUrl(
        "/__openclaw__/canvas/documents/cv_demo/index.html",
        "http://127.0.0.1:19003/__openclaw__/cap/cap_123",
      ),
    ).toBe(
      "http://127.0.0.1:19003/__openclaw__/cap/cap_123/__openclaw__/canvas/documents/cv_demo/index.html",
    );
  });

  it("rejects non-canvas same-origin paths", () => {
    expect(resolveCanvasIframeUrl("/not-canvas/snake.html")).toBeUndefined();
  });

  it("rejects absolute external URLs", () => {
    expect(resolveCanvasIframeUrl("https://example.com/evil.html")).toBeUndefined();
  });

  it("allows absolute external URLs only when explicitly enabled", () => {
    expect(resolveCanvasIframeUrl("https://example.com/embed.html?x=1#y", undefined, true)).toBe(
      "https://example.com/embed.html?x=1#y",
    );
  });

  it("rejects file URLs", () => {
    expect(resolveCanvasIframeUrl("file:///tmp/snake.html")).toBeUndefined();
  });
});
