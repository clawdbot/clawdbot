// Telegram tests cover voice plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { resolveTelegramPlainCaption, splitTelegramCaption } from "./caption.js";
import { resolveTelegramVoiceSend } from "./voice.js";

const TELEGRAM_CAPTION_LIMIT = 1024;

describe("splitTelegramCaption", () => {
  it("returns empty parts for blank captions", () => {
    expect(splitTelegramCaption("   ")).toEqual({
      caption: undefined,
      followUpText: undefined,
    });
  });

  it("keeps short captions inline", () => {
    expect(splitTelegramCaption(" hello ")).toEqual({
      caption: "hello",
      followUpText: undefined,
    });
  });

  it("moves oversized captions into follow-up text", () => {
    const text = "x".repeat(TELEGRAM_CAPTION_LIMIT + 1);
    expect(splitTelegramCaption(text)).toEqual({
      caption: undefined,
      followUpText: text,
    });
  });

  it.each([
    {
      mode: "Markdown formatting",
      text: `**${"x".repeat(TELEGRAM_CAPTION_LIMIT - 2)}**`,
      renderedHtml: `<b>${"x".repeat(TELEGRAM_CAPTION_LIMIT - 2)}</b>`,
    },
    {
      mode: "HTML formatting",
      text: `<b>${"x".repeat(TELEGRAM_CAPTION_LIMIT - 2)}</b>`,
      renderedHtml: `<b>${"x".repeat(TELEGRAM_CAPTION_LIMIT - 2)}</b>`,
    },
    {
      mode: "HTML entities and links",
      text: `&amp;<a href="https://example.com/long-path">${"x".repeat(1022)}</a>`,
      renderedHtml: `&amp;<a href="https://example.com/long-path">${"x".repeat(1022)}</a>`,
    },
  ])("budgets $mode after Telegram parses entities", ({ text, renderedHtml }) => {
    expect(splitTelegramCaption(text, renderedHtml)).toEqual({
      caption: text,
      followUpText: undefined,
    });
  });

  it("counts visible Unicode in Telegram's UTF-16 code units", () => {
    const fitting = "😀".repeat(TELEGRAM_CAPTION_LIMIT / 2);
    const overflowing = `${fitting}😀`;

    expect(splitTelegramCaption(fitting, `<b>${fitting}</b>`).caption).toBe(fitting);
    expect(splitTelegramCaption(overflowing, `<b>${overflowing}</b>`)).toEqual({
      caption: undefined,
      followUpText: overflowing,
    });
  });

  it("keeps plain caption retries within the parsed caption budget", () => {
    const visible = "x".repeat(1022);
    const markupHeavy = `**${visible}**`;

    expect(resolveTelegramPlainCaption(markupHeavy, `<b>${visible}</b>`)).toBe(visible);
    expect(resolveTelegramPlainCaption("hi **boss**", "hi <b>boss</b>")).toBe("hi **boss**");
  });
});

describe("resolveTelegramVoiceSend", () => {
  it("skips voice when wantsVoice is false", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: false,
      contentType: "audio/ogg",
      fileName: "voice.ogg",
      logFallback,
    });
    expect(result.useVoice).toBe(false);
    expect(logFallback).not.toHaveBeenCalled();
  });

  it("logs fallback for incompatible media", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: true,
      contentType: "audio/wav",
      fileName: "track.wav",
      logFallback,
    });
    expect(result.useVoice).toBe(false);
    expect(logFallback).toHaveBeenCalledWith(
      "Telegram voice requested but media is audio/wav (track.wav); sending as audio file instead.",
    );
  });

  it("keeps voice when compatible", () => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: true,
      contentType: "audio/ogg",
      fileName: "voice.ogg",
      logFallback,
    });
    expect(result.useVoice).toBe(true);
    expect(logFallback).not.toHaveBeenCalled();
  });

  it.each([
    { contentType: "audio/mpeg", fileName: "track.mp3" },
    { contentType: "audio/mp4", fileName: "track.m4a" },
  ])("keeps voice for compatible MIME $contentType", ({ contentType, fileName }) => {
    const logFallback = vi.fn();
    const result = resolveTelegramVoiceSend({
      wantsVoice: true,
      contentType,
      fileName,
      logFallback,
    });
    expect(result.useVoice).toBe(true);
    expect(logFallback).not.toHaveBeenCalled();
  });
});
