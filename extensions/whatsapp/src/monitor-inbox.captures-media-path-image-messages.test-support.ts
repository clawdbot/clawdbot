import "./monitor-inbox.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  getAuthDir,
  getMonitorWebInbox,
  getSock,
  installWebMonitorInboxUnitTestHooks,
  mockLoadConfig,
} from "./monitor-inbox.test-harness.js";
let monitorWebInbox: typeof import("./inbound.js").monitorWebInbox;
const inboundLoggerInfoMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/logging-core", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/logging-core")>(
    "openclaw/plugin-sdk/logging-core",
  );
  return {
    ...actual,
    getChildLogger: () => ({
      info: inboundLoggerInfoMock,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

describe("web monitor inbox", () => {
  installWebMonitorInboxUnitTestHooks();

  beforeEach(() => {
    inboundLoggerInfoMock.mockReset();
    monitorWebInbox = getMonitorWebInbox();
  });

  async function openMonitor(onMessage = vi.fn()) {
    return await monitorWebInbox({
      cfg: mockLoadConfig() as never,
      verbose: false,
      accountId: DEFAULT_ACCOUNT_ID,
      authDir: getAuthDir(),
      onMessage,
    });
  }

  async function runSingleUpsertAndCapture(upsert: unknown) {
    const onMessage = vi.fn();
    const listener = await openMonitor(onMessage);
    const sock = getSock();
    sock.ev.emit("messages.upsert", upsert);
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { onMessage, listener, sock };
  }

  function expectSingleGroupMessage(
    onMessage: ReturnType<typeof vi.fn>,
    expected: Record<string, unknown>,
  ) {
    expect(onMessage).toHaveBeenCalledTimes(1);
    const message = onMessage.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    if (!message) {
      throw new Error("expected inbound group message");
    }
    for (const [key, value] of Object.entries(expected)) {
      expect(message[key]).toEqual(value);
    }
  }

  it("captures media path for image messages", async () => {
    const { onMessage, listener, sock } = await runSingleUpsertAndCapture({
      type: "notify",
      messages: [
        {
          key: { id: "med1", fromMe: false, remoteJid: "888@s.whatsapp.net" },
          message: { imageMessage: { mimetype: "image/jpeg" } },
          messageTimestamp: 1_700_000_100,
        },
      ],
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]?.body).toBe("<media:image>");
    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "888@s.whatsapp.net",
        id: "med1",
        participant: undefined,
        fromMe: false,
      },
    ]);
    expect(sock.sendPresenceUpdate).toHaveBeenNthCalledWith(1, "available");
    await listener.close();
  });

  it("sets gifPlayback on outbound video payloads when requested", async () => {
    const onMessage = vi.fn();
    const listener = await openMonitor(onMessage);
    const sock = getSock();
    const buf = Buffer.from("gifvid");

    await listener.sendMessage("+1555", "gif", buf, "video/mp4", {
      gifPlayback: true,
    });

    expect(sock.sendMessage).toHaveBeenCalledWith("1555@s.whatsapp.net", {
      video: buf,
      caption: "gif",
      mimetype: "video/mp4",
      gifPlayback: true,
    });

    await listener.close();
  });

  it("resolves onClose when the socket closes", async () => {
    const listener = await openMonitor(vi.fn());
    const sock = getSock();
    const reasonPromise = listener.onClose;
    sock.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });
    await expect(reasonPromise).resolves.toEqual({
      status: 500,
      isLoggedOut: false,
      error: { output: { statusCode: 500 } },
    });
    await listener.close();
  });

  it("detaches inbound listeners and ends the socket on close()", async () => {
    const listener = await openMonitor(vi.fn());
    const sock = getSock();

    expect(sock.ev.listenerCount("messages.upsert")).toBeGreaterThan(0);
    expect(sock.ev.listenerCount("connection.update")).toBeGreaterThan(0);

    await listener.close();

    expect(sock.ev.listenerCount("messages.upsert")).toBe(0);
    expect(sock.ev.listenerCount("connection.update")).toBe(0);
    expect(sock.end).toHaveBeenCalledTimes(1);
    const closeError = sock.end.mock.calls[0]?.[0];
    expect(closeError).toBeInstanceOf(Error);
    expect(closeError?.message).toBe("OpenClaw WhatsApp listener close");
    expect(sock.ws.close).not.toHaveBeenCalled();
  });

  it("logs inbound bodies through the inbound child logger", async () => {
    const { listener } = await runSingleUpsertAndCapture({
      type: "notify",
      messages: [
        {
          key: { id: "abc", fromMe: false, remoteJid: "999@s.whatsapp.net" },
          message: { conversation: "ping" },
          messageTimestamp: 1_700_000_000,
          pushName: "Tester",
        },
      ],
    });

    expect(inboundLoggerInfoMock).toHaveBeenCalledTimes(1);
    expect(inboundLoggerInfoMock.mock.calls[0]?.[0]?.body).toBe("ping");
    expect(inboundLoggerInfoMock.mock.calls[0]?.[0]?.from).toBe("+999");
    expect(inboundLoggerInfoMock.mock.calls[0]?.[1]).toBe("inbound message");
    await listener.close();
  });

  it("includes participant when marking group messages read", async () => {
    const { listener, sock } = await runSingleUpsertAndCapture({
      type: "notify",
      messages: [
        {
          key: {
            id: "grp1",
            fromMe: false,
            remoteJid: "12345-67890@g.us",
            participant: "111@s.whatsapp.net",
          },
          message: { conversation: "group ping" },
        },
      ],
    });

    expect(sock.readMessages).toHaveBeenCalledWith([
      {
        remoteJid: "12345-67890@g.us",
        id: "grp1",
        participant: "111@s.whatsapp.net",
        fromMe: false,
      },
    ]);
    await listener.close();
  });

  it("passes through group messages with participant metadata", async () => {
    const { onMessage, listener } = await runSingleUpsertAndCapture({
      type: "notify",
      messages: [
        {
          key: {
            id: "grp2",
            fromMe: false,
            remoteJid: "99999@g.us",
            participant: "777@s.whatsapp.net",
          },
          pushName: "Alice",
          message: {
            extendedTextMessage: {
              text: "@bot ping",
              contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
            },
          },
          messageTimestamp: 1_700_000_000,
        },
      ],
    });

    expectSingleGroupMessage(onMessage, {
      chatType: "group",
      conversationId: "99999@g.us",
      senderE164: "+777",
      mentionedJids: ["123@s.whatsapp.net"],
    });
    await listener.close();
  });

  it("unwraps ephemeral messages, preserves mentions, and still delivers group pings", async () => {
    const { onMessage, listener } = await runSingleUpsertAndCapture({
      type: "notify",
      messages: [
        {
          key: {
            id: "grp-ephem",
            fromMe: false,
            remoteJid: "424242@g.us",
            participant: "888@s.whatsapp.net",
          },
          message: {
            ephemeralMessage: {
              message: {
                extendedTextMessage: {
                  text: "oh hey @Clawd UK !",
                  contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
                },
              },
            },
          },
        },
      ],
    });
    expectSingleGroupMessage(onMessage, {
      chatType: "group",
      conversationId: "424242@g.us",
      body: "oh hey @Clawd UK !",
      mentionedJids: ["123@s.whatsapp.net"],
      senderE164: "+888",
    });
    await listener.close();
  });

  it("still forwards group messages (with sender info) even when allowFrom is restrictive", async () => {
    mockLoadConfig.mockReturnValue({
      channels: {
        whatsapp: {
          // does not include +777
          allowFrom: ["+111"],
          groupPolicy: "open",
        },
      },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    });

    const { onMessage, listener } = await runSingleUpsertAndCapture({
      type: "notify",
      messages: [
        {
          key: {
            id: "grp-allow",
            fromMe: false,
            remoteJid: "55555@g.us",
            participant: "777@s.whatsapp.net",
          },
          message: {
            extendedTextMessage: {
              text: "@bot hi",
              contextInfo: { mentionedJid: ["123@s.whatsapp.net"] },
            },
          },
        },
      ],
    });
    expectSingleGroupMessage(onMessage, {
      chatType: "group",
      from: "55555@g.us",
      senderE164: "+777",
      senderJid: "777@s.whatsapp.net",
      mentionedJids: ["123@s.whatsapp.net"],
      selfE164: "+123",
      selfJid: "123@s.whatsapp.net",
    });
    await listener.close();
  });
});
