import { describe, expect, it, vi } from "vitest";
import { isTelegramEmptyContentError, withTelegramPlainFallback } from "./rich-plain-fallback.js";

const fallbackCases = [
  {
    name: "rich-entity-invalid",
    message: "Bad Request: RICH_MESSAGE_URL_INVALID",
    richTrigger: "rich-entity-invalid",
  },
  {
    name: "rich-structure-invalid",
    message: "Bad Request: RICH_MESSAGE_BLOCKS_TOO_MANY",
    richTrigger: "rich-structure-invalid",
  },
  {
    name: "rich-content-required",
    message: "Bad Request: RICH_MESSAGE_CONTENT_REQUIRED",
    richTrigger: "rich-content-required",
    htmlTrigger: "empty-content",
  },
  {
    name: "html-parse",
    message: "Bad Request: can't parse entities: unsupported tag",
    richTrigger: "html-parse",
    htmlTrigger: "html-parse",
  },
  {
    name: "empty-content",
    message: "Bad Request: message text is empty",
    htmlTrigger: "empty-content",
  },
  {
    name: "network error",
    message: "read ECONNRESET",
  },
] as const;

describe("withTelegramPlainFallback", () => {
  it.each(
    (["rich", "html"] as const).flatMap((kind) =>
      fallbackCases.map((testCase) => Object.assign({ kind }, testCase)),
    ),
  )("classifies $kind $name consistently", async (testCase) => {
    const error = new Error(testCase.message);
    const warn = vi.fn();
    const sendFormatted = vi.fn(async () => {
      throw error;
    });
    const sendPlain = vi.fn(async () => "plain");
    const trigger =
      testCase.kind === "rich"
        ? "richTrigger" in testCase
          ? testCase.richTrigger
          : undefined
        : "htmlTrigger" in testCase
          ? testCase.htmlTrigger
          : undefined;
    const run = withTelegramPlainFallback({
      kind: testCase.kind,
      context: "test send",
      plainText: "fallback body",
      warn,
      limit: 8,
      chunkCount: 3,
      sendFormatted,
      sendPlain,
    });
    expect(sendFormatted).toHaveBeenCalledTimes(1);

    if (!trigger) {
      await expect(run).rejects.toBe(error);
      expect(sendPlain).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      return;
    }

    await expect(run).resolves.toBe("plain");
    expect(sendPlain).toHaveBeenCalledWith(
      {
        plainText: "fallback body",
        chunks: ["fallb", "ack ", "body"],
      },
      "test send-plain",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      `telegram test send degrade=plain-fallback:${trigger}: ${testCase.message}`,
    );
  });

  it.each([
    { kind: "rich" as const, message: "Bad Request: RICH_MESSAGE_URL_INVALID" },
    { kind: "html" as const, message: "Bad Request: message text is empty" },
  ])("rethrows $kind failures when plain text is empty", async ({ kind, message }) => {
    const error = new Error(message);
    const warn = vi.fn();
    const sendPlain = vi.fn(async () => "plain");

    await expect(
      withTelegramPlainFallback({
        kind,
        context: "test send",
        plainText: " \n",
        warn,
        sendFormatted: async () => {
          throw error;
        },
        sendPlain,
      }),
    ).rejects.toBe(error);
    expect(sendPlain).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("isTelegramEmptyContentError", () => {
  it.each([
    "Bad Request: message text is empty",
    "Bad Request: text must be non-empty",
    "Bad Request: RICH_MESSAGE_CONTENT_REQUIRED",
  ])("recognizes %s", (message) => {
    expect(isTelegramEmptyContentError(new Error(message))).toBe(true);
  });

  it("does not hide unrelated bad requests", () => {
    expect(isTelegramEmptyContentError(new Error("Bad Request: content rejected"))).toBe(false);
  });
});
