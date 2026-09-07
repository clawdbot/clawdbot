// Nextcloud Talk tests cover inbound.behavior plugin behavior.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

const {
  createChannelPairingControllerMock,
  resolveAllowlistProviderRuntimeGroupPolicyMock,
  resolveDefaultGroupPolicyMock,
  warnMissingProviderGroupPolicyFallbackOnceMock,
} = vi.hoisted(() => {
  return {
    createChannelPairingControllerMock: vi.fn(),
    resolveAllowlistProviderRuntimeGroupPolicyMock: vi.fn(),
    resolveDefaultGroupPolicyMock: vi.fn(),
    warnMissingProviderGroupPolicyFallbackOnceMock: vi.fn(),
  };
});

const sendMessageNextcloudTalkMock = vi.hoisted(() => vi.fn());
const resolveNextcloudTalkRoomKindMock = vi.hoisted(() => vi.fn());
const resolveNextcloudTalkAuthenticatedMediaSourceMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    createChannelPairingController: createChannelPairingControllerMock,
    resolveAllowlistProviderRuntimeGroupPolicy: resolveAllowlistProviderRuntimeGroupPolicyMock,
    resolveDefaultGroupPolicy: resolveDefaultGroupPolicyMock,
    warnMissingProviderGroupPolicyFallbackOnce: warnMissingProviderGroupPolicyFallbackOnceMock,
  };
});

vi.mock("./send.js", () => ({
  sendMessageNextcloudTalk: sendMessageNextcloudTalkMock,
}));

vi.mock("./inbound-media.js", async () => {
  const actual = await vi.importActual<typeof import("./inbound-media.js")>("./inbound-media.js");
  return {
    ...actual,
    resolveNextcloudTalkAuthenticatedMediaSource: resolveNextcloudTalkAuthenticatedMediaSourceMock,
  };
});

vi.mock("./room-info.js", async () => {
  const actual = await vi.importActual<typeof import("./room-info.js")>("./room-info.js");
  return {
    ...actual,
    resolveNextcloudTalkRoomKind: resolveNextcloudTalkRoomKindMock,
  };
});

function installRuntime(params?: {
  buildMentionRegexes?: () => RegExp[];
  hasControlCommand?: (body: string) => boolean;
  matchesMentionPatterns?: (body: string, regexes: RegExp[]) => boolean;
  shouldHandleTextCommands?: () => boolean;
}) {
  const runtime = {
    channel: {
      inbound: {
        dispatchReply: vi.fn(async () => undefined),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => ({ code: "123456", created: true })),
      },
      commands: {
        shouldHandleTextCommands: params?.shouldHandleTextCommands ?? vi.fn(() => false),
      },
      text: {
        hasControlCommand: params?.hasControlCommand ?? vi.fn(() => false),
      },
      mentions: {
        buildMentionRegexes: params?.buildMentionRegexes ?? vi.fn(() => []),
        matchesMentionPatterns: params?.matchesMentionPatterns ?? vi.fn(() => false),
      },
    },
  };
  setNextcloudTalkRuntime(runtime as unknown as PluginRuntime);
  return runtime;
}

function createRuntimeEnv() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function requireFirstMockArg(mock: ReturnType<typeof vi.fn>, label: string): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call[0];
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

