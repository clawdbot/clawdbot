import { describe, expect, it } from "vitest";
import { normalizeFeishuExternalKey } from "./external-keys.js";

describe("normalizeFeishuExternalKey", () => {
  it("accepts a normal feishu key and trims surrounding spaces", () => {
    expect(normalizeFeishuExternalKey("  img_v3_01abcDEF123  ")).toBe("img_v3_01abcDEF123");
  });

  it("rejects traversal and path separator patterns", () => {
    expect(normalizeFeishuExternalKey("../etc/passwd")).toBeUndefined();
    expect(normalizeFeishuExternalKey("a/../../b")).toBeUndefined();
    expect(normalizeFeishuExternalKey("a\\..\\b")).toBeUndefined();
  });

  it("rejects empty, non-string, and control-char values", () => {
    expect(normalizeFeishuExternalKey("   ")).toBeUndefined();
    expect(normalizeFeishuExternalKey(123)).toBeUndefined();
    expect(normalizeFeishuExternalKey("abc\u0000def")).toBeUndefined();
  });
});
