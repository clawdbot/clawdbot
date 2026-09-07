import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateTelegramMiniAppInitData } from "./init-data.js";

const BOT_TOKEN = "fixture";
const AUTH_DATE = 1_800_000_000;
const INIT_DATA = signedInitData({});

describe("validateTelegramMiniAppInitData", () => {
  it("accepts a signed Telegram init-data fixture", () => {
    expect(
      validateTelegramMiniAppInitData({
        initData: INIT_DATA,
        botToken: BOT_TOKEN,
        nowMs: AUTH_DATE * 1000 + 10_000,
      }),
    ).toEqual({
      hash: fixtureHash(INIT_DATA),
      authDateMs: AUTH_DATE * 1000,
      userId: "123456",
    });
  });

  it("rejects tampered, expired, and missing-user init data", () => {
    expect(
      validateTelegramMiniAppInitData({
        initData: INIT_DATA.replace(/hash=[^&]+/, "hash=short"),
        botToken: BOT_TOKEN,
        nowMs: AUTH_DATE * 1000 + 10_000,
      }),
    ).toBeNull();
    expect(
      validateTelegramMiniAppInitData({
        initData: INIT_DATA.replace("Ayaan", "Mallory"),
        botToken: BOT_TOKEN,
        nowMs: AUTH_DATE * 1000 + 10_000,
      }),
    ).toBeNull();
    expect(
      validateTelegramMiniAppInitData({
        initData: INIT_DATA,
        botToken: BOT_TOKEN,
        nowMs: AUTH_DATE * 1000 + 301_000,
      }),
    ).toBeNull();
    expect(
      validateTelegramMiniAppInitData({
        initData: signedInitData({ user: "" }),
        botToken: BOT_TOKEN,
        nowMs: AUTH_DATE * 1000,
      }),
    ).toBeNull();
  });
});

function signedInitData(overrides: Record<string, string>): string {
  const params = new URLSearchParams({
    auth_date: String(AUTH_DATE),
    query_id: "AAE-test",
    user: JSON.stringify({ id: 123456, first_name: "Ayaan" }),
    ...overrides,
  });
  const entries = [...params.entries()].map(([key, value]) => `${key}=${value}`).toSorted();
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secret).update(entries.join("\n")).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

function fixtureHash(initData: string): string {
  const hash = new URLSearchParams(initData).get("hash");
  if (!hash) {
    throw new Error("expected fixture hash");
  }
  return hash;
}
