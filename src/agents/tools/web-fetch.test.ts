import { describe, it, expect } from "vitest";
import { getToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { createWebFetchTool } from "./web-fetch.js";
import { sanitizeWebFetchUrl } from "./web-fetch.test-support.js";

describe("sanitizeWebFetchUrl", () => {
  it("removes whitespace between scheme and authority (reported bug)", () => {
    expect(sanitizeWebFetchUrl("https:// docs.openclaw.ai")).toBe("https://docs.openclaw.ai");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeWebFetchUrl("  https://example.com  ")).toBe("https://example.com");
  });

  it("trims leading Unicode whitespace", () => {
    expect(sanitizeWebFetchUrl("\u00a0\ufeffhttps://example.com")).toBe("https://example.com");
  });

  it("trims trailing newlines", () => {
    expect(sanitizeWebFetchUrl("https://example.com\n")).toBe("https://example.com");
  });

  it("preserves trailing Unicode whitespace in paths", () => {
    expect(sanitizeWebFetchUrl("https://example.com/a\u00a0")).toBe("https://example.com/a\u00a0");
  });

  it("trims trailing Unicode whitespace after a bare authority", () => {
    expect(sanitizeWebFetchUrl("https://example.com\u00a0")).toBe("https://example.com");
  });

  it("preserves spaces in the path component", () => {
    // WHATWG URL parser percent-encodes path spaces — they must not be stripped
    const result = sanitizeWebFetchUrl("https://example.com/a b");
    expect(result).toBe("https://example.com/a b");
  });

  it("preserves spaces in the query component", () => {
    const result = sanitizeWebFetchUrl("https://example.com?q=a b");
    expect(result).toBe("https://example.com?q=a b");
  });

  it("preserves scheme-like text in the path component", () => {
    const result = sanitizeWebFetchUrl("https://example.com/a:// b");
    expect(result).toBe("https://example.com/a:// b");
  });

  it("preserves scheme-like text in the query component", () => {
    const result = sanitizeWebFetchUrl("https://example.com?q=x:// y");
    expect(result).toBe("https://example.com?q=x:// y");
  });

  it("preserves percent-encoded characters in path", () => {
    const result = sanitizeWebFetchUrl("https://example.com/a%20b");
    expect(result).toBe("https://example.com/a%20b");
  });

  it("does not modify already-valid URLs", () => {
    expect(sanitizeWebFetchUrl("https://docs.openclaw.ai")).toBe("https://docs.openclaw.ai");
  });

  it("handles https:// with tab after scheme", () => {
    expect(sanitizeWebFetchUrl("https://\texample.com")).toBe("https://example.com");
  });
});

describe("web_fetch terminal presentation", () => {
  it("uses response metadata without page content or URL secrets", () => {
    const tool = createWebFetchTool();
    const terminalPresentation = tool ? getToolTerminalPresentation(tool) : undefined;
    if (!terminalPresentation) {
      throw new Error("expected web_fetch terminal presentation");
    }

    const result = {
      content: [],
      details: {
        url: "https://user:pass@example.com/report?token=secret#section",
        finalUrl: "https://example.com/final?token=secret#section",
        status: 200,
        contentType: "text/html",
        rawLength: 1200,
        truncated: true,
        title: "untrusted title",
        text: "untrusted page content",
      },
    };
    const presentation = terminalPresentation({}, result);

    expect(presentation?.text).toBe(
      [
        "Web fetch completed.",
        "Origin: https://example.com",
        "Status: 200",
        "Content type: text/html",
        "Content length: 1200 characters",
        "Truncated: yes",
      ].join("\n"),
    );
    expect(presentation?.text).not.toContain("secret");
    expect(presentation?.text).not.toContain("untrusted");
  });
});
