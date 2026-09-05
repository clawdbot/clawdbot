// Terminal Core tests cover links behavior.
import { describe, expect, it } from "vitest";
import { formatDocsLink } from "./links.js";

describe("formatDocsLink", () => {
  it("prepends the docs root when given a relative path", () => {
    const out = formatDocsLink("/channels/quietchat", "quietchat");
    expect(out).toBe("https://docs.openclaw.ai/channels/quietchat");
  });

  it("preserves an absolute http url", () => {
    const out = formatDocsLink("https://example.com/page", "page");
    expect(out).toBe("https://example.com/page");
  });

  it("preserves uppercase absolute HTTPS urls", () => {
    const out = formatDocsLink("HTTPS://example.com/page", "page");
    expect(out).toBe("HTTPS://example.com/page");
  });

  it("does not treat http-prefixed relative paths as absolute urls", () => {
    const out = formatDocsLink("http-status", "HTTP status");
    expect(out).toBe("https://docs.openclaw.ai/http-status");
  });

  it("treats whitespace-only path like an empty path and falls back to docs root", () => {
    const out = formatDocsLink("   ", "root");
    expect(out).toBe("https://docs.openclaw.ai");
  });

  it("falls back to docs root when path is undefined (regression: #67076, #67074)", () => {
    const out = formatDocsLink(undefined as unknown as string, "label");
    expect(out).toBe("https://docs.openclaw.ai");
  });

  it("falls back to docs root when path is null", () => {
    const out = formatDocsLink(null as unknown as string);
    expect(out).toBe("https://docs.openclaw.ai");
  });

  it("strips terminal controls from non-OSC docs fallback text", () => {
    const out = formatDocsLink("https://example.com/a\u0007b", "docs\u001b[31m", {
      force: false,
    });

    expect(out).toBe("https://example.com/ab");
  });
});
