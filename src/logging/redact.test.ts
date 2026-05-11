import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDefaultRedactPatterns,
  redactSecrets,
  redactSensitiveFieldValue,
  redactSensitiveLines,
  redactSensitiveText,
  resolveRedactOptions,
} from "./redact.js";

const defaults = getDefaultRedactPatterns();
const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
let tempDirs: string[] = [];

function writeConfig(source: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-redact-config-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, source);
  process.env.OPENCLAW_CONFIG_PATH = configPath;
}

afterEach(() => {
  if (originalConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
  }
  for (const dir of tempDirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("redactSensitiveText", () => {
  it("masks env assignments while keeping the key", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("OPENAI_API_KEY=sk-123…cdef");
  });

  it("masks CLI flags", () => {
    const input = "curl --token abcdef1234567890ghij https://api.test";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("curl --token abcdef…ghij https://api.test");
  });

  it("masks hook token CLI flags", () => {
    const input = "gog gmail watch serve --hook-token abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("gog gmail watch serve --hook-token abcdef…ghij");
  });

  it("masks sensitive URL query parameters", () => {
    const input = "connect https://user.example/sync?access_token=abcdef1234567890ghij&safe=value";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("connect https://user.example/sync?access_token=abcdef…ghij&safe=value");
  });

  it("masks short URL query tokens fully", () => {
    const input = "cdp=https://browserless.example.com/?token=supersecret123";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("cdp=https://browserless.example.com/?token=***");
  });

  it("masks standalone lowercase token assignments in diagnostic output", () => {
    const input = "matrix access_token=abcdef1234567890ghij next";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("matrix access_token=abcdef…ghij next");
  });

  it("masks JSON fields", () => {
    const input = '{"token":"abcdef1234567890ghij"}';
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe('{"token":"abcdef…ghij"}');
  });

  it("masks payment credential JSON fields without redacting unrelated amounts", () => {
    const input =
      '{"card_number":"4242424242424242","cvc":"123","sharedPaymentToken":"spt_abcdefghijklmnopqrstuvwxyz","payment_credential":"paycred_abcdefghijklmnopqrstuvwxyz","amount":"4200"}';
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe(
      '{"card_number":"***","cvc":"***","sharedPaymentToken":"spt_ab…wxyz","payment_credential":"paycre…wxyz","amount":"4200"}',
    );
  });

  it("masks HTTP client config secrets in JSON and object-inspection fields", () => {
    const appSecret = "feishu_app_secret_1234567890";
    const clientSecret = "oauth_client_secret_1234567890";
    const input = [
      `body: {"app_secret":"${appSecret}"}`,
      `config: { appSecret: '${appSecret}', client_secret: '${clientSecret}' }`,
    ].join("\n");
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toContain('"app_secret":"feishu…7890"');
    expect(output).toContain("appSecret: 'feishu…7890'");
    expect(output).toContain("client_secret: 'oauth_…7890'");
    expect(output).not.toContain(appSecret);
    expect(output).not.toContain(clientSecret);
  });

  it("masks payment credential assignments and flags", () => {
    const input = [
      "LINK_CARD_NUMBER=4242424242424242",
      "LINK_CVC=123",
      "shared_payment_token=spt_abcdefghijklmnopqrstuvwxyz",
      "--payment-credential paycred_abcdefghijklmnopqrstuvwxyz",
      "--card-number 4000056655665556",
    ].join(" ");
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).not.toContain("4242424242424242");
    expect(output).not.toContain("4000056655665556");
    expect(output).not.toContain("spt_abcdefghijklmnopqrstuvwxyz");
    expect(output).not.toContain("paycred_abcdefghijklmnopqrstuvwxyz");
    expect(output).toContain("LINK_CARD_NUMBER=***");
    expect(output).toContain("LINK_CVC=***");
    expect(output).toContain("shared_payment_token=spt_ab…wxyz");
    expect(output).toContain("--payment-credential paycre…wxyz");
    expect(output).toContain("--card-number ***");
  });

  it("masks quoted HTTP auth headers in object-inspection fields", () => {
    const bearer = "feishu_tenant_access_abcdef123456";
    const cookie = "session_cookie_value_abcdef123456";
    const input = `headers: { authorization: 'Bearer ${bearer}', cookie: '${cookie}' }`;
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toContain("authorization: 'Bearer…3456'");
    expect(output).toContain("cookie: 'sessio…3456'");
    expect(output).not.toContain(bearer);
    expect(output).not.toContain(cookie);
  });

  it("masks payment credential URL query parameters", () => {
    const input =
      "POST /authorize?shared_payment_token=spt_abcdefghijklmnopqrstuvwxyz&card_number=4242424242424242&amount=4200";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe(
      "POST /authorize?shared_payment_token=spt_ab…wxyz&card_number=***&amount=4200",
    );
  });

  it("masks structured payment credential field values by key", () => {
    expect(redactSensitiveFieldValue("sharedPaymentToken", "spt_abcdefghijklmnopqrstuvwxyz")).toBe(
      "spt_ab…wxyz",
    );
    expect(redactSensitiveFieldValue("cardNumber", "4242424242424242")).toBe("***");
    expect(redactSensitiveFieldValue("amount", "4200")).toBe("4200");
  });

  it("masks bearer tokens", () => {
    const input = "Authorization: Bearer abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("Authorization: Bearer abcdef…ghij");
  });

  it("masks URL query tokens", () => {
    const input = "GET /_matrix/client/v3/sync?access_token=abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("GET /_matrix/client/v3/sync?access_token=abcdef…ghij");
  });

  it("masks bot-style tokens", () => {
    const input = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("123456…cdef");
  });

  it("masks bot API URL tokens", () => {
    const input =
      "GET https://api.example.test/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef/getMe HTTP/1.1";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("GET https://api.example.test/bot123456…cdef/getMe HTTP/1.1");
  });

  it("redacts short tokens fully", () => {
    const input = "TOKEN=shortvalue";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("TOKEN=***");
  });

  it("does not redact lowercase key diagnostics", () => {
    const input = 'agents.defaults: Unrecognized key: "llm"';
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe(input);
  });

  it("masks sensitive URL query params while preserving non-sensitive params", () => {
    const input = "GET /_matrix/client/v3/sync?access_token=abcdef1234567890ghij&since=123";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("GET /_matrix/client/v3/sync?access_token=abcdef…ghij&since=123");
  });

  it("treats sensitive URL query param names case-insensitively", () => {
    const input = "connect https://gateway.example/ws?Access-Token=short-token&ok=1";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("connect https://gateway.example/ws?Access-Token=***&ok=1");
  });

  it("redacts private key blocks", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "ABCDEF1234567890",
      "ZYXWVUT987654321",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe(
      ["-----BEGIN PRIVATE KEY-----", "…redacted…", "-----END PRIVATE KEY-----"].join("\n"),
    );
  });

  it("honors custom patterns with flags", () => {
    const input = "token=abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: ["/token=([A-Za-z0-9]+)/i"],
    });
    expect(output).toBe("token=abcdef…ghij");
  });

  it("honors escaped character classes in custom patterns", () => {
    const input = "contact peter@dc.io";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: [String.raw`([\w]|[-.])+@([\w]|[-.])+\.\w+`],
    });
    expect(output).toBe("contact peter@d***.io");
    expect(output).not.toContain("peter@dc.io");
  });

  it("ignores unsafe nested-repetition custom patterns", () => {
    const input = `${"a".repeat(28)}!`;
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: ["(a+)+$"],
    });
    expect(output).toBe(input);
  });

  it("redacts large payloads with bounded regex passes", () => {
    const input = `${"x".repeat(40_000)} OPENAI_API_KEY=sk-1234567890abcdef ${"y".repeat(40_000)}`;
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toContain("OPENAI_API_KEY=sk-123…cdef");
  });

  it("masks Tencent Cloud SecretId (AKID prefix, uppercase-only)", () => {
    const input = "SecretId is AKIDZ8EXAMPLEFAKE01KEY99TEST";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("SecretId is AKIDZ8…TEST");
  });

  it("masks Tencent Cloud SecretId with mixed-case characters", () => {
    const input = "AKIDz8exampleFake01Key99Test";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("AKIDz8…Test");
  });

  it("masks Alibaba Cloud AccessKey ID (LTAI prefix)", () => {
    const input = "AccessKeyId=LTAI5tExampleFakeKeyXyz9";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("AccessKeyId=LTAI5t…Xyz9");
  });

  it("masks HuggingFace tokens (hf_ prefix)", () => {
    const input = "hf_ABCDEFghijklmnopqrstuv";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("hf_ABC…stuv");
  });

  it("masks Replicate tokens (r8_ prefix)", () => {
    const input = "r8_ABCDEFghijklmnopqrstuv";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("r8_ABC…stuv");
  });

  it("masks OAuth and JWT token shapes", () => {
    const input = [
      "ya29.fake-access-token-with-enough-length",
      "1//0fake-refresh-token-with-enough-length",
      "eyJheaderabcd.eyJpayloadabcd.signatureabcd123456",
    ].join(" ");
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).not.toContain("ya29.fake-access-token");
    expect(output).not.toContain("1//0fake-refresh-token");
    expect(output).not.toContain("eyJheaderabcd.eyJpayloadabcd.signatureabcd123456");
  });

  it("masks app-specific password shapes only in secret contexts", () => {
    const input = [
      "password=abcd-efgh-ijkl-mnop",
      "--password qrst-uvwx-yzab-cdef",
      '{"password":"lmno-pqrs-tuvw-xyza"}',
      "main-test-case-name",
    ].join(" ");
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).not.toContain("abcd-efgh-ijkl-mnop");
    expect(output).not.toContain("qrst-uvwx-yzab-cdef");
    expect(output).not.toContain("lmno-pqrs-tuvw-xyza");
    expect(output).toContain("main-test-case-name");
  });

  it("skips redaction when mode is off", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, {
      mode: "off",
      patterns: defaults,
    });
    expect(output).toBe(input);
  });

  it("honors logging redaction settings from the active config path", () => {
    writeConfig(`{
      logging: {
        redactSensitive: "off",
      },
    }`);

    expect(redactSensitiveText("OPENAI_API_KEY=sk-1234567890abcdef")).toBe(
      "OPENAI_API_KEY=sk-1234567890abcdef",
    );
  });

  it("does not resolve patterns when mode is off", () => {
    const options = {
      mode: "off" as const,
      get patterns(): never {
        throw new Error("patterns should not be read when redaction is off");
      },
    };

    expect(resolveRedactOptions(options)).toEqual({
      mode: "off",
      patterns: [],
    });
    expect(redactSensitiveText("OPENAI_API_KEY=sk-1234567890abcdef", options)).toBe(
      "OPENAI_API_KEY=sk-1234567890abcdef",
    );
  });

  it("reuses compiled global regex patterns", () => {
    const pattern = /token=([A-Za-z0-9]+)/g;
    const resolved = resolveRedactOptions({
      mode: "tools",
      patterns: [pattern],
    });

    expect(resolved.patterns).toHaveLength(1);
    expect(resolved.patterns[0]).toBe(pattern);
  });
});

