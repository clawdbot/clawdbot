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

  it("keeps redacting the substring-marker names this log path already covered", () => {
    // Regression guard. The gateway log path historically matched these by
    // substring. They are not exact canonical parameter names, so an
    // exact-name-only classifier would silently stop redacting them.
    expect(isSensitiveUrlQueryParamName("sessionSecret")).toBe(true);
    expect(isSensitiveUrlQueryParamName("privateKeyPem")).toBe(true);
    expect(isSensitiveUrlQueryParamName("authMethod")).toBe(true);
    expect(isSensitiveUrlQueryParamName("apiKeyId")).toBe(true);
    expect(isSensitiveUrlQueryParamName("userToken")).toBe(true);
    expect(isSensitiveUrlQueryParamName("passwordHash")).toBe(true);
  });

  it("leaves params without a credential marker readable", () => {
    expect(isSensitiveUrlQueryParamName("signal")).toBe(false);
    expect(isSensitiveUrlQueryParamName("sigmoid")).toBe(false);
    expect(isSensitiveUrlQueryParamName("x-api-version")).toBe(false);
    expect(isSensitiveUrlQueryParamName("x-request-id")).toBe(false);
    expect(isSensitiveUrlQueryParamName("safe")).toBe(false);
  });
});
