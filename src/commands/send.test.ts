import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { sendCommand } from "./send.js";

let testConfig: Record<string, unknown> = {};
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => testConfig,
  };
});

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
  randomIdempotencyKey: () => "idem-1",
}));

const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
const originalDiscordToken = process.env.DISCORD_BOT_TOKEN;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "token-abc";
  process.env.DISCORD_BOT_TOKEN = "token-discord";
  testConfig = {};
});

afterAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
  process.env.DISCORD_BOT_TOKEN = originalDiscordToken;
});

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const makeDeps = (overrides: Partial<CliDeps> = {}): CliDeps => ({
  sendMessageWhatsApp: vi.fn(),
  sendMessageTelegram: vi.fn(),
  sendMessageDiscord: vi.fn(),
  sendMessageSlack: vi.fn(),
  sendMessageSignal: vi.fn(),
  sendMessageIMessage: vi.fn(),
  ...overrides,
});

describe("sendCommand", () => {
  it("skips send on dry-run", async () => {
    const deps = makeDeps();
    await sendCommand(
      {
        to: "+1",
        message: "hi",
        dryRun: true,
      },
      deps,
      runtime,
    );
    expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("sends via gateway", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "g1" });
    const deps = makeDeps();
    await sendCommand(
      {
        to: "+1",
        message: "hi",
      },
      deps,
      runtime,
    );
    expect(callGatewayMock).toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("g1"));
  });

  it("does not override remote gateway URL", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "g2" });
    testConfig = {
      gateway: { mode: "remote", remote: { url: "wss://remote.example" } },
    };
    const deps = makeDeps();
    await sendCommand(
      {
        to: "+1",
        message: "hi",
      },
      deps,
      runtime,
    );
    const args = callGatewayMock.mock.calls.at(-1)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(args?.url).toBeUndefined();
  });

  it("passes gifPlayback to gateway send", async () => {
    callGatewayMock.mockClear();
    callGatewayMock.mockResolvedValueOnce({ messageId: "g1" });
    const deps = makeDeps();
    await sendCommand(
      {
        to: "+1",
        message: "hi",
        gifPlayback: true,
      },
      deps,
      runtime,
    );
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "send",
        params: expect.objectContaining({ gifPlayback: true }),
      }),
    );
  });

  it("routes to telegram provider", async () => {
    const deps = makeDeps({
      sendMessageTelegram: vi
        .fn()
        .mockResolvedValue({ messageId: "t1", chatId: "123" }),
    });
    testConfig = { telegram: { botToken: "token-abc" } };
    await sendCommand(
      { to: "123", message: "hi", provider: "telegram" },
      deps,
      runtime,
    );
    expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({ token: "token-abc" }),
    );
    expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("uses config token for telegram when env is missing", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "";
    testConfig = { telegram: { botToken: "cfg-token" } };
    const deps = makeDeps({
      sendMessageTelegram: vi
        .fn()
        .mockResolvedValue({ messageId: "t1", chatId: "123" }),
    });
    await sendCommand(
      { to: "123", message: "hi", provider: "telegram" },
      deps,
      runtime,
    );
    expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({ token: "cfg-token" }),
    );
  });

  it("routes to discord provider", async () => {
    const deps = makeDeps({
      sendMessageDiscord: vi
        .fn()
        .mockResolvedValue({ messageId: "d1", channelId: "chan" }),
    });
    await sendCommand(
      { to: "channel:chan", message: "hi", provider: "discord" },
      deps,
      runtime,
    );
    expect(deps.sendMessageDiscord).toHaveBeenCalledWith(
      "channel:chan",
      "hi",
      expect.objectContaining({ token: "token-discord" }),
    );
    expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("routes to signal provider", async () => {
    const deps = makeDeps({
      sendMessageSignal: vi.fn().mockResolvedValue({ messageId: "s1" }),
    });
    await sendCommand(
      { to: "+15551234567", message: "hi", provider: "signal" },
      deps,
      runtime,
    );
    expect(deps.sendMessageSignal).toHaveBeenCalledWith(
      "+15551234567",
      "hi",
      expect.objectContaining({ mediaUrl: undefined }),
    );
    expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("routes to slack provider", async () => {
    const deps = makeDeps({
      sendMessageSlack: vi
        .fn()
        .mockResolvedValue({ messageId: "s1", channelId: "C123" }),
    });
    await sendCommand(
      { to: "channel:C123", message: "hi", provider: "slack" },
      deps,
      runtime,
    );
    expect(deps.sendMessageSlack).toHaveBeenCalledWith(
      "channel:C123",
      "hi",
      expect.objectContaining({ mediaUrl: undefined }),
    );
    expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("routes to imessage provider", async () => {
    const deps = makeDeps({
      sendMessageIMessage: vi.fn().mockResolvedValue({ messageId: "i1" }),
    });
    await sendCommand(
      { to: "chat_id:42", message: "hi", provider: "imessage" },
      deps,
      runtime,
    );
    expect(deps.sendMessageIMessage).toHaveBeenCalledWith(
      "chat_id:42",
      "hi",
      expect.objectContaining({ mediaUrl: undefined }),
    );
    expect(deps.sendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("emits json output", async () => {
    callGatewayMock.mockResolvedValueOnce({ messageId: "direct2" });
    const deps = makeDeps();
    await sendCommand(
      {
        to: "+1",
        message: "hi",
        json: true,
      },
      deps,
      runtime,
    );
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining('"provider": "web"'),
    );
  });
});
