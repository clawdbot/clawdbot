// Control UI CSP tests keep script, style, media, image, font, and connection
// directives tight while allowing the known runtime surfaces.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildControlUiCspHeader, computeInlineScriptHashes } from "./control-ui-csp.js";

describe("buildControlUiCspHeader", () => {
  it("blocks inline scripts while allowing inline styles", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("frame-src 'self' http: https:");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
  });

  it("allows Google Fonts for style and font loading", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
  });

  it("allows OpenAI realtime and tweakcn theme import requests without allowing all HTTPS", () => {
    const csp = buildControlUiCspHeader();
    const connectSrc = csp.split("; ").find((directive) => directive.startsWith("connect-src "));
    expect(connectSrc?.split(" ")).toEqual([
      "connect-src",
      "'self'",
      "ws:",
      "wss:",
      "data:",
      "https://api.openai.com",
      "https://tweakcn.com",
    ]);
    expect(connectSrc).not.toContain("https://*.tweakcn.com");
    expect(connectSrc?.split(" ")).not.toContain("https:");
  });

  it("limits image loading to local sources and the Gravatar fallback origin", () => {
    const csp = buildControlUiCspHeader();
    const imgSrc = csp.split("; ").find((directive) => directive.startsWith("img-src "));
    expect(imgSrc?.split(" ")).toEqual([
      "img-src",
      "'self'",
      "data:",
      "blob:",
      "https://gravatar.com",
    ]);
    expect(imgSrc?.split(" ")).not.toContain("https:");
  });

  it("allows same-origin and inline audio/video playback", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("media-src 'self' data: blob:");
    expect(csp).not.toContain("media-src 'self' data: blob: https:");
  });

  it("includes inline script hashes in script-src when provided", () => {
    const csp = buildControlUiCspHeader({
      inlineScriptHashes: ["sha256-abc123"],
    });
    expect(csp).toContain("script-src 'self' 'sha256-abc123'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("includes multiple inline script hashes", () => {
    const csp = buildControlUiCspHeader({
      inlineScriptHashes: ["sha256-aaa", "sha256-bbb"],
    });
    expect(csp).toContain("script-src 'self' 'sha256-aaa' 'sha256-bbb'");
  });

  it("falls back to plain script-src self when hashes array is empty", () => {
    const csp = buildControlUiCspHeader({ inlineScriptHashes: [] });
    expect(csp).toMatch(/script-src 'self'(?:;|$)/);
  });

  it("does not relax script execution for the terminal unless allowWasm is set", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).not.toContain("wasm-unsafe-eval");
    expect(csp).toMatch(/connect-src[^;]*data:/);
  });

  it("relaxes script-src and connect-src for the terminal's ghostty-web WASM engine", () => {
    const csp = buildControlUiCspHeader({ allowWasm: true });
    // Narrow WASM compilation permission — never full unsafe-eval.
    expect(csp).toMatch(/script-src[^;]*'wasm-unsafe-eval'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'(?!-)/);
    // Web Awesome icons and ghostty-web both fetch inlined data: assets.
    expect(csp).toMatch(/connect-src[^;]*\bdata:/);
  });

  it("keeps inline script hashes alongside the wasm relaxation", () => {
    const csp = buildControlUiCspHeader({
      inlineScriptHashes: ["sha256-abc123"],
      allowWasm: true,
    });
    expect(csp).toContain("'sha256-abc123'");
    expect(csp).toContain("'wasm-unsafe-eval'");
  });
});

describe("computeInlineScriptHashes", () => {
  it("returns empty for HTML without scripts", () => {
    expect(computeInlineScriptHashes("<html><body>hi</body></html>")).toStrictEqual([]);
  });

  it("hashes inline script content", () => {
    const content = "alert(1)";
    const expected = createHash("sha256").update(content, "utf8").digest("base64");
    const hashes = computeInlineScriptHashes(`<html><script>${content}</script></html>`);
    expect(hashes).toEqual([`sha256-${expected}`]);
  });

  it("skips scripts with src attribute", () => {
    const hashes = computeInlineScriptHashes('<html><script src="/app.js"></script></html>');
    expect(hashes).toStrictEqual([]);
  });

  it("does not treat data-src as an external script attribute", () => {
    const content = "console.log('inline')";
    const expected = createHash("sha256").update(content, "utf8").digest("base64");
    const hashes = computeInlineScriptHashes(
      `<html><script data-src="/app.js">${content}</script></html>`,
    );
    expect(hashes).toEqual([`sha256-${expected}`]);
  });

  it("hashes only inline scripts when mixed with external", () => {
    const inlineContent = "console.log('init')";
    const expected = createHash("sha256").update(inlineContent, "utf8").digest("base64");
    const html = [
      "<html><head>",
      `<script>${inlineContent}</script>`,
      '<script type="module" src="/app.js"></script>',
      "</head></html>",
    ].join("");
    const hashes = computeInlineScriptHashes(html);
    expect(hashes).toEqual([`sha256-${expected}`]);
  });

  it("handles multiline inline scripts", () => {
    const content = "\n  var x = 1;\n  console.log(x);\n";
    const expected = createHash("sha256").update(content, "utf8").digest("base64");
    const hashes = computeInlineScriptHashes(`<script>${content}</script>`);
    expect(hashes).toEqual([`sha256-${expected}`]);
  });

  it("skips empty inline scripts", () => {
    expect(computeInlineScriptHashes("<script></script>")).toStrictEqual([]);
  });
});
