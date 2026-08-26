import { describe, expect, it } from "vitest";
import { redactOllamaResponseErrorText } from "./request-header-redaction.js";

function mixPercentEscapeCase(value: string): string {
  let useLowerCase = true;
  return value.replace(/%[0-9A-F]{2}/gu, (escape) => {
    useLowerCase = !useLowerCase;
    return useLowerCase ? escape.toLowerCase() : escape;
  });
}

describe("Ollama request header redaction", () => {
  it("redacts configured header values and bare authorization credentials", () => {
    const secrets = [
      "Bearer bearer-credential",
      "bearer-credential",
      "Basic proxy-credential",
      "proxy-credential",
      "custom-credential",
    ];
    const redacted = redactOllamaResponseErrorText(
      `content-type=application/json reflected=${secrets.join(" ")}`,
      {
        "Content-Type": "application/json",
        Authorization: "Bearer bearer-credential",
        "Proxy-Authorization": "Basic proxy-credential",
        "X-Proxy-Auth": "custom-credential",
      },
    );

    expect(redacted).toContain("content-type=application/json");
    for (const secret of secrets) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("redacts raw, JSON, URI, and form representations without rewriting unrelated escapes", () => {
    const secret = 'river +17/GLASS~MOTH%"tail';
    const uriEncoded = mixPercentEscapeCase(encodeURIComponent(secret));
    const formEncoded = mixPercentEscapeCase(
      new URLSearchParams([["value", secret]]).toString().slice("value=".length),
    );
    const jsonEncoded = JSON.stringify(secret).slice(1, -1);
    const text = [
      `raw=${secret}`,
      `json={"opaque":"${jsonEncoded}"}`,
      `uri=${uriEncoded}`,
      `form=${formEncoded}`,
      "safe=id%2fpart keep%afcase",
    ].join(" ");

    const redacted = redactOllamaResponseErrorText(text, { "X-Proxy-Auth": secret });

    for (const representation of [secret, jsonEncoded, uriEncoded, formEncoded]) {
      expect(redacted).not.toContain(representation);
    }
    expect(redacted).toContain("safe=id%2fpart keep%afcase");
  });

  it("keeps raw exact matching case-sensitive", () => {
    const secret = "CASE-sensitive-credential";
    const lowerCaseControl = secret.toLowerCase();

    expect(redactOllamaResponseErrorText(lowerCaseControl, { "X-Auth": secret })).toBe(
      lowerCaseControl,
    );
  });

  it("redacts a secret prefix only when the response was truncated", () => {
    const secret = "boundary-credential-secret";
    const retainedPrefix = secret.slice(0, -4);
    const text = `safe diagnostic ${retainedPrefix}`;

    expect(
      redactOllamaResponseErrorText(text, { "X-Auth": secret }, { sourceTruncated: true }),
    ).toBe("safe diagnostic ***");
    expect(redactOllamaResponseErrorText(text, { "X-Auth": secret })).toBe(text);
  });

  it("redacts a short secret prefix at a confirmed response boundary", () => {
    const secret = "boundary-credential-secret";

    expect(
      redactOllamaResponseErrorText(
        "diagnostic boun",
        { "X-Auth": secret },
        {
          sourceTruncated: true,
        },
      ),
    ).toBe("diagnostic ***");
  });

  it("redacts raw and JSON forms when a value contains a lone surrogate", () => {
    const secret = "lone-\ud800-surrogate-secret";
    const jsonEncoded = JSON.stringify(secret).slice(1, -1);
    const redacted = redactOllamaResponseErrorText(`raw=${secret} json=${jsonEncoded}`, {
      "X-Auth": secret,
    });

    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(jsonEncoded);
  });
});
