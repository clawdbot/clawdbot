import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const logVerboseMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    logVerbose: logVerboseMock,
    shouldLogVerbose: () => true,
  };
});

describe("buildTelegramMessageContext verbose logs", () => {
  it("keeps inbound log previews UTF-16 well-formed at the limit", async () => {
    const cfg = {
      agents: { defaults: { envelopeTimestamp: "off" } },
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
      messages: { groupChat: { mentionPatterns: [] } },
    };
    const baseMessage = {
      chat: { id: 1234, type: "private", first_name: "Pat" },
      from: { id: 1234, first_name: "Pat" },
    };
    await buildTelegramMessageContextForTest({
      cfg,
      message: { ...baseMessage, text: "BODY_MARKER" },
    });
    const baselineLog = logVerboseMock.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith("telegram inbound:"));
    const baselinePreview = baselineLog?.match(/preview="(.*)"$/)?.[1] ?? "";
    const markerIndex = baselinePreview.indexOf("BODY_MARKER");
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const rawBody = `${"x".repeat(199 - markerIndex)}🚀tail`;
    logVerboseMock.mockClear();

    await buildTelegramMessageContextForTest({
      cfg,
      message: { ...baseMessage, text: rawBody },
    });
    const expectedPreview = `${baselinePreview.slice(0, markerIndex)}${"x".repeat(199 - markerIndex)}`;
    const formattedBodyLength = markerIndex + rawBody.length;

    expect(logVerboseMock).toHaveBeenCalledWith(
      `telegram inbound: chatId=1234 from=telegram:1234 len=${formattedBodyLength} preview="${expectedPreview}"`,
    );
  });

  it("keeps reply-context log previews UTF-16 well-formed at the limit", async () => {
    const replyBody = `${"x".repeat(119)}🚀tail`;

    await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 1234, type: "private", first_name: "Pat" },
        from: { id: 1234, first_name: "Pat" },
        text: "replying",
        reply_to_message: {
          message_id: 10,
          date: 1_700_000_000,
          chat: { id: 1234, type: "private", first_name: "Pat" },
          from: { id: 7, first_name: "Bot", username: "bot", is_bot: true },
          text: replyBody,
        },
      },
    });

    expect(logVerboseMock).toHaveBeenCalledWith(
      `telegram reply-context: replyToId=10 replyToSender=Bot replyToBody="${"x".repeat(119)}"`,
    );
  });
});
