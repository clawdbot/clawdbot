import { describe, expect, it } from "vitest";
import { matchBrowserUrlPattern } from "./url-pattern.js";

describe("browser url pattern matching", () => {
  it("matches exact URLs", () => {
    expect(matchBrowserUrlPattern("https://example.com/a", "https://example.com/a")).toBe(true);
    expect(matchBrowserUrlPattern("https://example.com/a", "https://example.com/b")).toBe(false);
  });

  it("matches substring patterns without wildcards", () => {
    expect(matchBrowserUrlPattern("example.com", "https://example.com/a")).toBe(true);
    expect(matchBrowserUrlPattern("/dash", "https://example.com/app/dash")).toBe(true);
    expect(matchBrowserUrlPattern("nope", "https://example.com/a")).toBe(false);
  });

  it("matches glob patterns", () => {
    expect(matchBrowserUrlPattern("**/dash", "https://example.com/app/dash")).toBe(true);
    expect(matchBrowserUrlPattern("https://example.com/*", "https://example.com/a")).toBe(true);
    expect(matchBrowserUrlPattern("https://example.com/*", "https://other.com/a")).toBe(false);
  });

  it("rejects empty patterns", () => {
    expect(matchBrowserUrlPattern("", "https://example.com")).toBe(false);
    expect(matchBrowserUrlPattern("   ", "https://example.com")).toBe(false);
  });
});
