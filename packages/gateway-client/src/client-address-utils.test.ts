import { describe, expect, it } from "vitest";
import { redactSensitiveKeyValuePairs } from "./client-address-utils.js";

/** True when the log path masks this parameter name's value. */
function redactsName(name: string): boolean {
  return redactSensitiveKeyValuePairs(`?${name}=SECRET`) === `?${name}=***`;
}

describe("gateway log parameter classification", () => {
  it("classifies signed cloud URL credentials and signatures as sensitive", () => {
    expect(redactsName("X-Amz-Credential")).toBe(true);
    expect(redactsName("X-Amz-Signature")).toBe(true);
    expect(redactsName("X-Goog-Credential")).toBe(true);
    expect(redactsName("X-Goog-Signature")).toBe(true);
    expect(redactsName("X-Amz-Date")).toBe(false);
  });

  it("keeps redacting the substring-marker names this log path already covered", () => {
    // Regression guard. The gateway log path historically matched these by
    // substring. They are not exact canonical parameter names, so an
    // exact-name-only classifier would silently stop redacting them.
    expect(redactsName("sessionSecret")).toBe(true);
    expect(redactsName("privateKeyPem")).toBe(true);
    expect(redactsName("authMethod")).toBe(true);
    expect(redactsName("apiKeyId")).toBe(true);
    expect(redactsName("userToken")).toBe(true);
    expect(redactsName("passwordHash")).toBe(true);
  });

  it("leaves params without a credential marker readable", () => {
    expect(redactsName("signal")).toBe(false);
    expect(redactsName("sigmoid")).toBe(false);
    expect(redactsName("x-api-version")).toBe(false);
    expect(redactsName("x-request-id")).toBe(false);
    expect(redactsName("safe")).toBe(false);
  });
});

describe("redactSensitiveKeyValuePairs", () => {
  it("redacts query pairs behind ? and &", () => {
    expect(redactSensitiveKeyValuePairs("https://h/p?token=abc&safe=1&X-Amz-Signature=sig")).toBe(
      "https://h/p?token=***&safe=1&X-Amz-Signature=***",
    );
  });

  it("redacts a leading form-body pair that carries no ? or & prefix", () => {
    // The shape a rejected HTTP upgrade appends after `: `. Without a
    // start-or-whitespace boundary the first pair is the one that leaks.
    expect(
      redactSensitiveKeyValuePairs(
        "gateway rejected websocket upgrade (HTTP 403): X-Amz-Credential=AKIALEAK&X-Amz-Signature=sig&X-Amz-Date=20260813T000000Z",
      ),
    ).toBe(
      "gateway rejected websocket upgrade (HTTP 403): X-Amz-Credential=***&X-Amz-Signature=***&X-Amz-Date=20260813T000000Z",
    );
  });

  it("redacts a pair at the very start of the text", () => {
    expect(redactSensitiveKeyValuePairs("client_secret=abc&safe=1")).toBe(
      "client_secret=***&safe=1",
    );
  });

  it("keeps text that is not a sensitive pair intact", () => {
    expect(redactSensitiveKeyValuePairs("gateway rejected websocket upgrade (HTTP 503)")).toBe(
      "gateway rejected websocket upgrade (HTTP 503)",
    );
    expect(redactSensitiveKeyValuePairs("status=ok retries=2")).toBe("status=ok retries=2");
  });
});
