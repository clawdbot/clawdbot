import { describe, expect, it } from "vitest";
import {
  resolveTelegramRequestTimeoutMs,
  resolveTelegramStartupProbeTimeoutMs,
} from "./request-timeouts.js";

describe("resolveTelegramRequestTimeoutMs", () => {
  it("bounds Telegram startup control-plane methods", () => {
    expect(resolveTelegramRequestTimeoutMs("deletemycommands")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("deletewebhook")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("getme")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("setmycommands")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("setwebhook")).toBe(15_000);
  });

  it("keeps the longer polling timeout for getUpdates", () => {
    expect(resolveTelegramRequestTimeoutMs("getupdates")).toBe(45_000);
  });

  it("bounds outbound delivery methods", () => {
    expect(resolveTelegramRequestTimeoutMs("sendmessage")).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("sendchataction")).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("sendmessagedraft")).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("editmessagetext")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("sendphoto")).toBe(30_000);
  });

  it("honors higher configured timeoutSeconds except for long polling", () => {
    expect(resolveTelegramRequestTimeoutMs("sendmessage", 90)).toBe(90_000);
    expect(resolveTelegramRequestTimeoutMs("sendchataction", 90)).toBe(90_000);
    expect(resolveTelegramRequestTimeoutMs("editmessagetext", 90)).toBe(90_000);
    expect(resolveTelegramRequestTimeoutMs("getupdates", 90)).toBe(45_000);
  });

  it("does not let low timeoutSeconds shorten method guards", () => {
    expect(resolveTelegramRequestTimeoutMs("sendmessage", 10)).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("getme", 10)).toBe(15_000);
  });

  it("does not assign hard timeouts to unrelated Telegram methods", () => {
    expect(resolveTelegramRequestTimeoutMs("answercallbackquery")).toBeUndefined();
    expect(resolveTelegramRequestTimeoutMs(null)).toBeUndefined();
  });
});

describe("resolveTelegramStartupProbeTimeoutMs", () => {
  it("uses the getMe request guard by default", () => {
    expect(resolveTelegramStartupProbeTimeoutMs(undefined)).toBe(15_000);
  });

  it("does not let low client timeoutSeconds shorten startup getMe", () => {
    expect(resolveTelegramStartupProbeTimeoutMs(2)).toBe(15_000);
  });

  it("honors higher configured timeoutSeconds", () => {
    expect(resolveTelegramStartupProbeTimeoutMs(60)).toBe(60_000);
  });
});
