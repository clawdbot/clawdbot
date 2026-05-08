import { describe, expect, it } from "vitest";
import { formatDocsLink } from "./links.js";

describe("formatDocsLink", () => {
  it("prepends the docs root when given a relative path", () => {
    const out = formatDocsLink("/channels/quietchat", "quietchat");
    expect(out).toContain("https://docs.openclaw.ai/channels/quietchat");
  });

  it("preserves an absolute http url", () => {
    const out = formatDocsLink("https://example.com/page", "page");
    expect(out).toContain("https://example.com/page");
  });

  it("treats whitespace-only path like an empty path and falls back to docs root", () => {
    const out = formatDocsLink("   ", "root");
    expect(out).toContain("https://docs.openclaw.ai");
  });

  it("falls back to docs root when path is undefined (regression: #67076, #67074)", () => {
    const out = formatDocsLink(undefined as unknown as string, "label");
    expect(out).toContain("https://docs.openclaw.ai");
  });

  it("falls back to docs root when path is null", () => {
    const out = formatDocsLink(null as unknown as string);
    expect(out).toContain("https://docs.openclaw.ai");
  });
});
