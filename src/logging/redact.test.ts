// Redaction tests cover secret, token, and identifier scrubbing rules.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { withFullContextToolPayloadRedaction } from "./redact-internal.js";
import {
  getDefaultRedactPatterns,
  redactSecrets,
  redactSensitiveFieldValue,
  redactSensitiveLines,
  redactSensitiveText,
  redactToolDetail,
  redactToolPayloadTextWithConfig,
  resolveRedactOptions,
} from "./redact.js";
import {
  registerSecretValueForRedaction,
  resetSecretRedactionRegistryForTest,
} from "./secret-redaction-registry.js";

const defaults = getDefaultRedactPatterns();
let tempDirs: string[] = [];

function writeConfig(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-redact-config-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, source);
  return configPath;
}

afterEach(() => {
  resetSecretRedactionRegistryForTest();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("registered exact secret values", () => {
  it("masks registered values in text and nested structured data", () => {
    const secret = "registered-exact-secret";
    registerSecretValueForRedaction(secret);

    expect(redactSensitiveText(`before ${secret} after`, { mode: "off" })).toBe(
      "before regist…cret after",
    );
    expect(redactSecrets({ detail: `before ${secret} after` })).toEqual({
      detail: "before regist…cret after",
    });
    expect(
      redactToolPayloadTextWithConfig(
        `full context ${secret}`,
        withFullContextToolPayloadRedaction(undefined),
      ),
    ).toBe("full context regist…cret");
  });

  it("ignores values shorter than six characters", () => {
    registerSecretValueForRedaction("abcde");
    expect(redactSensitiveText("value abcde", { mode: "off" })).toBe("value abcde");
    expect(redactSecrets({ detail: "abcde" })).toEqual({ detail: "abcde" });
  });

  it("masks the percent-encoded form of registered values", () => {
    const secret = "path/token with+reserved%chars";
    registerSecretValueForRedaction(secret);

    const encoded = encodeURIComponent(secret);
    expect(redactSensitiveText(`url path ${encoded}`, { mode: "off" })).not.toContain(encoded);
    expect(redactSensitiveText(`raw ${secret}`, { mode: "off" })).not.toContain(secret);
  });

  it("masks JSON-escaped registered values", () => {
    const secret = 'quoted-"secret\\line\nvalue';
    registerSecretValueForRedaction(secret);

    const json = JSON.stringify({ credential: secret });
    expect(redactSensitiveText(json, { mode: "off" })).not.toContain(
      JSON.stringify(secret).slice(1, -1),
    );
  });

  it("evicts the oldest value after 512 registrations", () => {
    const first = "exact-registry-value-000";
    registerSecretValueForRedaction(first);
    for (let index = 1; index <= 512; index += 1) {
      registerSecretValueForRedaction(`exact-registry-value-${index.toString().padStart(3, "0")}`);
    }
    const last = "exact-registry-value-512";

    expect(redactSensitiveText(first, { mode: "off" })).toBe(first);
    expect(redactSensitiveText(last, { mode: "off" })).toBe("exact-…-512");
  });

  it("refreshes duplicate registration recency before eviction", () => {
    const first = "exact-registry-refresh-000";
    const second = "exact-registry-refresh-001";
    for (let index = 0; index < 512; index += 1) {
      registerSecretValueForRedaction(
        `exact-registry-refresh-${index.toString().padStart(3, "0")}`,
      );
    }
    registerSecretValueForRedaction(first);
    registerSecretValueForRedaction("exact-registry-refresh-512");

    expect(redactSensitiveText(first, { mode: "off" })).not.toContain(first);
    expect(redactSensitiveText(second, { mode: "off" })).toBe(second);
  });
});

describe("redactSensitiveText", () => {
  it("masks env assignments while keeping the key", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("OPENAI_API_KEY=sk-123…cdef");
  });

  it("preserves shell env references in assignments", () => {
    const input = [
      'DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"',
      "OPENAI_API_KEY=$OPENAI_API_KEY",
      "API_KEY=$API_KEY",
      "TOKEN=${TOKEN}",
      "PASSWORD=${PASSWORD:-}",
      "GITHUB_TOKEN=${GITHUB_TOKEN}",
    ].join("\n");
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(input);
  });

  it("masks shell env references that do not match the assignment key", () => {
    const output = redactSensitiveText("DISCORD_BOT_TOKEN=$SUPERSECRET123", { mode: "tools" });
    expect(output).toBe("DISCORD_BOT_TOKEN=***");
  });

  it("masks literal shell env expansion defaults in assignments", () => {
    const fallback = "discordliteral1234567890";
    const input = `DISCORD_BOT_TOKEN="\${DISCORD_BOT_TOKEN:-${fallback}}"`;
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).not.toContain(fallback);
    expect(output).toBe('DISCORD_BOT_TOKEN="${DISC…890}"');
  });

  it("does not bypass explicit user redaction patterns for shell references", () => {
    const output = redactSensitiveText("FOO_TOKEN=$FOO_TOKEN", {
      mode: "tools",
      patterns: [String.raw`/FOO_TOKEN=(\$FOO_TOKEN)/g`],
    });
    expect(output).toBe("FOO_TOKEN=***");
  });

  it("masks JSON-escaped quoted env assignments while keeping the key", () => {
    const xai = "issue85049-xai-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const brave = "issue85049-brave-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const input = String.raw`raw_params={"command":"export XAI_API_KEY=\"${xai}\" && export BRAVE_API_KEY=\\\"${brave}\\\" && echo blocked"}`;
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toContain("XAI_API_KEY=");
    expect(output).toContain("BRAVE_API_KEY=");
    expect(output).not.toContain(xai);
    expect(output).not.toContain(brave);
    expect(output).toContain("issue8…7890");
  });

  it("masks CLI flags", () => {
    const input = "curl --token abcdef1234567890ghij https://api.test";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("curl --token abcdef…ghij https://api.test");
  });

  it("masks hook token CLI flags", () => {
    const input = "gog gmail watch serve --hook-token abcdef1234567890ghij";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("gog gmail watch serve --hook-token abcdef…ghij");
  });

  it("does not treat option-alternative prose as a CLI flag secret", () => {
    const input = "Use either --password or --password-file.";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(input);
  });

  it("masks sensitive URL query parameters", () => {
    const input = "connect https://user.example/sync?access_token=abcdef1234567890ghij&safe=value";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("connect https://user.example/sync?access_token=abcdef…ghij&safe=value");
  });

  it("masks short URL query tokens fully", () => {
    const input = "cdp=https://browserless.example.com/?token=supersecret123";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("cdp=https://browserless.example.com/?token=***");
  });

  it("masks standalone lowercase token assignments in diagnostic output", () => {
    const input = "matrix access_token=abcdef1234567890ghij next";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("matrix access_token=abcdef…ghij next");
  });

  it("masks JSON fields", () => {
    const input = '{"token":"abcdef1234567890ghij"}';
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe('{"token":"abcdef…ghij"}');
  });

  it("masks payment credential JSON fields without redacting unrelated amounts", () => {
    const input =
      '{"card_number":"4242424242424242","cvc":"123","sharedPaymentToken":"spt_abcdefghijklmnopqrstuvwxyz","payment_credential":"paycred_abcdefghijklmnopqrstuvwxyz","amount":"4200"}';
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      '{"card_number":"***","cvc":"***","sharedPaymentToken":"spt_ab…wxyz","payment_credential":"paycre…wxyz","amount":"4200"}',
    );
  });

  it("masks HTTP client config secrets in JSON and object-inspection fields", () => {
    const appSecret = "feishu_app_secret_1234567890";
    const clientSecret = "oauth_client_secret_1234567890";
    const credential = "opaque_credential_1234567890";
    const input = [
      `body: {"app_secret":"${appSecret}"}`,
      `config: { appSecret: '${appSecret}', client_secret: '${clientSecret}' }`,
      `payload: {"credential":"${credential}"}`,
      `details: { credential: '${credential}' }`,
    ].join("\n");
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toContain('"app_secret":"feishu…7890"');
    expect(output).toContain("appSecret: 'feishu…7890'");
    expect(output).toContain("client_secret: 'oauth_…7890'");
    expect(output).toContain('"credential":"***"');
    expect(output).toContain("credential: 'opaque…7890'");
    expect(output).not.toContain(appSecret);
    expect(output).not.toContain(clientSecret);
    expect(output).not.toContain(credential);
  });

  it("masks payment credential assignments and flags", () => {
    const input = [
      "LINK_CARD_NUMBER=4242424242424242",
      "LINK_CVC=123",
      "shared_payment_token=spt_abcdefghijklmnopqrstuvwxyz",
      "--payment-credential paycred_abcdefghijklmnopqrstuvwxyz",
      "--card-number 4000056655665556",
    ].join(" ");
    const output = redactSensitiveText(input, { mode: "tools" });
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
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toContain("authorization: '***'");
    expect(output).toContain("cookie: 'sessio…3456'");
    expect(output).not.toContain(bearer);
    expect(output).not.toContain(cookie);
  });

  it("masks payment credential URL query parameters", () => {
    const input =
      "POST /authorize?shared_payment_token=spt_abcdefghijklmnopqrstuvwxyz&card_number=4242424242424242&amount=4200";
    const output = redactSensitiveText(input, { mode: "tools" });
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

  it("masks structured uppercase env-style field values by key", () => {
    expect(redactSensitiveFieldValue("GITHUB_TOKEN", "abcdefghijklmnopqrstuvwx1234567890")).toBe(
      "abcdef…7890",
    );
    expect(redactSensitiveFieldValue("github_token", "abcdefghijklmnopqrstuvwx1234567890")).toBe(
      "abcdef…7890",
    );
    expect(redactSensitiveFieldValue("openai_api_key", "abcdefghijklmnopqrstuvwx1234567890")).toBe(
      "abcdef…7890",
    );
    expect(redactSensitiveFieldValue("DISCORD_BOT_TOKEN", "${DISCORD_BOT_TOKEN:-}")).toBe(
      "${DISCORD_BOT_TOKEN:-}",
    );
    expect(redactSensitiveFieldValue("apiKey", "${OPENAI_API_KEY:-}")).toBe("${OPEN…Y:-}");
    expect(redactSensitiveFieldValue("password", "$SUPERSECRET123")).toBe("***");
    expect(redactSensitiveFieldValue("apiKey", "${SECRET_TOKEN}")).toBe("***");
    expect(
      redactSensitiveFieldValue(
        "DISCORD_BOT_TOKEN",
        "${DISCORD_BOT_TOKEN:-discordliteral1234567890}",
      ),
    ).toBe("${DISCORD_BOT_TOKEN:-disco…890}");
    expect(redactSensitiveFieldValue("MONKEY", "banana")).toBe("banana");
  });

  it("keeps Unicode token hints on valid UTF-16 boundaries", () => {
    const cases = [
      {
        secret: `abcde😀${"x".repeat(9)}wxyz`,
        expected: "abcde…wxyz",
      },
      {
        secret: `abcdef${"x".repeat(9)}😀abc`,
        expected: "abcdef…abc",
      },
      {
        secret: `abcd😀${"x".repeat(9)}😀ab`,
        expected: "abcd😀…😀ab",
      },
    ];

    for (const { secret, expected } of cases) {
      const redacted = redactSensitiveFieldValue("token", secret);
      expect(redacted).toBe(expected);
      expect(redacted).not.toMatch(/[\uD800-\uDFFF]/u);
    }
  });

  it("masks bearer tokens", () => {
    const input = "Authorization: Bearer abcdef1234567890ghij";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("Authorization: Bearer abcdef…ghij");
  });

  it("masks Basic authorization header tokens", () => {
    const secret = "c2VjcmV0OnBhc3M=";
    const output = redactSensitiveText(`Authorization: Basic ${secret}`, { mode: "tools" });

    expect(output).toBe("Authorization: Basic ***");
    expect(output).not.toContain(secret);
  });

  it("masks Bot authorization header tokens", () => {
    const secret = `${"A".repeat(24)}.${"B".repeat(6)}.${"C".repeat(27)}`;
    const output = redactSensitiveText(`Authorization: Bot ${secret}`, { mode: "tools" });

    expect(output).toBe("Authorization: Bot AAAAAA…CCCC");
    expect(output).not.toContain(secret);
  });

  it("masks named Gateway security headers", () => {
    const openClawToken = "supersecretgatewaytoken1234567890";
    const pomeriumJwt = "eyJheaderabcd.eyJpayloadabcd.signatureabcd123456";
    const apiKey = "shortsecret";
    const input = [
      `X-OpenClaw-Token: ${openClawToken}`,
      `x-pomerium-jwt-assertion: ${pomeriumJwt}`,
      `X-Api-Key=${apiKey}`,
    ].join("\n");
    const output = redactSensitiveText(input, { mode: "tools" });

    expect(output).toContain("X-OpenClaw-Token: supers…7890");
    expect(output).toContain("x-pomerium-jwt-assertion: eyJhea…3456");
    expect(output).toContain("X-Api-Key=***");
    expect(output).not.toContain(openClawToken);
    expect(output).not.toContain(pomeriumJwt);
    expect(output).not.toContain(apiKey);
  });

  it("masks token prefixes embedded after adjacent text", () => {
    const token = `ghp_${"a".repeat(5_000)}`;
    const output = redactSensitiveText(`prefix-${token} suffix`, { mode: "tools" });
    expect(output).toBe("prefix-ghp_aa…aaaa suffix");
    expect(output).not.toContain(token);
    expect(output).not.toContain("a".repeat(100));
  });

  it("masks URL query tokens", () => {
    const input = "GET /_matrix/client/v3/sync?access_token=abcdef1234567890ghij";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("GET /_matrix/client/v3/sync?access_token=abcdef…ghij");
  });

  it("masks bot-style tokens", () => {
    const input = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("123456…cdef");
  });

  it("masks bot API URL tokens", () => {
    const input =
      "GET https://api.example.test/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef/getMe HTTP/1.1";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("GET https://api.example.test/bot123456…cdef/getMe HTTP/1.1");
  });

  it("redacts short tokens fully", () => {
    const input = "TOKEN=shortvalue";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("TOKEN=***");
  });

  it("does not redact lowercase key diagnostics", () => {
    const input = 'agents.defaults: Unrecognized key: "llm"';
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(input);
  });

  it("does not redact diagnostic code assignments outside URL or form bodies", () => {
    const input = "Oops: failed: code=E1 status=500";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(input);
  });

  it("masks standalone pass assignments", () => {
    const output = redactSensitiveText("db pass=opaque-pass-secret-1234567890 next", {
      mode: "tools",
    });
    expect(output).toBe("db pass=opaque…7890 next");
    expect(output).not.toContain("opaque-pass-secret-1234567890");
  });

  it("masks complete unquoted assignment values that contain delimiter-like punctuation", () => {
    const input = "password=abc,def token=abc;def client_secret=abc]def pass=abc)def";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("password=*** token=*** client_secret=*** pass=***");
    expect(output).not.toContain("abc,def");
    expect(output).not.toContain("abc;def");
    expect(output).not.toContain("abc]def");
    expect(output).not.toContain("abc)def");
  });

  it("masks quoted standalone assignments", () => {
    const input = "password='abc;def' token=\"abc;def\" secret=`abc;def`";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("password='***' token=\"***\" secret=`***`");
    expect(output).not.toContain("abc;def");
  });

  it("masks sensitive URL query params while preserving non-sensitive params", () => {
    const input = "GET /_matrix/client/v3/sync?access_token=abcdef1234567890ghij&since=123";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("GET /_matrix/client/v3/sync?access_token=abcdef…ghij&since=123");
  });

  it("treats sensitive URL query param names case-insensitively", () => {
    const input = "connect https://gateway.example/ws?Access-Token=short-token&ok=1";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("connect https://gateway.example/ws?Access-Token=***&ok=1");
  });

  it("masks opaque sensitive URL query params without known token prefixes", () => {
    const input =
      "callback https://example.test/oauth?code=oauth-code-abc123&state=visible&x-amz-signature=abc123xyz&x-amz-security-token=aws-session-token-123&authorization=authz-secret-123&private_key=pk-secret-123&app_secret=app-secret-123&credential=credential-secret-123";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      "callback https://example.test/oauth?code=***&state=visible&x-amz-signature=***&x-amz-security-token=aws-se…-123&authorization=***&private_key=***&app_secret=***&credential=creden…-123",
    );
  });

  it("masks URL userinfo and database connection-string passwords", () => {
    const input = [
      "https://browser-user:browser-password-1234567890@api.example.test/v1",
      "https://:empty-username-password-1234567890@api.example.test/v1",
      "https://same:same@example.test/v1",
      "postgres://dbuser:database-password-1234567890@db.example.test/openclaw",
      "postgres://secret:secret@db.example.test/openclaw",
      "mongodb+srv://mongo:mongodb-password-1234567890@cluster.example.test/app",
      "redis://:redis-password-1234567890@cache.example.test/0",
      "rediss://cache:redis-tls-password-1234567890@cache.example.test/0",
    ].join(" ");
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).not.toContain("browser-password-1234567890");
    expect(output).not.toContain("empty-username-password-1234567890");
    expect(output).not.toContain("database-password-1234567890");
    expect(output).not.toContain("mongodb-password-1234567890");
    expect(output).not.toContain("redis-password-1234567890");
    expect(output).not.toContain("redis-tls-password-1234567890");
    expect(output).toContain("https://browser-user:browse…7890@api.example.test/v1");
    expect(output).toContain("https://:empty-…7890@api.example.test/v1");
    expect(output).toContain("https://same:***@example.test/v1");
    expect(output).toContain("postgres://dbuser:databa…7890@db.example.test/openclaw");
    expect(output).toContain("postgres://secret:***@db.example.test/openclaw");
    expect(output).toContain("mongodb+srv://mongo:mongod…7890@cluster.example.test/app");
    expect(output).toContain("redis://:redis-…7890@cache.example.test/0");
    expect(output).toContain("rediss://cache:redis-…7890@cache.example.test/0");
  });

  it("masks sensitive form-urlencoded body fields by exact key", () => {
    const input =
      "code=oauth-code-123&hook_token=hook-token-123&jwt=jwt-secret-123&pass=form-pass-123&client_secret=oauth-client-secret-1234567890&refresh_token=refresh-token-1234567890&token_count=42&session_id=session-visible";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      "code=***&hook_token=***&jwt=***&pass=***&client_secret=***&refresh_token=***&token_count=42&session_id=session-visible",
    );
    expect(output).not.toContain("oauth-code-123");
    expect(output).not.toContain("hook-token-123");
    expect(output).not.toContain("jwt-secret-123");
    expect(output).not.toContain("form-pass-123");
    expect(output).not.toContain("oauth-client-secret-1234567890");
    expect(output).not.toContain("refresh-token-1234567890");
  });

  it("masks non-auth form body secret fields after a safe first key", () => {
    const input =
      "client_id=visible&app_secret=opaque-app-secret&credential=opaque-credential&shared_payment_token=spt_abcdefghijklmnopqrstuvwxyz&safe=value";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      "client_id=visible&app_secret=***&credential=***&shared_payment_token=***&safe=value",
    );
    expect(output).not.toContain("opaque-app-secret");
    expect(output).not.toContain("opaque-credential");
    expect(output).not.toContain("spt_abcdefghijklmnopqrstuvwxyz");
  });

  it("masks form body secret fields embedded in diagnostic prose", () => {
    const input =
      "body: client_id=visible&app_secret=opaque-app-secret&credential=opaque-credential&safe=value";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("body: client_id=visible&app_secret=***&credential=***&safe=value");
    expect(output).not.toContain("opaque-app-secret");
    expect(output).not.toContain("opaque-credential");
  });

  it("masks form body secret fields in multiline tool output", () => {
    const input =
      "request start\nbody: client_id=visible&app_secret=opaque-app-secret&safe=value\nrequest end";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      "request start\nbody: client_id=visible&app_secret=***&safe=value\nrequest end",
    );
    expect(output).not.toContain("opaque-app-secret");
  });

  it("masks percent-encoded form body secret keys", () => {
    const input = "body: client%5Fsecret=oauth-secret&app%2Dsecret=app-secret&safe=value";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("body: client%5Fsecret=***&app%2Dsecret=***&safe=value");
    expect(output).not.toContain("oauth-secret");
    expect(output).not.toContain("app-secret");
  });

  it("masks quoted form body secret fields embedded in diagnostic prose", () => {
    const input =
      'body: "client_secret=oauth-secret&safe=value" fallback: `safe=value&app_secret=app-secret`';
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      'body: "client_secret=***&safe=value" fallback: `safe=value&app_secret=***`',
    );
    expect(output).not.toContain("oauth-secret");
    expect(output).not.toContain("app-secret");
  });

  it("masks percent-encoded form body keys spliced with invisible characters", () => {
    const input = "body: client%5Fse\u200Bcret=oauth-secret&safe=value";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("body: client%5Fse\u200Bcret=***&safe=value");
    expect(output).not.toContain("oauth-secret");
  });

  it("masks form body keys with leading invisible separators", () => {
    const input = "body: \u200Bclient_secret=oauth-secret&safe=value";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("body: \u200Bclient_secret=***&safe=value");
    expect(output).not.toContain("oauth-secret");
  });

  it("masks form body keys with plus-encoded separators", () => {
    const input = "body: client_se+cret=oauth-secret&safe=value";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("body: client_se+cret=***&safe=value");
    expect(output).not.toContain("oauth-secret");
  });

  it("masks form and query keys with raw control separators", () => {
    const input =
      "body: client_se\u0000cret=oauth-secret&safe=value GET /cb?client_se\u0001cret=query-secret&safe=1";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      "body: client_se\u0000cret=***&safe=value GET /cb?client_se\u0001cret=***&safe=1",
    );
    expect(output).not.toContain("oauth-secret");
    expect(output).not.toContain("query-secret");
  });

  it("masks quoted form body values after equals", () => {
    const input =
      'body: password="opaque-password-secret" client_id=visible&app_secret="opaque-app-secret"&safe=1';
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("body: password=*** client_id=visible&app_secret=***&safe=1");
    expect(output).not.toContain("opaque-password-secret");
    expect(output).not.toContain("opaque-app-secret");
  });

  it("masks form body keys with percent-encoded invisible separators", () => {
    const input = "body: client%5Fse%E2%80%8Bcret=oauth-secret&safe=value";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("body: client%5Fse%E2%80%8Bcret=***&safe=value");
    expect(output).not.toContain("oauth-secret");
  });

  it("masks form body keys with percent-encoded whitespace and control separators", () => {
    const input =
      "body: client%5Fse%20cret=space-secret&safe=value next: client%5Fse%00cret=nul-secret&safe=value";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      "body: client%5Fse%20cret=***&safe=value next: client%5Fse%00cret=***&safe=value",
    );
    expect(output).not.toContain("space-secret");
    expect(output).not.toContain("nul-secret");
  });

  it("masks URL query keys with percent-encoded invisible separators", () => {
    const input = "GET https://example.test/cb?client%5Fse%E2%80%8Bcret=oauth-secret&safe=1";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("GET https://example.test/cb?client%5Fse%E2%80%8Bcret=***&safe=1");
    expect(output).not.toContain("oauth-secret");
  });

  it("masks URL query keys with plus-encoded separators", () => {
    const input = "GET https://example.test/cb?client_se+cret=oauth-secret&safe=1";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("GET https://example.test/cb?client_se+cret=***&safe=1");
    expect(output).not.toContain("oauth-secret");
  });

  it("masks URL query keys with percent-encoded whitespace and control separators", () => {
    const input =
      "GET https://example.test/cb?client%5Fse%20cret=space-secret&safe=1&client%5Fse%00cret=nul-secret";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      "GET https://example.test/cb?client%5Fse%20cret=***&safe=1&client%5Fse%00cret=***",
    );
    expect(output).not.toContain("space-secret");
    expect(output).not.toContain("nul-secret");
  });

  it("masks encoded sensitive URL query keys after later separators", () => {
    const input = "GET https://example.test/cb?scope=read,write&client%5Fsecret=oauth-secret";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("GET https://example.test/cb?scope=read,write&client%5Fsecret=***");
    expect(output).not.toContain("oauth-secret");
  });

  it("masks complete encoded URL query values that contain commas", () => {
    const input = "GET https://example.test/cb?client%5Fsecret=abc,def&safe=1";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("GET https://example.test/cb?client%5Fsecret=***&safe=1");
    expect(output).not.toContain("abc,def");
    expect(output).not.toContain(",def");
  });

  it("masks complete URL query values that contain delimiter-like punctuation", () => {
    const input =
      "GET /cb?token=abc)def&safe=1 /cb?client%5Fsecret=abc]def&safe=1 /cb?code=short#frag";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(
      "GET /cb?token=***&safe=1 /cb?client%5Fsecret=***&safe=1 /cb?code=***#frag",
    );
    expect(output).not.toContain("abc)def");
    expect(output).not.toContain("abc]def");
    expect(output).toContain("#frag");
  });

  it("masks quoted URL query values after equals", () => {
    const input = 'GET /cb?token="opaque-token-secret"&safe=1 /cb?client%5Fsecret="oauth-secret"';
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("GET /cb?token=opaque…cret&safe=1 /cb?client%5Fsecret=***");
    expect(output).not.toContain("opaque-token-secret");
    expect(output).not.toContain("oauth-secret");
  });

  it("masks complete encoded form values that contain commas", () => {
    const input = "body: client%5Fsecret=abc,def&safe=value";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("body: client%5Fsecret=***&safe=value");
    expect(output).not.toContain("abc,def");
    expect(output).not.toContain(",def");
  });

  it("masks complete form values that contain delimiter-like punctuation", () => {
    const input = "body: client_secret=abc)def&safe=1 next: client%5Fsecret=abc]def&safe=1";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("body: client_secret=***&safe=1 next: client%5Fsecret=***&safe=1");
    expect(output).not.toContain("abc)def");
    expect(output).not.toContain("abc]def");
  });

  it("masks encoded sensitive form keys in single-pair and multiline diagnostics", () => {
    const input = [
      "client%5Fsecret=single-secret",
      "trace body: client%5Fsecret=multiline-secret&safe=1",
    ].join("\n");
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("client%5Fsecret=***\ntrace body: client%5Fsecret=***&safe=1");
    expect(output).not.toContain("single-secret");
    expect(output).not.toContain("multiline-secret");
  });

  it("masks single-pair form fields in explicit body contexts", () => {
    const input = "body: code=oauth-code-123 form_body=signature=aws-signature-123 Oops code=E1";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("body: code=*** form_body=signature=*** Oops code=E1");
    expect(output).not.toContain("oauth-code-123");
    expect(output).not.toContain("aws-signature-123");
  });

  it("masks entire-line explicit body wrapper form payloads", () => {
    const output = redactSensitiveText("body=client_secret=oauth-secret&safe=1", { mode: "tools" });
    expect(output).toBe("body=client_secret=***&safe=1");
    expect(output).not.toContain("oauth-secret");

    const outputWithLaterSecret = redactSensitiveText(
      "form_body=client_secret=oauth-secret&app_secret=app-secret",
      { mode: "tools" },
    );
    expect(outputWithLaterSecret).toBe("form_body=client_secret=***&app_secret=***");
    expect(outputWithLaterSecret).not.toContain("oauth-secret");
    expect(outputWithLaterSecret).not.toContain("app-secret");
  });

  it("masks first-position form-urlencoded fields embedded in larger log lines", () => {
    const input = "manual callback code=oauth-code-123&state=visible";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("manual callback code=***&state=visible");
    expect(output).not.toContain("oauth-code-123");
  });

  it("does not apply built-in form-body redaction when custom patterns override defaults", () => {
    const input = "password=value&safe=1";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: [String.raw`custom-secret-([A-Za-z0-9]+)`],
    });
    expect(output).toBe(input);
  });

  it("redacts private key blocks", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "ABCDEF1234567890",
      "ZYXWVUT987654321",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const output = redactSensitiveText(input, { mode: "tools" });
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

  it("keeps single-capture custom patterns focused on the captured occurrence", () => {
    const input = "password=abc123456789012345&confirm=abc123456789012345";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: [String.raw`password=([^&]+)&confirm=\1`],
    });
    expect(output).toBe("password=abc123…2345&confirm=abc123456789012345");
  });

  it("masks captured custom-pattern values even when the value repeats later", () => {
    const input = "password=abc123456789012345&confirm=abc123456789012345";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: [String.raw`password=([^&]+)&confirm=[^&]+`],
    });
    expect(output).toBe("password=abc123…2345&confirm=abc123456789012345");
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
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toContain("OPENAI_API_KEY=sk-123…cdef");
  });

  it("masks Tencent Cloud SecretId (AKID prefix, uppercase-only)", () => {
    const input = "SecretId is AKIDZ8EXAMPLEFAKE01KEY99TEST";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("SecretId is AKIDZ8…TEST");
  });

  it("masks Tencent Cloud SecretId with mixed-case characters", () => {
    const input = "AKIDz8exampleFake01Key99Test";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("AKIDz8…Test");
  });

  it("masks Alibaba Cloud AccessKey ID (LTAI prefix)", () => {
    const input = "AccessKeyId=LTAI5tExampleFakeKeyXyz9";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("AccessKeyId=LTAI5t…Xyz9");
  });

  it("masks HuggingFace tokens (hf_ prefix)", () => {
    const input = "hf_ABCDEFghijklmnopqrstuv";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("hf_ABC…stuv");
  });

  it("masks Replicate tokens (r8_ prefix)", () => {
    const input = "r8_ABCDEFghijklmnopqrstuv";
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe("r8_ABC…stuv");
  });

  it("masks expanded vendor-prefix token corpus", () => {
    const fireworksTokens = [
      { token: `fw-${"C".repeat(40)}`, redacted: "fw-CCC…CCCC" },
      { token: `fw_${"A".repeat(40)}`, redacted: "fw_AAA…AAAA" },
      { token: `fpk_${"B".repeat(40)}`, redacted: "fpk_BB…BBBB" },
    ];
    const tokens = [
      "sk-ant-abcdefghijklmnopqrstuvwxyz",
      "gho_abcdefghijklmnopqrstuvwxyz",
      "ghu_abcdefghijklmnopqrstuvwxyz",
      "ghs_abcdefghijklmnopqrstuvwxyz",
      "ghr_abcdefghijklmnopqrstuvwxyz",
      "glpat-abcdefghijklmnopqrstuvwxyz12.ab.abcdefghi",
      `gloas-${"a".repeat(64)}`,
      ["xoxb", "1234567890", "abcdefghijklmnopqrstuvwxyz"].join("-"),
      "https://hooks.slack.com/services/T1234567890/B1234567890/abcdefghijklmnopqrstuvwxy",
      "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef",
      `discord bot token ${"A".repeat(24)}.${"B".repeat(6)}.${"C".repeat(27)}`,
      "AIzaabcdefghijklmnopqrstuvwxyzABCDE",
      "pplx-abcdefghijklmnopqrstuvwxyz",
      "fal_abcdefghijklmnopqrstuvwxyz",
      "fc-abcdefghijklmnopqrstuvwxyz",
      "bb_live_abcdefghijklmnopqrstuvwxyz",
      "gAAAAabcdefghijklmnopqrstuvwxyz123456",
      "AKIAABCDEFGHIJKLMNOP",
      "ASIAABCDEFGHIJKLMNOP",
      "api_org_abcdefghijklmnopqrstuvwxyz12345678",
      ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_"),
      ["sk", "test", "abcdefghijklmnopqrstuvwxyz"].join("_"),
      ["rk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_"),
      "SG.abcdefghijklmnopqrstuvwxyz.0123456789abcdefghijklmnopqrstuvwxyz",
      "npm_abcdefghijklmnopqrstuvwxyz",
      "pypi-abcdefghijklmnopqrstuvwxyz",
      "dop_v1_abcdefghijklmnopqrstuvwxyz",
      "doo_v1_abcdefghijklmnopqrstuvwxyz",
      "dor_v1_abcdefghijklmnopqrstuvwxyz",
      `dp.pt.${"A".repeat(43)}`,
      `dckr_pat_${"A".repeat(27)}`,
      `dckr_oat_${"B".repeat(32)}`,
      `bkua_${"a".repeat(40)}`,
      `CCIPAT_${"A".repeat(22)}_${"a".repeat(40)}`,
      `sbp_${"a".repeat(40)}`,
      `dapi${"a".repeat(32)}-1`,
      `ddp_${"A".repeat(36)}`,
      `glsa_${"A".repeat(41)}`,
      `glc_eyJ${"A".repeat(80)}`,
      `nfp_${"A".repeat(36)}`,
      `CFPAT-${"A".repeat(43)}`,
      `ATCTT3xFfG${"A".repeat(48)}=ABCDEF12`,
      `ATATT${"A".repeat(48)}=ABCDEF12`,
      `ATBB${"A".repeat(24)}`,
      `BBDC-${"A".repeat(42)}`,
      `HRKU-AA${"A".repeat(58)}`,
      ["pat", "na1", "12345678", "1234", "1234", "1234", "123456789abc"].join("-"),
      `apify_api_${"A".repeat(36)}`,
      `FlyV1 fm123_${"A".repeat(120)}`,
      `fio-u-${"A".repeat(64)}`,
      "am_abcdefghijklmnopqrstuvwxyz",
      "sk_abcdefghijklmnopqrstuvwxyz",
      "tvly-abcdefghijklmnopqrstuvwxyz",
      "exa_abcdefghijklmnopqrstuvwxyz",
      "gsk_abcdefghijklmnopqrstuvwxyz",
      "syt_abcdefghijklmnopqrstuvwxyz",
      "retaindb_abcdefghijklmnopqrstuvwxyz",
      "hsk-abcdefghijklmnopqrstuvwxyz",
      "mem0_abcdefghijklmnopqrstuvwxyz",
      "brv_abcdefghijklmnopqrstuvwxyz",
      "xai-abcdefghijklmnopqrstuvwxyzABCDE",
      ...fireworksTokens.map(({ token }) => token),
    ];
    // Redact each fixture alone so every vendor pattern proves it stays reachable through
    // DEFAULT_REDACT_PREFILTER_RE; a joined corpus would let one trigger unlock all others.
    for (const token of tokens) {
      expect(redactSensitiveText(token, { mode: "tools" }), token).not.toContain(token);
    }
    expect(redactSensitiveText("AKIAABCDEFGHIJKLMNOP", { mode: "tools" })).toBe("AKIAAB…MNOP");
    expect(
      redactSensitiveText(["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_"), {
        mode: "tools",
      }),
    ).toBe("sk_liv…wxyz");
    expect(
      redactSensitiveText("SG.abcdefghijklmnopqrstuvwxyz.0123456789abcdefghijklmnopqrstuvwxyz", {
        mode: "tools",
      }),
    ).toBe("SG.abc…wxyz");
    expect(redactSensitiveText("xai-abcdefghijklmnopqrstuvwxyzABCDE", { mode: "tools" })).toBe(
      "xai-ab…BCDE",
    );
    for (const { token, redacted } of fireworksTokens) {
      expect(redactSensitiveText(token, { mode: "tools" })).toBe(redacted);
      expect(redactSensitiveText(redacted, { mode: "tools" })).toBe(redacted);
    }
  });

  it("does not redact ordinary identifiers containing short token-prefix substrings", () => {
    const input = [
      "npm_telegram_package_spec ask_openclaw_query_patterns team_management risk_assessment glpat-docs dapi-example sbp_short nfp_site CCIPAT_docs ATATT-example fw-tooshort fw_tooshort fpk_tooshort",
      `fixturefw-${"C".repeat(40)}`,
      `fixture_fw_${"A".repeat(40)}`,
      `fixture_fpk_${"B".repeat(40)}`,
    ].join(" ");
    const output = redactSensitiveText(input, { mode: "tools" });
    expect(output).toBe(input);
  });

  it("masks Fireworks tokens that cross bounded-replacement chunk boundaries", () => {
    const chunkSize = 16_384;
    const prefix = `${"x".repeat(chunkSize - 2)} `;
    const suffix = "y".repeat(chunkSize);
    const tokens = [`fw-${"C".repeat(40)}`, `fw_${"A".repeat(40)}`, `fpk_${"B".repeat(40)}`];

    for (const token of tokens) {
      expect(redactSensitiveText(`${prefix}${token}${suffix}`, { mode: "tools" })).not.toContain(
        token,
      );
    }
  });

  it("masks Telegram bot tokens that cross bounded-replacement chunk boundaries", () => {
    const chunkSize = 16_384;
    const credential = `123456:${"A".repeat(28)}WXYZ`;
    const cases = [
      { token: `bot${credential}`, redacted: "bot123456…WXYZ" },
      { token: credential, redacted: "123456…WXYZ" },
    ];

    for (const { token, redacted } of cases) {
      const tokenStart = chunkSize - 12;
      const prefix = `${"x".repeat(tokenStart - 1)} `;
      const suffix = ` ${"y".repeat(chunkSize * 2)}`;
      expect(redactSensitiveText(`${prefix}${token}${suffix}`, { mode: "tools" })).toBe(
        `${prefix}${redacted}${suffix}`,
      );
    }
  });

  it("does not corrupt base64 blobs that embed token-prefix shapes", () => {
    // Tiny-PNG base64 contains a gAAAA run from zero-filled IHDR bytes; pure-base64-alphabet
    // prefixes must not fire mid-blob or media payloads get mangled.
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
    expect(redactSensitiveText(dataUrl, { mode: "tools" })).toBe(dataUrl);
    const blobWithUppercaseRun = `blob: ${"x".repeat(4)}AKIAABCDEFGHIJKLMNOPqrstuv`;
    expect(redactSensitiveText(blobWithUppercaseRun, { mode: "tools" })).toBe(blobWithUppercaseRun);
    const dataUrlWithPlusBoundary = `data:application/octet-stream;base64,AAAA+gAAAA${"B".repeat(24)}`;
    expect(redactSensitiveText(dataUrlWithPlusBoundary, { mode: "tools" })).toBe(
      dataUrlWithPlusBoundary,
    );
    expect(redactSensitiveText("aws AKIA_ID=AKIAABCDEFGHIJKLMNOP", { mode: "tools" })).toBe(
      "aws AKIA_ID=AKIAAB…MNOP",
    );
  });

  it("does not corrupt large data URLs across chunked replacement boundaries", () => {
    // replacePatternBounded slices 32 KiB+ inputs into 16 KiB chunks; a chunk start must not
    // satisfy the pure-base64 prefix boundary (`^`) or hide the `;base64,` container from its
    // lookbehind, so the boundary patterns run unchunked.
    const prefix = "data:application/octet-stream;base64,";
    const chunkSize = 16_384;
    const pad = "A".repeat(chunkSize * 2 - prefix.length);
    const dataUrl = `${prefix}${pad}gAAAA${"B".repeat(24)}${"C".repeat(chunkSize)}`;
    expect(redactSensitiveText(dataUrl, { mode: "tools" })).toBe(dataUrl);
  });

  it("masks pure-base64-alphabet tokens after URL and path delimiters", () => {
    const fernet = `gAAAA${"B".repeat(24)}`;
    const reset = `https://app.example/reset/${fernet} visited`;
    const output = redactSensitiveText(reset, { mode: "tools" });
    expect(output).not.toContain(fernet);
    expect(output).toContain("https://app.example/reset/");
    const s3Path = "fetch /buckets/AKIAABCDEFGHIJKLMNOP/objects";
    expect(redactSensitiveText(s3Path, { mode: "tools" })).toBe(
      "fetch /buckets/AKIAAB…MNOP/objects",
    );
  });

  it("masks bare sensitive query and form keys through the default options path", () => {
    expect(
      redactSensitiveText("GET https://example.test/oauth?code=opaque-grant-123", {
        mode: "tools",
      }),
    ).toBe("GET https://example.test/oauth?code=***");
    expect(redactSensitiveText("jwt=opaque.jwt.value&safe=1", { mode: "tools" })).toBe(
      "jwt=***&safe=1",
    );
    expect(redactSensitiveText("db pass=opaquepass123 next", { mode: "tools" })).toBe(
      "db pass=*** next",
    );
  });

  it("masks obfuscated form keys with opaque values through the default options path", () => {
    // Values intentionally avoid literal prefilter trigger words so the obfuscated key alone
    // must make the default fast path run.
    expect(
      redactSensitiveText("body: client%5Fse\u200Bcret=opaque-value-123&safe=1", {
        mode: "tools",
      }),
    ).toBe("body: client%5Fse\u200Bcret=***&safe=1");
    expect(
      redactSensitiveText("GET https://example.test/cb?client_se+cret=opaque-value-123&safe=1", {
        mode: "tools",
      }),
    ).toBe("GET https://example.test/cb?client_se+cret=***&safe=1");
    expect(
      redactSensitiveText("body: client_secre%74=opaque-value-123&safe=1", { mode: "tools" }),
    ).toBe("body: client_secre%74=***&safe=1");
    expect(
      redactSensitiveText("body: client_se\u3164cret\u3164=opaque-value-123&safe=1", {
        mode: "tools",
      }),
    ).toBe("body: client_se\u3164cret\u3164=***&safe=1");
  });

  it("masks connection-string passwords through the default options path", () => {
    expect(
      redactSensitiveText("postgres://dbuser:opaquepw12345@db.example.test/openclaw", {
        mode: "tools",
      }),
    ).toBe("postgres://dbuser:***@db.example.test/openclaw");
  });

  it("masks quoted standalone values containing the other quote character", () => {
    const input = `password="it's-a-secret" next`;
    expect(redactSensitiveText(input, { mode: "tools" })).toBe('password="***" next');
  });

  it("masks unterminated quoted standalone values", () => {
    const input = 'token="opaque-abc123 rest';
    expect(redactSensitiveText(input, { mode: "tools" })).toBe("token=*** rest");
  });

  it("treats explicit default patterns like the built-in default path", () => {
    const input =
      'GET /cb?client_secret=oauth-secret-123&safe=1 glpat-abcdefghijklmnopqrstuv password="it\'s"';
    expect(redactSensitiveText(input, { mode: "tools", patterns: defaults })).toBe(
      redactSensitiveText(input, { mode: "tools" }),
    );
  });

  it("redacts raw secret values that contain an ellipsis", () => {
    const input = "password=abcdef…1234567890";
    const output = redactSensitiveText(input, { mode: "tools" });

    expect(output).toBe("password=***");
    expect(redactSensitiveFieldValue("password", "abcdef…1234567890")).toBe("***");
  });

  it("masks OAuth and JWT token shapes", () => {
    const input = [
      "ya29.fake-access-token-with-enough-length",
      "1//0fake-refresh-token-with-enough-length",
      "eyJheaderabcd.eyJpayloadabcd.signatureabcd123456",
    ].join(" ");
    const output = redactSensitiveText(input, { mode: "tools" });
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
    const output = redactSensitiveText(input, { mode: "tools" });
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
    const configPath = writeConfig(`{
      logging: {
        redactSensitive: "off",
      },
    }`);

    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () =>
      expect(redactSensitiveText("OPENAI_API_KEY=sk-1234567890abcdef")).toBe(
        "OPENAI_API_KEY=sk-1234567890abcdef",
      ),
    );
  });

  it("forces redaction for tool details even when log redaction is disabled", () => {
    writeConfig(`{
      logging: {
        redactSensitive: "off",
      },
    }`);

    expect(redactToolDetail("OPENAI_API_KEY=sk-1234567890abcdef")).toBe(
      "OPENAI_API_KEY=sk-123…cdef",
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
      redactFormBodies: false,
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

  it("keeps custom redaction patterns active for text outside default markers", () => {
    const output = redactSensitiveText("ticket internal-12345 should hide", {
      mode: "tools",
      patterns: [/internal-\d+/g],
    });

    expect(output).toBe("ticket *** should hide");
  });

  it("keeps configured redaction patterns active for text outside default markers", () => {
    const configPath = writeConfig(`{
      logging: {
        redactPatterns: ["/internal-\\\\d+/g"],
      },
    }`);

    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () =>
      expect(redactSensitiveText("ticket internal-12345 should hide")).toBe(
        "ticket *** should hide",
      ),
    );
  });

  it("redacts built-in query parameters after the default prefilter", () => {
    expect(redactSensitiveText("https://example.test/callback?pass=opensesamevalue")).toBe(
      "https://example.test/callback?pass=***",
    );
    expect(redactSensitiveText("https://example.test/callback?security_code=123456")).toBe(
      "https://example.test/callback?security_code=***",
    );
  });

  it("redacts standalone bearer tokens after the default prefilter", () => {
    expect(redactSensitiveText("Bearer abcdef1234567890ghij")).toBe("Bearer abcdef…ghij");
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

  it("keeps structured error codes while redacting OAuth authorization codes", () => {
    const output = redactSecrets({
      manifest: {
        sourceFiles: { session: "$WORKSPACE_DIR/session.jsonl" },
        warnings: [
          { code: "invalid-runtime-event" },
          { code: "cyclic-session-branch" },
          { code: "incomplete-session-branch" },
        ],
      },
      status: { code: "SYSTEM_RUN_DENIED" },
      invalidRequestStatus: { status: { code: "INVALID_REQUEST" } },
      details: { error: { code: "SYSTEM_RUN_DENIED" } },
      nodeError: { code: "NOT_PAIRED" },
      policyError: { error: { code: "POLICY_DENIED" } },
      invalidRequestDetails: { error: { code: "INVALID_REQUEST" } },
      error: { code: "ERR_ROOTOPAQUECODE1234567890" },
      diagnostic: { error: { code: "ERR_DIAGNOSTIC_TEST" } },
      stabilityBundle: { error: { code: "ERR_STABILITY_TEST" } },
      trajectoryExport: { error: { code: "ERR_TRAJECTORY_TEST" } },
      oauth: { code: "oauth-code-value-1234567890" },
      oauthNestedError: { error: { code: "ERR_OPAQUEOAUTHCODE1234567890" } },
      provider: { code: "provider-code-value-1234567890" },
      providerAuth: { code: "provider-auth-code-value-1234567890" },
      bearerToken: "bearer-token-value-1234567890",
      bearer_token: "bearer-token-snake-value-1234567890",
      providerDetails: { error: { code: "SYSTEM_RUN_DENIED" } },
      providerNestedError: { error: { code: "ERR_PROVIDEROPAQUECODE1234567890" } },
      numericSecrets: { cardNumber: 4111111111111111, cvc: 123, token: 1234567890, amount: 4200 },
    });

    expect(output.manifest.sourceFiles.session).toBe("$WORKSPACE_DIR/session.jsonl");
    expect(output.manifest.warnings).toEqual([
      { code: "invalid-runtime-event" },
      { code: "cyclic-session-branch" },
      { code: "incomplete-session-branch" },
    ]);
    expect(output.status.code).toBe("SYSTEM_RUN_DENIED");
    expect(output.invalidRequestStatus.status.code).toBe("INVALID_REQUEST");
    expect(output.details.error.code).toBe("SYSTEM_RUN_DENIED");
    expect(output.nodeError.code).toBe("NOT_PAIRED");
    expect(output.policyError.error.code).toBe("POLICY_DENIED");
    expect(output.invalidRequestDetails.error.code).toBe("INVALID_REQUEST");
    expect(output.error.code).toBe("ERR_ROOTOPAQUECODE1234567890");
    expect(output.diagnostic.error.code).toBe("ERR_DIAGNOSTIC_TEST");
    expect(output.stabilityBundle.error.code).toBe("ERR_STABILITY_TEST");
    expect(output.trajectoryExport.error.code).toBe("ERR_TRAJECTORY_TEST");
    expect(output.oauth.code).not.toBe("oauth-code-value-1234567890");
    expect(output.oauthNestedError.error.code).toBe("ERR_OPAQUEOAUTHCODE1234567890");
    expect(output.provider.code).not.toBe("provider-code-value-1234567890");
    expect(output.providerAuth.code).not.toBe("provider-auth-code-value-1234567890");
    expect(output.bearerToken).not.toBe("bearer-token-value-1234567890");
    expect(output.bearer_token).not.toBe("bearer-token-snake-value-1234567890");
    expect(output.providerDetails.error.code).toBe("SYSTEM_RUN_DENIED");
    expect(output.providerNestedError.error.code).toBe("ERR_PROVIDEROPAQUECODE1234567890");
    expect(output.numericSecrets).toEqual({
      cardNumber: "***",
      cvc: "***",
      token: "***",
      amount: 4200,
    });
  });
});

describe("redactSensitiveLines", () => {
  it("redacts matching content across all lines", () => {
    const resolved = resolveRedactOptions({ mode: "tools" });
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
    const resolved = { mode: "tools" as const, patterns: [], redactFormBodies: false };
    const lines = ["TOKEN=abcdef1234567890ghij"];
    expect(redactSensitiveLines(lines, resolved)).toEqual(lines);
  });

  it("returns empty array unchanged — does not produce a synthetic blank line", () => {
    const resolved = resolveRedactOptions({ mode: "tools" });
    expect(redactSensitiveLines([], resolved)).toStrictEqual([]);
  });

  it("redacts a PEM block spanning multiple lines in the array", () => {
    const resolved = resolveRedactOptions({ mode: "tools" });
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

  it("applies form-body redaction per line before joining for multiline patterns", () => {
    const resolved = resolveRedactOptions({ mode: "tools" });
    const lines = [
      "jwt=opaque-jwt-secret-123&safe=1",
      "key=opaque-key-secret-123&safe=1",
      "https://example.test/cb?client%5Fsecret=oauth-secret&safe=1",
      "normal log line",
    ];
    expect(redactSensitiveLines(lines, resolved)).toEqual([
      "jwt=***&safe=1",
      "key=***&safe=1",
      "https://example.test/cb?client%5Fsecret=***&safe=1",
      "normal log line",
    ]);
  });
});
