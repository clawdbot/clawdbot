import { describe, expect, it } from "vitest";
import { isSensitiveUrlQueryParamName } from "./client-address-utils.js";

describe("isSensitiveUrlQueryParamName", () => {
  it("classifies signed cloud URL credentials and signatures as sensitive", () => {
    expect(isSensitiveUrlQueryParamName("X-Amz-Credential")).toBe(true);
    expect(isSensitiveUrlQueryParamName("X-Amz-Signature")).toBe(true);
    expect(isSensitiveUrlQueryParamName("X-Goog-Credential")).toBe(true);
    expect(isSensitiveUrlQueryParamName("X-Goog-Signature")).toBe(true);
    expect(isSensitiveUrlQueryParamName("X-Amz-Date")).toBe(false);
  });
});