describe("redactSecrets", () => {
  it("redacts nested structured payloads before JSON persistence", () => {
    const input = {
      plugin: {
        config: {
          apiKey: "AIzaSyD-very-real-looking-google-api-key-123",
          access: "ya29.fake-access-token-with-enough-length",
          refresh: "1//0fake-refresh-token-with-enough-length",
          password: "abcd-efgh-ijkl-mnop",
        },
      },
      transcript: [
        {
          text: "jwt eyJheaderabcd.eyJpayloadabcd.signatureabcd123456 and main-test-case-name",
        },
        {
          text: "standalone app password abcd-efgh-ijkl-mnop",
          errorMessage: "failed with app password qrst-uvwx-yzab-cdef",
        },
      ],
    };

    const output = redactSecrets(input);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("AIzaSyD-very-real-looking");
    expect(serialized).not.toContain("ya29.fake-access-token");
    expect(serialized).not.toContain("1//0fake-refresh-token");
    expect(serialized).not.toContain("eyJheaderabcd.eyJpayloadabcd.signatureabcd123456");
    expect(serialized).not.toContain("abcd-efgh-ijkl-mnop");
    expect(serialized).not.toContain("qrst-uvwx-yzab-cdef");
    expect(serialized).toContain("main-test-case-name");
  });

  it("preserves benign bare access and refresh fields", () => {
    const output = redactSecrets({
      permissions: {
        access: "read",
        refresh: "monthly",
      },
      oauth: {
        access: "ya29.fake-access-token-with-enough-length",
        refresh: "1//0fake-refresh-token-with-enough-length",
        accessToken: "opaque-access-token-value",
        refreshToken: "opaque-refresh-token-value",
      },
    });

    expect(output.permissions).toEqual({
      access: "read",
      refresh: "monthly",
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("ya29.fake-access-token");
    expect(serialized).not.toContain("1//0fake-refresh-token");
    expect(serialized).not.toContain("opaque-access-token-value");
    expect(serialized).not.toContain("opaque-refresh-token-value");
  });
});

describe("redactSensitiveLines", () => {
  it("redacts matching content across all lines", () => {
    const resolved = resolveRedactOptions({ mode: "tools", patterns: defaults });
    const lines = ["curl --token abcdef1234567890ghij https://api.test", "normal log line"];
    const result = redactSensitiveLines(lines, resolved);
    expect(result[0]).toBe("curl --token abcdef…ghij https://api.test");
    expect(result[1]).toBe("normal log line");
  });

  it("returns lines unmodified when mode is off", () => {
    const resolved = resolveRedactOptions({ mode: "off", patterns: defaults });
    const lines = ["TOKEN=abcdef1234567890ghij"];
    expect(redactSensitiveLines(lines, resolved)).toEqual(lines);
  });

  it("returns lines unmodified when resolved patterns is empty — does not fall back to defaults", () => {
    // Simulates the case where all user-configured patterns fail to compile.
    // The pre-resolved empty array must be honored, not silently replaced with defaults.
    const resolved = { mode: "tools" as const, patterns: [] };
    const lines = ["TOKEN=abcdef1234567890ghij"];
    expect(redactSensitiveLines(lines, resolved)).toEqual(lines);
  });

  it("returns empty array unchanged — does not produce a synthetic blank line", () => {
    const resolved = resolveRedactOptions({ mode: "tools", patterns: defaults });
    expect(redactSensitiveLines([], resolved)).toStrictEqual([]);
  });

  it("redacts a PEM block spanning multiple lines in the array", () => {
    const resolved = resolveRedactOptions({ mode: "tools", patterns: defaults });
    const lines = [
      "log: key follows",
      "-----BEGIN PRIVATE KEY-----",
      "ABCDEF1234567890",
      "ZYXWVUT987654321",
      "-----END PRIVATE KEY-----",
      "log: key done",
    ];
    const result = redactSensitiveLines(lines, resolved);
    const joined = result.join("\n");
    expect(joined).toContain("-----BEGIN PRIVATE KEY-----");
    expect(joined).toContain("-----END PRIVATE KEY-----");
    expect(joined).toContain("…redacted…");
    expect(joined).not.toContain("ABCDEF1234567890");
  });
});
