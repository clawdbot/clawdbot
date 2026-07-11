import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  chromeFiletimeToUnixSeconds,
  decryptChromeCookieRows,
  mapChromeSameSite,
  type ChromeCookieRow,
} from "./system-chrome-cookies.js";

const KEYCHAIN_FIXTURE = "fixture-value";

function encryptV10(value: string, host: string, withHostPrefix: boolean): Buffer {
  const key = crypto.pbkdf2Sync(KEYCHAIN_FIXTURE, "saltysalt", 1003, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const valueBytes = Buffer.from(value);
  const plain = withHostPrefix
    ? Buffer.concat([crypto.createHash("sha256").update(host).digest(), valueBytes])
    : valueBytes;
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

function row(overrides: Partial<ChromeCookieRow> = {}): ChromeCookieRow {
  return {
    host_key: ".example.com",
    top_frame_site_key: "",
    name: "session",
    value: "",
    encrypted_value: encryptV10("known-value", ".example.com", false),
    path: "/",
    expires_utc: 0,
    is_secure: 1,
    is_httponly: 1,
    has_expires: 0,
    samesite: -1,
    ...overrides,
  };
}

function secretReader() {
  return vi.fn(async () => Buffer.from(KEYCHAIN_FIXTURE));
}

describe("system Chrome cookies", () => {
  it.each([false, true])("decrypts v10 cookies (host prefix: %s)", async (withHostPrefix) => {
    const encrypted = encryptV10("round-trip", ".example.com", withHostPrefix);
    const result = await decryptChromeCookieRows({
      browser: "chrome",
      rows: [row({ encrypted_value: encrypted })],
      readSecret: secretReader(),
    });

    expect(result.cookies).toEqual([
      expect.objectContaining({ domain: ".example.com", name: "session", value: "round-trip" }),
    ]);
    expect(result.counts).toEqual({ total: 1, imported: 1, failed: 0, skipped: 0 });
  });

  it("converts FILETIME and omits expiry for session cookies", async () => {
    const unixSeconds = 1_700_000_000;
    const filetime = (unixSeconds + 11_644_473_600) * 1_000_000;
    expect(chromeFiletimeToUnixSeconds(filetime)).toBe(unixSeconds);
    expect(chromeFiletimeToUnixSeconds(BigInt(unixSeconds + 11_644_473_600) * 1_000_000n)).toBe(
      unixSeconds,
    );
    expect(chromeFiletimeToUnixSeconds(0)).toBeUndefined();
    expect(chromeFiletimeToUnixSeconds(-1)).toBeUndefined();

    const result = await decryptChromeCookieRows({
      browser: "chrome",
      rows: [row({ has_expires: 0, expires_utc: filetime })],
      readSecret: secretReader(),
    });
    expect(result.cookies[0]).not.toHaveProperty("expires");
  });

  it("maps SameSite and omits insecure None", () => {
    expect(mapChromeSameSite(2, false)).toBe("Strict");
    expect(mapChromeSameSite(1, false)).toBe("Lax");
    expect(mapChromeSameSite(0, true)).toBe("None");
    expect(mapChromeSameSite(0, false)).toBeUndefined();
    expect(mapChromeSameSite(-1, true)).toBeUndefined();
  });

  it("uses the legacy value column when encrypted_value is empty", async () => {
    const readSecret = secretReader();
    const result = await decryptChromeCookieRows({
      browser: "chrome",
      rows: [row({ value: "legacy-value", encrypted_value: Buffer.alloc(0) })],
      readSecret,
    });

    expect(result.cookies[0]?.value).toBe("legacy-value");
    expect(readSecret).toHaveBeenCalledOnce();
  });

  it("counts a failed decrypt and continues importing", async () => {
    const result = await decryptChromeCookieRows({
      browser: "chrome",
      rows: [
        row({
          name: "broken",
          encrypted_value: Buffer.concat([Buffer.from("v10"), Buffer.alloc(16)]),
        }),
        row({ name: "good", encrypted_value: encryptV10("still-imported", ".example.com", true) }),
      ],
      readSecret: secretReader(),
    });

    expect(result.cookies).toEqual([
      expect.objectContaining({ name: "good", value: "still-imported" }),
    ]);
    expect(result.counts).toEqual({ total: 2, imported: 1, failed: 1, skipped: 0 });
  });

  it("skips partitioned cookies instead of weakening their scope", async () => {
    const result = await decryptChromeCookieRows({
      browser: "chrome",
      rows: [row({ top_frame_site_key: "https://top.example" })],
      readSecret: secretReader(),
    });

    expect(result.cookies).toEqual([]);
    expect(result.counts).toEqual({ total: 1, imported: 0, failed: 0, skipped: 1 });
  });
});
