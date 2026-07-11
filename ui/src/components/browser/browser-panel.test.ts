import { describe, expect, it } from "vitest";
import { normalizeUrlDraft } from "./browser-panel.ts";

describe("normalizeUrlDraft", () => {
  it("prefixes bare hosts with https", () => {
    expect(normalizeUrlDraft("example.com")).toBe("https://example.com/");
    expect(normalizeUrlDraft("  github.com/openclaw/openclaw ")).toBe(
      "https://github.com/openclaw/openclaw",
    );
  });

  it("keeps explicit http(s) schemes", () => {
    expect(normalizeUrlDraft("http://example.com/a?b=1")).toBe("http://example.com/a?b=1");
    expect(normalizeUrlDraft("HTTPS://example.com")).toBe("https://example.com/");
  });

  it("accepts host:port entries instead of treating the host as a scheme", () => {
    expect(normalizeUrlDraft("localhost:3000")).toBe("https://localhost:3000/");
    expect(normalizeUrlDraft("example.com:8080/path")).toBe("https://example.com:8080/path");
  });

  it("rejects empty and non-http(s) inputs", () => {
    expect(normalizeUrlDraft("   ")).toBeNull();
    expect(normalizeUrlDraft("javascript:alert(1)")).toBeNull();
    expect(normalizeUrlDraft("file:///etc/passwd")).toBeNull();
  });
});
