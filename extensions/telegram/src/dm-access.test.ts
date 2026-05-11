import type { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const createChannelPairingChallengeIssuerMock = vi.hoisted(() => vi.fn());
const upsertChannelPairingRequestMock = vi.hoisted(() =>
  vi.fn(async () => ({ code: "123456", created: true })),
);
const withTelegramApiErrorLoggingMock = vi.hoisted(() => vi.fn(async ({ fn }) => await fn()));
const createPairingPrefixStripperMock = vi.hoisted(
  () => (prefix: RegExp, normalize: (value: string) => string) => (value: string) =>
    normalize(value.replace(prefix, "")),
);

vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({
  createChannelPairingChallengeIssuer: createChannelPairingChallengeIssuerMock,
  createPairingPrefixStripper: createPairingPrefixStripperMock,
  createLoggedPairingApprovalNotifier: () => undefined,
  createTextPairingAdapter: () => undefined,
  createChannelPairingController: () => ({}),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  upsertChannelPairingRequest: upsertChannelPairingRequestMock,
  createStaticReplyToModeResolver: (mode: string) => () => mode,
  createTopLevelChannelReplyToModeResolver: () => () => "off",
  createScopedAccountReplyToModeResolver: () => () => "off",
  resolvePinnedMainDmOwnerFromAllowlist: () => undefined,
}));

vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: withTelegramApiErrorLoggingMock,
}));

import type { Message } from "@grammyjs/types";
import { normalizeAllowFrom } from "./bot-access.js";
let enforceTelegramDmAccess: typeof import("./dm-access.js").enforceTelegramDmAccess;

function createDmMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    date: 1,
    chat: { id: 42, type: "private" },
    from: {
      id: 12345,
      is_bot: false,
      first_name: "Test",
      username: "tester",
    },
    text: "hello",
    ...overrides,
  } as Message;
}

async function enforceDefaultDmAccess(params: {
  dmPolicy: "open" | "disabled" | "pairing";
  allow?: string[];
}) {
  const bot = { api: { sendMessage: vi.fn(async () => undefined) } };
  const allowed = await enforceTelegramDmAccess({
    isGroup: false,
    dmPolicy: params.dmPolicy,
    msg: createDmMessage(),
    chatId: 42,
    effectiveDmAllow: normalizeAllowFrom(params.allow ?? []),
    accountId: "main",
    bot: bot as never,
    logger: { info: vi.fn() },
    upsertPairingRequest: upsertChannelPairingRequestMock,
  });

  return { allowed, bot };
}

describe("enforceTelegramDmAccess", () => {
  beforeAll(async () => {
    ({ enforceTelegramDmAccess } = await import("./dm-access.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows DMs when policy is open with wildcard allowFrom", async () => {
    const { allowed, bot } = await enforceDefaultDmAccess({
      dmPolicy: "open",
      allow: ["*"],
    });

    expect(allowed).toBe(true);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("blocks non-allowlisted DMs when open policy has no wildcard", async () => {
    const { allowed, bot } = await enforceDefaultDmAccess({
      dmPolicy: "open",
      allow: ["99999"],
    });

    expect(allowed).toBe(false);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("allows allowlisted DMs when open policy was constrained by a restrictive allowFrom", async () => {
    const { allowed, bot } = await enforceDefaultDmAccess({
      dmPolicy: "open",
      allow: ["12345"],
    });

    expect(allowed).toBe(true);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("blocks DMs when policy is disabled", async () => {
    const { allowed } = await enforceDefaultDmAccess({ dmPolicy: "disabled" });

    expect(allowed).toBe(false);
  });

  it("allows DMs for allowlisted senders under pairing policy", async () => {
    const { allowed } = await enforceDefaultDmAccess({
      dmPolicy: "pairing",
      allow: ["12345"],
    });

    expect(allowed).toBe(true);
    expect(createChannelPairingChallengeIssuerMock).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge for unauthorized DMs under pairing policy", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const logger = { info: vi.fn() };
    createChannelPairingChallengeIssuerMock.mockReturnValueOnce(
      ({
        sendPairingReply,
        onCreated,
      }: Parameters<ReturnType<typeof createChannelPairingChallengeIssuer>>[0]) =>
        (async () => {
          onCreated?.({ code: "123456" });
          await sendPairingReply("Pairing code: 123456");
        })(),
    );

    const allowed = await enforceTelegramDmAccess({
      isGroup: false,
      dmPolicy: "pairing",
      msg: createDmMessage(),
      chatId: 42,
      effectiveDmAllow: normalizeAllowFrom([]),
      accountId: "main",
      bot: { api: { sendMessage } } as never,
      logger,
      upsertPairingRequest: upsertChannelPairingRequestMock,
    });

    expect(allowed).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [firstCall] = sendMessage.mock.calls as Array<unknown[]>;
    expect(firstCall?.[0]).toBe(42);
    const sentText = typeof firstCall?.[1] === "string" ? firstCall[1] : "";
    expect(sentText).toContain("Pairing code:");
    expect(firstCall?.[2]).toEqual({ parse_mode: "HTML" });
    expect(logger.info).toHaveBeenCalledWith(
      {
        chatId: "42",
        senderUserId: "12345",
        username: "tester",
        firstName: "Test",
        lastName: undefined,
      },
      "telegram pairing request",
    );
  });
});