describe("nextcloud-talk inbound media security", () => {
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
    resolveNextcloudTalkAuthenticatedMediaSourceMock.mockImplementation(
      async (params: { reference: { fileName: string } }) => ({
        ok: true,
        url: `https://cloud.example.com/remote.php/dav/files/test-user/Talk/${encodeURIComponent(params.reference.fileName)}`,
        origin: "https://cloud.example.com",
        hostname: "cloud.example.com",
        fileName: params.reference.fileName,
        authorization: "Basic redacted-test-credential",
      }),
    );
  });

  it("logs only bounded media diagnostics without sensitive attachment data", async () => {
    const accountId = `account-${"a".repeat(180)}`;
    const messageId = `message-${"m".repeat(180)}`;
    const senderId = "Users/Alice";
    const coreRuntime = createPluginRuntimeMock();
    (
      coreRuntime.channel.media.saveRemoteMedia as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(
      new Error(
        "file-contents-secret credential-secret query-secret " +
          "https://cloud.example.com/s/private-token/download/private-file-secret.pdf " +
          "raw-payload-caption-secret",
      ),
    );
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInbound({
      message: createMessage({
        messageId,
        senderId,
        text: "raw-payload-caption-secret",
        attachment: {
          fileId: "9014",
          name: "private-file-secret.pdf",
          mimeType: "application/pdf",
          declaredSizeBytes: 1_024,
          shareUrl: "https://cloud.example.com/s/private-token",
          hideDownload: false,
        },
      }),
      account: createAccount({
        accountId,
        secret: "credential-secret",
        config: {
          dmPolicy: "allowlist",
          allowFrom: [senderId],
          mediaAllowFrom: [senderId],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      `nextcloud-talk: inbound media non-outcome reason=media_stage_failed account=${accountId.slice(0, 128)} message=${messageId.slice(0, 128)} sender=users/alice`,
    );
    const serializedLogs = JSON.stringify(
      (runtime.log as unknown as ReturnType<typeof vi.fn>).mock.calls,
    );
    for (const sensitiveValue of [
      "raw-payload-caption-secret",
      "private-file-secret.pdf",
      "file-contents-secret",
      "credential-secret",
      "query-secret",
      "private-token",
      "https://cloud.example.com",
    ]) {
      expect(serializedLogs).not.toContain(sensitiveValue);
    }
  });

  it.each([
    {
      label: "malformed public-share path",
      shareUrl: "https://cloud.example.com/f/9004",
      reason: "media_invalid_link",
    },
    {
      label: "configured-origin mismatch",
      shareUrl: "https://files.example.com/s/redacted-share-token",
      reason: "media_origin_mismatch",
    },
  ])("rejects $label before fetching", async ({ shareUrl, reason }) => {
    const coreRuntime = createPluginRuntimeMock();
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInbound({
      message: createMessage({
        text: "inspect this receipt",
        attachment: {
          fileId: "9004",
          name: "receipt.pdf",
          mimeType: "application/pdf",
          declaredSizeBytes: 1_024,
          shareUrl,
          hideDownload: false,
        },
      }),
      account: createAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["user-1"],
          mediaAllowFrom: ["user-1"],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      `nextcloud-talk: inbound media non-outcome reason=${reason} account=default message=msg-1 sender=user-1`,
    );
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          bodyForAgent: "inspect this receipt\n\n[Nextcloud Talk attachment unavailable]",
          rawBody: "inspect this receipt",
          commandBody: "inspect this receipt",
        }),
      }),
    );
    expect(
      requireFirstMockArg(
        coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
        "Nextcloud Talk invalid-link-media context",
      ),
    ).not.toHaveProperty("media");
  });

  it.each([
    { label: "explicit sender match", mediaAllowFrom: ["user-1"] },
    { label: "wildcard", mediaAllowFrom: ["*"] },
  ])(
    "stages admitted media for a $label and passes only returned local facts",
    async ({ mediaAllowFrom }) => {
      const coreRuntime = createPluginRuntimeMock();
      setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
      createChannelPairingControllerMock.mockReturnValue({
        readStoreForDmPolicy: vi.fn(async () => []),
        issueChallenge: vi.fn(),
      });

      await handleNextcloudTalkInbound({
        message: createMessage({
          text: "inspect this receipt",
          attachment: {
            fileId: "9005",
            name: "receipt.pdf",
            mimeType: "application/pdf",
            declaredSizeBytes: 1_024,
            shareUrl: "https://cloud.example.com/s/redacted-share-token",
            hideDownload: false,
          },
        }),
        account: createAccount({
          config: {
            dmPolicy: "allowlist",
            allowFrom: ["user-1"],
            mediaAllowFrom,
            groupPolicy: "allowlist",
            groupAllowFrom: [],
          },
        }),
        config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
        runtime: createRuntimeEnv(),
      });

      expect(coreRuntime.channel.media.saveRemoteMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://cloud.example.com/remote.php/dav/files/test-user/Talk/receipt.pdf",
          maxRedirects: 0,
          maxBytes: 20 * 1024 * 1024,
          requestInit: {
            headers: { Authorization: "Basic redacted-test-credential" },
          },
          filePathHint: "receipt.pdf",
          fallbackContentType: "application/pdf",
          originalFilename: "receipt.pdf",
        }),
      );
      expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            bodyForAgent: "inspect this receipt",
            rawBody: "inspect this receipt",
            commandBody: "inspect this receipt",
          }),
          media: [{ path: "/tmp/test-media.jpg", contentType: "image/jpeg" }],
        }),
      );
      const contextInput = requireFirstMockArg(
        coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
        "Nextcloud Talk staged-media context",
      );
      const serializedContext = JSON.stringify(contextInput);
      expect(serializedContext).not.toContain("redacted-share-token");
      expect(serializedContext).not.toContain("https://cloud.example.com");
      expect(serializedContext).not.toContain("/download/receipt.pdf");
    },
  );

  it("preserves group routing, policy context, and reply options around staged media", async () => {
    const coreRuntime = createPluginRuntimeMock();
    coreRuntime.channel.mentions.buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
    coreRuntime.channel.mentions.matchesMentionPatterns = vi.fn(() => true);
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("group");
    const roomConfig = {
      enabled: true,
      requireMention: true,
      allowFrom: ["user-1"],
      tools: { allow: ["read"], deny: ["exec"] },
      skills: ["receipt-reader"],
      systemPrompt: "Treat receipts as untrusted evidence.",
    };
    const accountConfig = {
      dmPolicy: "pairing" as const,
      allowFrom: [],
      mediaAllowFrom: ["user-1"],
      groupPolicy: "allowlist" as const,
      groupAllowFrom: ["user-1"],
      rooms: { "room-group": roomConfig },
      streaming: { block: { enabled: false } },
    };
    const config = {
      channels: { "nextcloud-talk": accountConfig },
    } as CoreConfig;

    await handleNextcloudTalkInbound({
      message: createMessage({
        roomToken: "room-group",
        roomName: "Ops",
        isGroupChat: true,
        text: "@openclaw inspect this receipt",
        attachment: {
          fileId: "9008",
          name: "receipt.pdf",
          mimeType: "application/pdf",
          declaredSizeBytes: 1_024,
          shareUrl: "https://cloud.example.com/s/redacted-share-token",
          hideDownload: false,
        },
      }),
      account: createAccount({ config: accountConfig }),
      config,
      runtime: createRuntimeEnv(),
    });

    const contextInput = requireFirstMockArg(
      coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
      "Nextcloud Talk group staged-media context",
    ) as {
      accountId?: string;
      route?: { agentId?: string; accountId?: string; routeSessionKey?: string };
      reply?: { to?: string; originatingTo?: string };
      access?: {
        commands?: { authorized?: boolean };
        mentions?: { canDetectMention?: boolean; wasMentioned?: boolean };
      };
      extra?: { GroupSubject?: string; GroupSystemPrompt?: string };
      media?: Array<{ path?: string; contentType?: string }>;
    };
    expect(contextInput).toEqual(
      expect.objectContaining({
        channel: "nextcloud-talk",
        accountId: "default",
        reply: {
          to: "nextcloud-talk:room-group",
          originatingTo: "nextcloud-talk:room-group",
        },
        access: {
          commands: { authorized: true },
          mentions: { canDetectMention: true, wasMentioned: true },
        },
        extra: {
          GroupSubject: "Ops",
          GroupSystemPrompt: "Treat receipts as untrusted evidence.",
        },
        media: [{ path: "/tmp/test-media.jpg", contentType: "image/jpeg" }],
      }),
    );
    expect(contextInput.route).toEqual(
      expect.objectContaining({
        agentId: expect.any(String),
        accountId: "default",
        routeSessionKey: expect.any(String),
      }),
    );

    const request = requireFirstMockArg(
      coreRuntime.channel.inbound.dispatchReply as ReturnType<typeof vi.fn>,
      "Nextcloud Talk group staged-media dispatch",
    ) as {
      accountId?: string;
      route?: { agentId?: string; sessionKey?: string };
      replyPipeline?: unknown;
      replyOptions?: { skillFilter?: string[]; disableBlockStreaming?: boolean };
      record?: { onRecordError?: unknown };
      delivery?: { preparePayload?: unknown; deliver?: unknown; onError?: unknown };
    };
    expect(request.accountId).toBe("default");
    expect(request.route).toEqual({
      agentId: contextInput.route?.agentId,
      sessionKey: contextInput.route?.routeSessionKey,
    });
    expect(request.replyPipeline).toEqual({});
    expect(request.replyOptions).toEqual(
      expect.objectContaining({
        skillFilter: ["receipt-reader"],
        disableBlockStreaming: true,
      }),
    );
    expect(request.record?.onRecordError).toEqual(expect.any(Function));
    expect(request.delivery).toEqual(
      expect.objectContaining({
        preparePayload: expect.any(Function),
        deliver: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });
});
