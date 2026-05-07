import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedIrcAccount } from "./accounts.js";
import { handleIrcInbound } from "./inbound.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { clearIrcRuntime, setIrcRuntime } from "./runtime.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

const {
  buildMentionRegexesMock,
  hasControlCommandMock,
  matchesMentionPatternsMock,
  readAllowFromStoreMock,
  shouldHandleTextCommandsMock,
  upsertPairingRequestMock,
} = vi.hoisted(() => {
  return {
    buildMentionRegexesMock: vi.fn(() => []),
    hasControlCommandMock: vi.fn(() => false),
    matchesMentionPatternsMock: vi.fn(() => false),
    readAllowFromStoreMock: vi.fn(async () => []),
    shouldHandleTextCommandsMock: vi.fn(() => false),
    upsertPairingRequestMock: vi.fn(async () => ({ code: "CODE", created: true })),
  };
});

function installIrcRuntime() {
  setIrcRuntime({
    channel: {
      pairing: {
        readAllowFromStore: readAllowFromStoreMock,
        upsertPairingRequest: upsertPairingRequestMock,
      },
      commands: {
        shouldHandleTextCommands: shouldHandleTextCommandsMock,
      },
      text: {
        hasControlCommand: hasControlCommandMock,
      },
      mentions: {
        buildMentionRegexes: buildMentionRegexesMock,
        matchesMentionPatterns: matchesMentionPatternsMock,
      },
    },
  } as never);
}

function createRuntimeEnv() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createAccount(overrides?: Partial<ResolvedIrcAccount>): ResolvedIrcAccount {
  return {
    accountId: "default",
    enabled: true,
    server: "irc.example.com",
    nick: "OpenClaw",
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
    },
    ...overrides,
  } as ResolvedIrcAccount;
}

function createMessage(overrides?: Partial<IrcInboundMessage>): IrcInboundMessage {
  return {
    messageId: "msg-1",
    target: "alice",
    senderNick: "alice",
    senderUser: "ident",
    senderHost: "example.com",
    text: "hello",
    timestamp: Date.now(),
    isGroup: false,
    ...overrides,
  };
}

function resetInboundMocks() {
  buildMentionRegexesMock.mockReset().mockReturnValue([]);
  hasControlCommandMock.mockReset().mockReturnValue(false);
  matchesMentionPatternsMock.mockReset().mockReturnValue(false);
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  shouldHandleTextCommandsMock.mockReset().mockReturnValue(false);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "CODE", created: true });
}

describe("irc inbound behavior", () => {
  beforeEach(() => {
    resetInboundMocks();
    installIrcRuntime();
  });

  afterEach(() => {
    clearIrcRuntime();
  });

  it("issues a DM pairing challenge and sends the reply to the sender nick", async () => {
    const sendReply = vi.fn(async () => {});

    await handleIrcInbound({
      message: createMessage(),
      account: createAccount(),
      config: { channels: { irc: {} } } as CoreConfig,
      runtime: createRuntimeEnv(),
      sendReply,
    });

    expect(upsertPairingRequestMock).toHaveBeenCalledWith({
      channel: "irc",
      accountId: "default",
      id: "alice!ident@example.com",
      meta: { name: "alice" },
    });
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith(
      "alice",
      expect.stringContaining("OpenClaw: access not configured."),
      undefined,
    );
    expect(sendReply).toHaveBeenCalledWith(
      "alice",
      expect.stringContaining("Your IRC id: alice!ident@example.com"),
      undefined,
    );
    expect(sendReply).toHaveBeenCalledWith("alice", expect.stringContaining("CODE"), undefined);
  });

  it("drops unauthorized group control commands before dispatch", async () => {
    const runtime = createRuntimeEnv();
    shouldHandleTextCommandsMock.mockReturnValue(true);
    hasControlCommandMock.mockReturnValue(true);

    await handleIrcInbound({
      message: createMessage({
        target: "#ops",
        isGroup: true,
        text: "/admin",
      }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: ["bob!ident@example.com"],
          groups: {
            "#ops": {
              allowFrom: ["alice!ident@example.com"],
            },
          },
        },
      }),
      config: { channels: { irc: {} }, commands: { useAccessGroups: true } } as CoreConfig,
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      "irc: drop control command (unauthorized) target=alice!ident@example.com",
    );
  });
});
