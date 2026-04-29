import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  sendMessageWhatsApp: vi.fn(async () => ({ messageId: "wa-1", toJid: "jid" })),
  sendPollWhatsApp: vi.fn(async () => ({ messageId: "poll-1", toJid: "jid" })),
}));

vi.mock("./send.js", () => ({
  sendMessageWhatsApp: hoisted.sendMessageWhatsApp,
  sendPollWhatsApp: hoisted.sendPollWhatsApp,
}));

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    logging: {
      shouldLogVerbose: () => false,
    },
  }),
}));

let whatsappChannelOutbound: typeof import("./channel-outbound.js").whatsappChannelOutbound;

describe("whatsappChannelOutbound", () => {
  beforeAll(async () => {
    ({ whatsappChannelOutbound } = await import("./channel-outbound.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops leading blank lines but preserves intentional indentation", () => {
    expect(
      whatsappChannelOutbound.normalizePayload?.({
        payload: { text: "\n \n    indented" },
      }),
    ).toEqual({
      text: "    indented",
    });
  });

  it("keeps XML sanitizer normalization idempotent", () => {
    const raw = [
      "<function_calls>",
      '  <invoke name="send_message">',
      '    <parameter name="text">hidden</parameter>',
      "  </invoke>",
      "</function_calls>",
      "After",
    ].join("\n");
    const once = whatsappChannelOutbound.normalizePayload?.({ payload: { text: raw } });
    const twice = whatsappChannelOutbound.normalizePayload?.({ payload: { text: once?.text } });

    expect(once?.text).toBe("After");
    expect(twice?.text).toBe("After");
  });

  it("drops whitespace-only text after XML sanitizer removal", () => {
    const raw = [
      "  <function_calls>",
      '    <invoke name="send_message">',
      '      <parameter name="text">hidden</parameter>',
      "    </invoke>",
      "  </function_calls>",
    ].join("\n");

    expect(whatsappChannelOutbound.normalizePayload?.({ payload: { text: raw } })).toEqual({
      text: "",
    });
  });

  it("sanitizes XML tool payloads before plain HTML stripping", () => {
    const raw = [
      "Before",
      "<function_calls>",
      '  <invoke name="send_message">',
      '    <parameter name="text">hidden</parameter>',
      "  </invoke>",
      "</function_calls>",
      "After",
    ].join("\n");

    expect(whatsappChannelOutbound.sanitizeText?.({ text: raw, payload: { text: raw } })).toBe(
      "Before\n\nAfter",
    );
  });

  it("preserves indentation for live text sends", async () => {
    await whatsappChannelOutbound.sendText!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "\n \n    indented",
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "    indented", {
      verbose: false,
      cfg: {},
      accountId: undefined,
      gifPlayback: undefined,
      preserveLeadingWhitespace: true,
    });
  });

  it("preserves indentation for payload delivery", async () => {
    await whatsappChannelOutbound.sendPayload!({
      cfg: {},
      to: "5511999999999@c.us",
      text: "",
      payload: { text: "\n \n    indented" },
    });

    expect(hoisted.sendMessageWhatsApp).toHaveBeenCalledWith("5511999999999@c.us", "    indented", {
      verbose: false,
      cfg: {},
      accountId: undefined,
      gifPlayback: undefined,
      preserveLeadingWhitespace: true,
    });
  });
});
