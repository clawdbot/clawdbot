import { describe, expect, it } from "vitest";
import { resolveTelegramRequestTimeoutMs } from "./request-timeouts.js";

describe("resolveTelegramRequestTimeoutMs", () => {
  it("bounds Telegram startup control-plane methods", () => {
    expect(resolveTelegramRequestTimeoutMs("deletewebhook")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("getme")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("setwebhook")).toBe(15_000);
  });

  it("keeps the longer polling timeout for getUpdates", () => {
    expect(resolveTelegramRequestTimeoutMs("getupdates")).toBe(45_000);
  });

  it("does not assign hard timeouts to unrelated Telegram methods", () => {
    expect(resolveTelegramRequestTimeoutMs("sendmessage")).toBeUndefined();
    expect(resolveTelegramRequestTimeoutMs(null)).toBeUndefined();
  });
});
