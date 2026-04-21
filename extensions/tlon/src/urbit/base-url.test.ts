import { describe, expect, it } from "vitest";
import { validateUrbitBaseUrl } from "./base-url.js";

describe("validateUrbitBaseUrl", () => {
  function expectValidBaseUrl(raw: string) {
    const result = validateUrbitBaseUrl(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result;
  }

  it("adds https:// when scheme is missing and strips path/query fragments", () => {
    const result = expectValidBaseUrl("example.com/foo?bar=baz");
    expect(result.baseUrl).toBe("https://example.com");
    expect(result.hostname).toBe("example.com");
  });

  it("rejects non-http schemes", () => {
    const result = validateUrbitBaseUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("http:// or https://");
  });

  it("rejects embedded credentials", () => {
    const result = validateUrbitBaseUrl("https://user:pass@example.com");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("credentials");
  });

  it("normalizes a trailing dot in the hostname for origin construction", () => {
    const result = expectValidBaseUrl("https://example.com./foo");
    expect(result.baseUrl).toBe("https://example.com");
    expect(result.hostname).toBe("example.com");
  });

  it("preserves port in the normalized origin", () => {
    const result = expectValidBaseUrl("http://example.com:8080/~/login");
    expect(result.baseUrl).toBe("http://example.com:8080");
  });
});
