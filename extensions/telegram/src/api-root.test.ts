import { describe, expect, it } from "vitest";
import {
  DEFAULT_TELEGRAM_API_ROOT,
  hasTelegramBotEndpointApiRoot,
  normalizeTelegramApiRoot,
} from "./api-root.js";

describe("telegram api root", () => {
  it("defaults to the public Telegram Bot API root", () => {
    expect(normalizeTelegramApiRoot()).toBe(DEFAULT_TELEGRAM_API_ROOT);
    expect(normalizeTelegramApiRoot("  ")).toBe(DEFAULT_TELEGRAM_API_ROOT);
  });

  it("keeps custom Bot API roots without a bot-token endpoint", () => {
    expect(normalizeTelegramApiRoot("https://telegram.internal:8443/custom-bot-api/")).toBe(
      "https://telegram.internal:8443/custom-bot-api",
    );
    expect(hasTelegramBotEndpointApiRoot("https://telegram.internal:8443/custom-bot-api/")).toBe(
      false,
    );
  });

  it("strips a full bot endpoint from apiRoot", () => {
    const root = "https://api.telegram.org/bot123456:ABC_def-ghi/";

    expect(hasTelegramBotEndpointApiRoot(root)).toBe(true);
    expect(normalizeTelegramApiRoot(root)).toBe("https://api.telegram.org");
  });

  it("strips only terminal bot-token endpoint segments", () => {
    expect(normalizeTelegramApiRoot("https://proxy.example.com/custom/bot123456:ABC_def")).toBe(
      "https://proxy.example.com/custom",
    );
    expect(normalizeTelegramApiRoot("https://proxy.example.com/bot123456")).toBe(
      "https://proxy.example.com/bot123456",
    );
  });
});
