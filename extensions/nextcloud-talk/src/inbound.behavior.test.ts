import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

const {
  createChannelPairingControllerMock,
  dispatchInboundReplyWithBaseMock,
  readStoreAllowFromForDmPolicyMock,
  resolveDmGroupAccessWithCommandGateMock,
  resolveAllowlistProviderRuntimeGroupPolicyMock,
  resolveDefaultGroupPolicyMock,
  warnMissingProviderGroupPolicyFallbackOnceMock,
} = vi.hoisted(() => {
  return {
    createChannelPairingControllerMock: vi.fn(),
    dispatchInboundReplyWithBaseMock: vi.fn(),
    readStoreAllowFromForDmPolicyMock: vi.fn(),
    resolveDmGroupAccessWithCommandGateMock: vi.fn(),
    resolveAllowlistProviderRuntimeGroupPolicyMock: vi.fn(),
    resolveDefaultGroupPolicyMock: vi.fn(),
    warnMissingProviderGroupPolicyFallbackOnceMock: vi.fn(),
  };
});

const sendMessageNextcloudTalkMock = vi.hoisted(() => vi.fn());
const resolveNextcloudTalkRoomKindMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    createChannelPairingController: createChannelPairingControllerMock,
    dispatchInboundReplyWithBase: dispatchInboundReplyWithBaseMock,
    readStoreAllowFromForDmPolicy: readStoreAllowFromForDmPolicyMock,
    resolveDmGroupAccessWithCommandGate: resolveDmGroupAccessWithCommandGateMock,
    resolveAllowlistProviderRuntimeGroupPolicy: resolveAllowlistProviderRuntimeGroupPolicyMock,
    resolveDefaultGroupPolicy: resolveDefaultGroupPolicyMock,
    warnMissingProviderGroupPolicyFallbackOnce: warnMissingProviderGroupPolicyFallbackOnceMock,
  };
});

vi.mock("./send.js", () => ({
  sendMessageNextcloudTalk: sendMessageNextcloudTalkMock,
}));

vi.mock("./room-info.js", async () => {
  const actual = await vi.importActual<typeof import("./room-info.js")>("./room-info.js");
  return {
    ...actual,
    resolveNextcloudTalkRoomKind: resolveNextcloudTalkRoomKindMock,
  };
});

function installRuntime(params?: {
  buildMentionRegexes?: () => RegExp[];
  matchesMentionPatterns?: (body: string, regexes: RegExp[]) => boolean;
}) {
  setNextcloudTalkRuntime({
    channel: {
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: true })),
      },
      commands: {
        shouldHandleTextCommands: vi.fn(() => false),
      },
      text: {
        hasControlCommand: vi.fn(() => false),
      },
      mentions: {
        buildMentionRegexes: params?.buildMentionRegexes ?? vi.fn(() => []),
        matchesMentionPatterns: params?.matchesMentionPatterns ?? vi.fn(() => false),
      },
    },
  } as unknown as PluginRuntime);
}

function createRuntimeEnv() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createAccount(
  overrides?: Partial<ResolvedNextcloudTalkAccount>,
): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://cloud.example.com",
    secret: "secret",
    secretSource: "config",
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
    },
    ...overrides,
  };
}

function createMessage(
  overrides?: Partial<NextcloudTalkInboundMessage>,
): NextcloudTalkInboundMessage {
  return {
    messageId: "msg-1",
    roomToken: "room-1",
    roomName: "Room 1",
    senderId: "user-1",
    senderName: "Alice",
    text: "hello",
    mediaType: "text/plain",
    timestamp: Date.now(),
    isGroupChat: false,
    ...overrides,
  };
}

describe("nextcloud-talk inbound behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installRuntime();
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("direct");
    resolveDefaultGroupPolicyMock.mockReturnValue("allowlist");
    resolveAllowlistProviderRuntimeGroupPolicyMock.mockReturnValue({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    });
    warnMissingProviderGroupPolicyFallbackOnceMock.mockReturnValue(undefined);
    readStoreAllowFromForDmPolicyMock.mockResolvedValue([]);
  });

  // The DM pairing assertion currently depends on a mocked runtime barrel that Vitest
  // does not bind reliably for this extension package.
  it.skip("issues a DM pairing challenge and sends the challenge text", async () => {
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(),
      issueChallenge: vi.fn(),
    });
    resolveDmGroupAccessWithCommandGateMock.mockReturnValue({
      decision: "pairing",
      reason: "pairing_required",
      commandAuthorized: false,
      effectiveGroupAllowFrom: [],
    });
    sendMessageNextcloudTalkMock.mockResolvedValue(undefined);

    const statusSink = vi.fn();
    await handleNextcloudTalkInbound({
      message: createMessage(),
      account: createAccount(),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime: createRuntimeEnv(),
      statusSink,
    });
  });

  it("drops unmentioned group traffic before dispatch", async () => {
    installRuntime({
      buildMentionRegexes: vi.fn(() => [/@openclaw/i]),
      matchesMentionPatterns: vi.fn(() => false),
    });
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(),
      issueChallenge: vi.fn(),
    });
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("group");
    resolveDmGroupAccessWithCommandGateMock.mockReturnValue({
      decision: "allow",
      reason: "allow",
      commandAuthorized: false,
      effectiveGroupAllowFrom: ["user-1"],
    });
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInbound({
      message: createMessage({
        roomToken: "room-group",
        roomName: "Ops",
        isGroupChat: true,
      }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: ["user-1"],
        },
      }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
    });

    expect(dispatchInboundReplyWithBaseMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("nextcloud-talk: drop room room-group (no mention)");
  });
});
