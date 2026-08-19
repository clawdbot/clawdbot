import type { ChannelMessageUnknownSendContext } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import { reconcileTelegramUnknownSend } from "./unknown-send-reconciliation.js";

function unknownSendContext(lastError?: string): ChannelMessageUnknownSendContext {
  return {
    cfg: {},
    queueId: "queue-1",
    channel: "telegram",
    to: "123456",
    enqueuedAt: 1,
    retryCount: 1,
    payloads: [{ text: "hello" }],
    ...(lastError === undefined ? {} : { lastError }),
  };
}

describe("reconcileTelegramUnknownSend", () => {
  it.each([
    ["channel no-send marker", "Telegram request not started"],
    ["connect refusal", "connect ECONNREFUSED 149.154.167.220:443"],
    ["dns not found", "getaddrinfo ENOTFOUND api.telegram.org"],
    ["dns backoff", "getaddrinfo EAI_AGAIN api.telegram.org"],
    ["connect timeout", "connect ETIMEDOUT 149.154.167.220:443"],
    ["undici connect timeout", "UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error"],
    ["tls handshake", "ERR_TLS_CERT_ALTNAME_INVALID: Hostname/IP does not match"],
    ["tls certificate", "certificate has expired"],
    ["bot api semantic 400", "Call to 'sendMessage' failed! (400: Bad Request: chat not found)"],
    ["bot api flood wait", "Call to 'sendMessage' failed! (429: Too Many Requests: retry after 5)"],
    ["bot api server error", "Call to 'sendMessage' failed! (502: Bad Gateway)"],
  ])("returns not_sent for %s evidence", (_label, lastError) => {
    expect(reconcileTelegramUnknownSend(unknownSendContext(lastError))).toEqual({
      status: "not_sent",
    });
  });

  it.each([
    ["socket reset after write", "read ECONNRESET"],
    ["socket hang up", "socket hang up"],
    ["non-connect timeout", "ETIMEDOUT"],
    ["opaque failure", "something went wrong"],
  ])("stays unresolved and non-retryable for %s", (_label, lastError) => {
    expect(reconcileTelegramUnknownSend(unknownSendContext(lastError))).toMatchObject({
      status: "unresolved",
      retryable: false,
    });
  });

  it("stays unresolved without recorded failure evidence", () => {
    expect(reconcileTelegramUnknownSend(unknownSendContext())).toMatchObject({
      status: "unresolved",
      retryable: false,
    });
  });

  it("is declared on the telegram message adapter", async () => {
    const { telegramPlugin } = await import("./channel.js");
    expect(telegramPlugin.message?.durableFinal?.capabilities?.reconcileUnknownSend).toBe(true);
    expect(telegramPlugin.message?.durableFinal?.reconcileUnknownSend).toBeTypeOf("function");
    expect(telegramPlugin.message?.durableFinal?.reconcileUnknownSendKinds).toEqual({
      text: true,
      media: true,
    });
  });
});
