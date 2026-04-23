import { describe, expect, it } from "vitest";
import { isHttpMediaUrl } from "./inbound.js";

describe("isHttpMediaUrl", () => {
  it("accepts only http and https urls", () => {
    expect(isHttpMediaUrl("https://example.com/image.png")).toBe(true);
    expect(isHttpMediaUrl("http://example.com/image.png")).toBe(true);
    expect(isHttpMediaUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpMediaUrl("/etc/passwd")).toBe(false);
    expect(isHttpMediaUrl("data:text/plain;base64,SGVsbG8=")).toBe(false);
  });
});
