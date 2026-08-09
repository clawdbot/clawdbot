// Error-format helper tests cover the non-Error cause stringifier contract.
import { describe, expect, it } from "vitest";
import {
  configureAcpErrorRedactor,
  redactSensitiveText,
  stringifyNonErrorCause,
} from "./error-format.js";

describe("stringifyNonErrorCause", () => {
  it("returns a string for values JSON.stringify serializes to undefined", () => {
    // JSON.stringify(fn|symbol|undefined) is undefined; the `string`-typed helper must not leak it.
    expect(stringifyNonErrorCause(() => {})).toBe("[object Function]");
    expect(stringifyNonErrorCause(Symbol("x"))).toBe("[object Symbol]");
    expect(stringifyNonErrorCause(undefined)).toBe("[object Undefined]");
  });

  it("stringifies ordinary scalar and object causes", () => {
    expect(stringifyNonErrorCause({ a: 1 })).toBe('{"a":1}');
    expect(stringifyNonErrorCause("hi")).toBe("hi");
    expect(stringifyNonErrorCause(42)).toBe("42");
    expect(stringifyNonErrorCause(null)).toBe("null");
  });
});

describe("redactSensitiveText", () => {
  it("applies fallback secret redaction after a configured redactor", () => {
    configureAcpErrorRedactor((value) => value.replace("prefix", "host-redacted"));
    try {
      expect(redactSensitiveText("prefix ghp_123456789012345678901234")).toBe(
        "host-redacted [REDACTED]",
      );
    } finally {
      configureAcpErrorRedactor(undefined);
    }
  });

  it("redacts unquoted auth-style HTTP headers in fallback errors", () => {
    const keyHeader = ["api", "-", "key"].join("");
    const googleHeader = ["x", "-", "goog", "-", "api", "-", "key"].join("");
    const accessHeader = ["x", "-", "access", "-", "token"].join("");
    const digestUser = ["digest", "user", "example"].join("-");
    const digestResponse = ["digest", "response", "1234567890abcdef"].join("-");
    const digestExtension = ["digest", "extension", "1234567890abcdef"].join("-");
    const digestTail = ["digest", "tail", "1234567890abcdef"].join("-");
    const awsCredential = [
      "AK",
      "IA",
      "EXAMPLE",
      "1234567890",
      "/20260717/eu-west-1/s3/aws4_request",
    ].join("");
    const awsSignature = ["aws", "signature", "1234567890abcdef"].join("-");
    const input = [
      ["Authorization", ": token ", "samplevalue1234567890abcd"].join(""),
      ["Proxy-Authorization", ": Digest ", "sampleproxyvalue1234567890"].join(""),
      `Authorization: Digest username="${digestUser}", 2fa="${digestExtension}", response="${digestResponse}", extension="${digestTail}", cnonce="tail-nonce"; request_id=digest-example`,
      `Authorization: AWS4-HMAC-SHA256 Credential=${awsCredential}, SignedHeaders=:authority;x_custom;x.custom, Signature=${awsSignature}; status=403`,
      `Proxy-Authorization: Digest username="${digestUser}", response="${digestResponse}"; request_id=proxy-example`,
      [keyHeader, ": ", "samplekeyvalue1234567890"].join(""),
      [googleHeader, "=", "samplegoogvalue1234567890"].join(""),
      [accessHeader, ": ", "sampleaccessvalue1234567890"].join(""),
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      [
        ["Authorization", ": token ", "[REDACTED]"].join(""),
        ["Proxy-Authorization", ": Digest ", "[REDACTED]"].join(""),
        "Authorization: Digest [REDACTED]; request_id=digest-example",
        "Authorization: AWS4-HMAC-SHA256 [REDACTED]; status=403",
        "Proxy-Authorization: Digest [REDACTED]; request_id=proxy-example",
        [keyHeader, ": ", "[REDACTED]"].join(""),
        [googleHeader, "=", "[REDACTED]"].join(""),
        [accessHeader, ": ", "[REDACTED]"].join(""),
      ].join("\n"),
    );
  });

  it("redacts escaped structured authorization fields", () => {
    const response = ["escaped", "digest", "response", "1234567890abcdef"].join("-");
    const input = `Authorization: Digest realm=\\"Example Realm\\", response=\\"${response}\\"; status=401`;

    expect(redactSensitiveText(input)).toBe("Authorization: Digest [REDACTED]; status=401");
  });

  it("redacts consecutive, prefixed, and serialized auth headers", () => {
    const proxyValue = ["cHJveH", "k6cGFz", "cw=="].join("");
    const customValue = ["Y3VzdG", "9tOnBh", "c3M="].join("");
    const accessValue = ["sample", "access", "value", "1234567890"].join("-");
    const googleValue = ["sample", "google", "value", "1234567890"].join("-");
    const input = [
      "Proxy-Authorization: Foo",
      `Proxy-Authorization: Basic ${proxyValue}`,
      `X-Authorization: Basic ${customValue}`,
      JSON.stringify({
        "x-access-token": accessValue,
        "x-goog-api-key": googleValue,
      }),
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      [
        "Proxy-Authorization: [REDACTED]",
        "Proxy-Authorization: Basic [REDACTED]",
        "X-Authorization: Basic [REDACTED]",
        JSON.stringify({
          "x-access-token": "[REDACTED]",
          "x-goog-api-key": "[REDACTED]",
        }),
      ].join("\n"),
    );
  });

  it("redacts later auth params and token credentials after punctuation", () => {
    const responseValue = ["later", "response", "value", "1234567890"].join("-");
    const negotiateValue = ["cHJvb2", "YxMjM0", "NTY3ODkw"].join("");
    const foldedValue = ["Zm9sZG", "VkOnNl", "Y3JldA=="].join("");
    const rawValue = ["raw", "header", "value", "1234567890"].join("-");
    const input = [
      `Authorization: Digest username="sample",,response="${responseValue}"; status=401`,
      `Authorization: Digest damaged,,response="${responseValue}"; status=403`,
      `Authorization: Digest username="sample", uri=/bad, response="${responseValue}"; status=407`,
      `Authorization: Digest username="sample",\r\n response="${responseValue}"; status=408`,
      `Authorization: Digest uri=http://service, response="${responseValue}"; status=409`,
      `Authorization: Digest response='${responseValue}'; status=410`,
      `Authorization: Digest realm=sample, authorization-param=${responseValue}; status=412`,
      `Authorization: Digest username=sample,\\r\\n response=${responseValue}; status=413`,
      `Authorization: Digest username=sample,\\r\\n\\tresponse=${responseValue}; status=414`,
      `(Authorization: Negotiate ${negotiateValue})`,
      `Authorization:\r\n Basic ${foldedValue}`,
      `Authorization:\nBasic ${foldedValue}`,
      `Authorization:\\nBasic ${foldedValue}`,
      `Authorization:\\tBearer ${foldedValue}`,
      `Authorization: Bearer\\t${foldedValue}`,
      `Authorization: ${rawValue}   `,
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      [
        "Authorization: Digest [REDACTED]; status=401",
        "Authorization: Digest [REDACTED]; status=403",
        "Authorization: Digest [REDACTED]; status=407",
        "Authorization: Digest [REDACTED]; status=408",
        "Authorization: Digest [REDACTED]; status=409",
        "Authorization: Digest [REDACTED]; status=410",
        "Authorization: Digest [REDACTED]; status=412",
        "Authorization: Digest [REDACTED]; status=413",
        "Authorization: Digest [REDACTED]; status=414",
        "(Authorization: Negotiate [REDACTED])",
        "Authorization:\r\n Basic [REDACTED]",
        "Authorization:\nBasic [REDACTED]",
        "Authorization:\\nBasic [REDACTED]",
        "Authorization:\\tBearer [REDACTED]",
        "Authorization: Bearer\\t[REDACTED]",
        "Authorization: [REDACTED]   ",
      ].join("\n"),
    );

    const serializedLine = JSON.stringify(
      `prefix\nAuthorization: Digest response="${responseValue}"`,
    );
    expect(redactSensitiveText(serializedLine)).toBe(
      JSON.stringify("prefix\nAuthorization: Digest [REDACTED]"),
    );
  });

  it("bounds recovery between repeated malformed auth headers", () => {
    const response = ["final", "response", "1234567890abcdef"].join("-");
    const malformed = Array.from({ length: 128 }, () => "Authorization: Digest damaged").join(" ");
    const output = redactSensitiveText(
      `${malformed} Authorization: Digest response="${response}"; status=411`,
    );

    expect(output).not.toContain(response);
    expect(output).toContain("Authorization: Digest [REDACTED]; status=411");
  });

  it("redacts parameterized schemes and encoded quoted-pairs", () => {
    const proof = ["hawk", "credential", "proof", "1234567890abcdef"].join("-");
    const response = ["escaped", "quoted", "response", "1234567890abcdef"].join("-");
    const input = [
      `Authorization: Hawk id="client", mac="${proof}"; status=401`,
      `Authorization: Digest realm=\\"Example \\\\\\"Realm\\\\\\"\\", response=\\"${response}\\"; status=403`,
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      [
        "Authorization: Hawk [REDACTED]; status=401",
        "Authorization: Digest [REDACTED]; status=403",
      ].join("\n"),
    );
  });

  it("redacts full auth-param tokens and serialized header objects", () => {
    const id = ["abc", "'", "def", "`", "ghi"].join("");
    const proof = ["token", "grammar", "proof", "1234567890abcdef"].join("-");
    const response = ["json", "digest", "response", "1234567890abcdef"].join("-");
    const input = [
      `Authorization: Foo id=${id}, proof=${proof}; status=401`,
      `{"Authorization":"Digest username=\\"example\\", response=\\"${response}\\""}`,
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      ["Authorization: Foo [REDACTED]; status=401", `{"Authorization":"[REDACTED]"}`].join("\n"),
    );
  });

  it("redacts nested serialized headers and punctuated token schemes", () => {
    const response = ["nested", "digest", "response", "1234567890abcdef"].join("-");
    const header = { Authorization: `Digest response="${response}\\\\"` };
    const serialized = JSON.stringify(JSON.stringify(header));
    const token = ["extension", "token", "1234567890abcdef"].join("-");
    const basicCredential = ["dXNl", "cjpw", "YXNz"].join("");
    const nestedBasic = JSON.stringify(
      JSON.stringify({ Authorization: `Basic ${basicCredential}` }),
    );
    const bearerCredential = ["/opaque", "~bearer", "1234567890abcdef"].join("-");
    const nestedBearer = JSON.stringify(
      JSON.stringify({ Authorization: `Bearer ${bearerCredential}` }),
    );
    const opaqueCredential = ["opaque", "credential", "1234567890abcdef"].join("-");
    const nestedOpaque = JSON.stringify(
      JSON.stringify({
        Authorization: opaqueCredential,
        "Proxy-Authorization": opaqueCredential,
      }),
    );

    expect(redactSensitiveText(serialized)).toBe(
      JSON.stringify(JSON.stringify({ Authorization: "Digest [REDACTED]" })),
    );
    expect(redactSensitiveText(JSON.stringify(header))).toBe(
      JSON.stringify({ Authorization: "[REDACTED]" }),
    );
    expect(redactSensitiveText(`Authorization: Foo+Bar ${token}; status=401`)).toBe(
      "Authorization: Foo+Bar [REDACTED]; status=401",
    );
    expect(redactSensitiveText(`Authorization: Basic+Foo ${token}; status=401`)).toBe(
      "Authorization: Basic+Foo [REDACTED]; status=401",
    );
    expect(redactSensitiveText(nestedBasic)).toBe(
      JSON.stringify(JSON.stringify({ Authorization: "Basic [REDACTED]" })),
    );
    expect(redactSensitiveText(`Authorization: Bearer ${bearerCredential}`)).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(redactSensitiveText(`request failed: Bearer ${bearerCredential}`)).toBe(
      "request failed: Bearer [REDACTED]",
    );
    expect(redactSensitiveText(nestedBearer)).toBe(
      JSON.stringify(JSON.stringify({ Authorization: "Bearer [REDACTED]" })),
    );
    expect(redactSensitiveText(nestedOpaque)).toBe(
      JSON.stringify(
        JSON.stringify({
          Authorization: "[REDACTED]",
          "Proxy-Authorization": "[REDACTED]",
        }),
      ),
    );
  });

  it("does not confuse real marker prefixes with internal redaction state", () => {
    const envKey = ["API", "_", "KEY"].join("");
    const prefixedSecret = ["***", "live", "secret", "1234567890abcdef"].join("-");
    const response = ["marker", "digest", "response", "1234567890abcdef"].join("-");
    const input = [
      `${envKey}=${prefixedSecret}`,
      `Authorization: Digest ***ext=one, response="${response}"; status=401`,
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      [`${envKey}=[REDACTED]`, "Authorization: Digest [REDACTED]; status=401"].join("\n"),
    );
  });

  it("preserves marker-shaped input while redacting structured auth", () => {
    const markerZero = ";__openclaw_structured_auth_redacted_0;";
    const markerOne = ";__openclaw_structured_auth_redacted_1;";
    const response = ["collision", "response", "1234567890abcdef"].join("-");
    const input = [
      markerZero,
      markerOne,
      `Authorization: Digest response="${response}"; status=401`,
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      [markerZero, markerOne, "Authorization: Digest [REDACTED]; status=401"].join("\n"),
    );
  });

  it("preserves Basic padding diagnostics and masks punctuation in header values", () => {
    const keyHeader = ["api", "-", "key"].join("");
    const input = [
      "Authorization: Basic dXNlcg==, status=401",
      `${keyHeader}: prefix)sensitive-suffix`,
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      ["Authorization: Basic [REDACTED], status=401", `${keyHeader}: [REDACTED]`].join("\n"),
    );
  });

  it("redacts quoted diagnostics while preserving structural closers", () => {
    const response = ["quoted", "header", "response", "1234567890abcdef"].join("-");
    const signature = ["structural", "aws", "signature", "1234567890abcdef"].join("-");
    const awsScopeField = ["Cred", "ential", "=scope/path"].join("");
    const input = [
      `curl -H 'Authorization: Digest username="example", response="${response}"'`,
      `{Authorization: AWS4-HMAC-SHA256 ${awsScopeField}, SignedHeaders=host, Signature=${signature}}`,
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      [
        "curl -H 'Authorization: Digest [REDACTED]'",
        "{Authorization: AWS4-HMAC-SHA256 [REDACTED]}",
      ].join("\n"),
    );
  });

  it("keeps diagnostics adjacent to single-token auth headers", () => {
    const keyHeader = ["api", "-", "key"].join("");
    const token = ["opaque", "auth", "value", "1234567890abcdef"].join("-");
    const input = [
      `Authorization: ${token}, status=401`,
      `Proxy-Authorization: ${token}; request_id=example`,
      `${keyHeader}: ${token}, status=500`,
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      [
        "Authorization: [REDACTED], status=401",
        "Proxy-Authorization: [REDACTED]; request_id=example",
        `${keyHeader}: [REDACTED], status=500`,
      ].join("\n"),
    );
  });

  it("keeps diagnostics adjacent to scheme-token auth headers", () => {
    const token = ["scheme", "auth", "value", "1234567890abcdef"].join("-");
    const input = [
      `Authorization: Token ${token}, status=401`,
      `Proxy-Authorization: Basic ${token}; request_id=example`,
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      [
        "Authorization: Token [REDACTED], status=401",
        "Proxy-Authorization: Basic [REDACTED]; request_id=example",
      ].join("\n"),
    );
  });

  it("does not redact ordinary authorization prose in fallback errors", () => {
    const input = "the authorization model is open";

    expect(redactSensitiveText(input)).toBe(input);
  });
});
