import { describe, expect, it } from "vitest";
import { normalizeTlsFingerprint, redactSensitiveKeyValuePairs } from "./client-address-utils.js";

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

const CANONICAL_FINGERPRINT = "ab".repeat(32);
const COLON_FINGERPRINT = CANONICAL_FINGERPRINT.match(/.{2}/gu)?.join(":") ?? "";

describe("TLS fingerprint normalization", () => {
  it.each([
    `sha256:${CANONICAL_FINGERPRINT.toUpperCase()}`,
    CANONICAL_FINGERPRINT.toUpperCase(),
    COLON_FINGERPRINT,
    `ShA256:${COLON_FINGERPRINT.toUpperCase()}`,
  ])("canonicalizes %s", (fingerprint) => {
    expect(normalizeTlsFingerprint(fingerprint)).toBe(CANONICAL_FINGERPRINT);
  });

  it.each([
    "",
    "abc123",
    "sha256:abc123",
    "g".repeat(64),
    `${CANONICAL_FINGERPRINT}:`,
    `sha256:${CANONICAL_FINGERPRINT}-junk`,
    `sha256:${CANONICAL_FINGERPRINT.slice(2)}`,
  ])("rejects invalid fingerprint %s", (fingerprint) => {
    expect(normalizeTlsFingerprint(fingerprint)).toBe("");
  });
});

describe("structured rejected-upgrade body redaction", () => {
  // Regression: `readUpgradeErrorBody` accepts an arbitrary peer body, so a
  // proxy can answer with JSON or colon-delimited fields instead of a form
  // body. Those values reached host sinks unredacted.
  it("redacts credential fields in a JSON body and keeps it parseable", () => {
    const body = JSON.stringify({
      "X-Amz-Credential": "AKIAJSONCREDENTIAL",
      "X-Amz-Signature": "JSONSIGNATUREVALUE",
      "X-Amz-Date": "20260813T000000Z",
    });

    const redacted = redactSensitiveKeyValuePairs(body);

    expect(redacted).not.toContain("AKIAJSONCREDENTIAL");
    expect(redacted).not.toContain("JSONSIGNATUREVALUE");
    // Non-credential fields stay readable for diagnostics.
    expect(redacted).toContain("20260813T000000Z");
    expect(JSON.parse(redacted)).toEqual({
      "X-Amz-Credential": "***",
      "X-Amz-Signature": "***",
      "X-Amz-Date": "20260813T000000Z",
    });
  });

  it("redacts colon-delimited credential fields", () => {
    const redacted = redactSensitiveKeyValuePairs(
      "X-Amz-Signature: COLONSIGNATUREVALUE, X-Amz-Date: 20260813T000000Z",
    );

    expect(redacted).not.toContain("COLONSIGNATUREVALUE");
    expect(redacted).toContain("20260813T000000Z");
  });

  it("leaves the surrounding error message and non-credential text intact", () => {
    const message = "gateway rejected websocket upgrade (HTTP 403): status=ok retries=2";

    expect(redactSensitiveKeyValuePairs(message)).toBe(message);
  });
});

describe("escaped JSON credential keys", () => {
  // Regression: `"X-Amz-\u0053ignature"` is a valid JSON spelling of the same
  // property name. Matching only the raw key text let the escaped spelling walk
  // past the classifier and keep its value in host-facing diagnostics.
  it("redacts a credential key written with JSON unicode escapes", () => {
    // Escaped spelling of "X-Amz-Signature"; JSON.parse sees the same name.
    const body =
      '{"X-Amz-\\u0053ignature":"ESCAPEDSIGNATUREVALUE","X-Amz-Date":"20260813T000000Z"}';
    expect(Object.keys(JSON.parse(body))).toContain("X-Amz-Signature");

    const redacted = redactSensitiveKeyValuePairs(body);

    expect(redacted).not.toContain("ESCAPEDSIGNATUREVALUE");
    expect(redacted).toContain("20260813T000000Z");
    expect(JSON.parse(redacted)).toEqual({
      "X-Amz-Signature": "***",
      "X-Amz-Date": "20260813T000000Z",
    });
  });

  it("redacts a credential key written with an escaped solidus", () => {
    const body = '{"X-Amz-Credential\\/id":"ESCAPEDSOLIDUSCREDENTIAL"}';

    const redacted = redactSensitiveKeyValuePairs(body);

    expect(redacted).not.toContain("ESCAPEDSOLIDUSCREDENTIAL");
    expect(JSON.parse(redacted)).toEqual({ "X-Amz-Credential/id": "***" });
  });

  it("leaves a malformed escape sequence intact instead of throwing", () => {
    // `\uZZZZ` is not valid JSON; the boundary must not throw while logging.
    const text = '{"X-Amz-\\uZZZZignature":"value"}';

    expect(() => redactSensitiveKeyValuePairs(text)).not.toThrow();
  });
});

describe("peer bodies that wrap a credential in another encoding", () => {
  it("redacts a quote-wrapped form-body value", () => {
    // A peer may quote the value; an unquoted-only value class stops at the
    // opening quote and leaves the credential in the forwarded error text.
    const body = 'sessionSecret="QUOTEDSESSIONSECRET"&safe=value';

    const redacted = redactSensitiveKeyValuePairs(body);

    expect(redacted).not.toContain("QUOTEDSESSIONSECRET");
    expect(redacted).toContain("safe=value");
  });

  it("redacts a single-quoted form-body value", () => {
    const redacted = redactSensitiveKeyValuePairs("privateKeyPem='SINGLEQUOTEDPEM'&safe=value");

    expect(redacted).not.toContain("SINGLEQUOTEDPEM");
    expect(redacted).toContain("safe=value");
  });

  it("redacts a credential inside a serialized JSON document nested in a safe field", () => {
    const inner = JSON.stringify({ sessionSecret: "NESTEDSESSIONSECRET", safe: "keep" });
    const body = JSON.stringify({ detail: inner });

    const redacted = redactSensitiveKeyValuePairs(body);

    expect(redacted).not.toContain("NESTEDSESSIONSECRET");
    // The redacted text must still be a parseable JSON document.
    const outer = JSON.parse(redacted) as { detail: string };
    expect(JSON.parse(outer.detail)).toEqual({ sessionSecret: "***", safe: "keep" });
  });

  it("stops recursing at the nesting cap instead of looping without bound", () => {
    let payload = JSON.stringify({ sessionSecret: "DEEPLYNESTEDSECRET" });
    for (let i = 0; i < 12; i += 1) {
      payload = JSON.stringify({ detail: payload });
    }

    expect(() => redactSensitiveKeyValuePairs(payload)).not.toThrow();
  });

  it("leaves a safe field holding non-credential serialized JSON unchanged", () => {
    const body = JSON.stringify({ detail: JSON.stringify({ safe: "value" }) });

    expect(redactSensitiveKeyValuePairs(body)).toBe(body);
  });
});
