import { extractToolResultText } from "@openclaw/ai/internal/shared";
// Proves the OpenClaw redaction contract applies to provider tool-result
// replay text once the stream facade installs the AI transport host ports.
import { describe, expect, it } from "vitest";
// Importing the facade installs the OpenClaw AI transport host ports.
import "./stream.js";

describe("tool result redaction via AI transport host", () => {
  it("redacts structured secret fields with the shared tool-payload contract", () => {
    const text = extractToolResultText([
      {
        type: "json",
        apiToken: "api-token-value-1234567890",
        privateKey: "private-key-value-1234567890",
        private_key: "private-key-snake-1234567890",
        key: "generic-key-value-1234567890",
        keyMaterial: "key-material-value-1234567890",
        bearerToken: "bearer-token-value-1234567890",
        bearer_token: "bearer-token-snake-value-1234567890",
        jwt: "jwt-value-1234567890",
        session: "session-value-1234567890",
        code: "code-value-1234567890",
        error: { code: "ERR_VISIBLE_PROVIDER_CODE" },
        oauth: { code: "OPAQUEPROVIDERCODE1234567890" },
        providerError: { error: { code: "ERR_VISIBLE_PROVIDER_NESTED_CODE" } },
        signature: "signature-value-1234567890",
        cookie: "cookie-value-1234567890",
        "set-cookie": "set-cookie-value-1234567890",
        paymentCredential: "payment-credential-value-1234567890",
        cardNumber: 4111111111111111,
        cvc: 123,
        text: '{"apiToken":"api-token-in-text-1234567890","code":"oauth-code-in-text-1234567890","safe":"ok"}',
        credential: "live-credential-value",
        appSecret: "app-secret-value",
        rawSecret: "raw-secret-value",
        nested: {
          token: "nested-token-value",
          visible: "safe-value",
        },
      },
    ]);

    expect(text).toContain('"credential":"');
    expect(text).toContain('"appSecret":"');
    expect(text).toContain('"rawSecret":"');
    expect(text).toContain('"token":"');
    expect(text).toContain('"visible":"safe-value"');
    expect(text).toContain('"code":"ERR_VISIBLE_PROVIDER_CODE"');
    expect(text).toContain('"code":"ERR_VISIBLE_PROVIDER_NESTED_CODE"');
    expect(text).not.toContain("api-token-value-1234567890");
    expect(text).not.toContain("private-key-value-1234567890");
    expect(text).not.toContain("private-key-snake-1234567890");
    expect(text).not.toContain("generic-key-value-1234567890");
    expect(text).not.toContain("key-material-value-1234567890");
    expect(text).not.toContain("bearer-token-value-1234567890");
    expect(text).not.toContain("bearer-token-snake-value-1234567890");
    expect(text).not.toContain("jwt-value-1234567890");
    expect(text).not.toContain("session-value-1234567890");
    expect(text).not.toContain("code-value-1234567890");
    expect(text).not.toContain("OPAQUEPROVIDERCODE1234567890");
    expect(text).not.toContain("signature-value-1234567890");
    expect(text).not.toContain("cookie-value-1234567890");
    expect(text).not.toContain("set-cookie-value-1234567890");
    expect(text).not.toContain("payment-credential-value-1234567890");
    expect(text).not.toContain("4111111111111111");
    expect(text).not.toContain('"cvc":123');
    expect(text).not.toContain("api-token-in-text-1234567890");
    expect(text).not.toContain("oauth-code-in-text-1234567890");
    expect(text).toContain('\\"safe\\":\\"ok\\"');
    expect(text).not.toContain("live-credential-value");
    expect(text).not.toContain("app-secret-value");
    expect(text).not.toContain("raw-secret-value");
    expect(text).not.toContain("nested-token-value");
  });
});
