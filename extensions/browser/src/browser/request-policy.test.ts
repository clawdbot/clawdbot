import { describe, expect, it } from "vitest";
import { isPersistentBrowserProfileMutation } from "./request-policy.js";
import { matchBrowserUrlPattern } from "./url-pattern.js";

describe("isPersistentBrowserProfileMutation", () => {
  it.each([
    ["POST", "/profiles/create"],
    ["POST", "profiles/create"],
    ["POST", "/reset-profile"],
    ["POST", "reset-profile"],
    ["DELETE", "/profiles/poc"],
  ])("treats %s %s as a persistent profile mutation", (method, path) => {
    expect(isPersistentBrowserProfileMutation(method, path)).toBe(true);
  });

  it.each([
    ["GET", "/profiles"],
    ["GET", "/profiles/poc"],
    ["GET", "/status"],
    ["POST", "/stop"],
    ["DELETE", "/profiles"],
    ["DELETE", "/profiles/poc/tabs"],
  ])("allows non-mutating browser routes for %s %s", (method, path) => {
    expect(isPersistentBrowserProfileMutation(method, path)).toBe(false);
  });
});

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
    expect(matchBrowserUrlPattern("*", "https://example.com/app/dash")).toBe(true);
    expect(matchBrowserUrlPattern("**/dash", "https://example.com/app/dash")).toBe(true);
    expect(matchBrowserUrlPattern("https://example.com/*", "https://example.com/a")).toBe(true);
    expect(matchBrowserUrlPattern("https://example.com/*", "https://other.com/a")).toBe(false);
    expect(matchBrowserUrlPattern("https://example.com/*", "https://example.com/app/dash")).toBe(
      false,
    );
    expect(matchBrowserUrlPattern("https://example.com/**", "https://example.com/app/dash")).toBe(
      true,
    );
  });

  it("treats URL punctuation as literal in wildcard patterns", () => {
    expect(
      matchBrowserUrlPattern(
        "https://example.com/download?file=*",
        "https://example.com/download?file=report.pdf",
      ),
    ).toBe(true);
    expect(
      matchBrowserUrlPattern(
        "https://example.com/download?file=*",
        "https://example.com/downloadXfile=report.pdf",
      ),
    ).toBe(false);
    expect(matchBrowserUrlPattern("http://[::1]:*/**", "http://[::1]:9222/json/list")).toBe(true);
  });

  it("rejects empty patterns", () => {
    expect(matchBrowserUrlPattern("", "https://example.com")).toBe(false);
    expect(matchBrowserUrlPattern("   ", "https://example.com")).toBe(false);
  });
});
