// Nextcloud Talk tests cover inbound.behavior plugin behavior.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { MediaFetchError } from "openclaw/plugin-sdk/media-runtime";
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

describe("nextcloud-talk inbound media behavior", () => {
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

  it("admits and stages an attachment-only direct message", async () => {
    const coreRuntime = createPluginRuntimeMock();
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });

    await handleNextcloudTalkInbound({
      message: createMessage({
        text: "",
        attachment: {
          fileId: "9006",
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
          mediaAllowFrom: ["user-1"],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ bodyForAgent: "", rawBody: "" }),
        media: [{ path: "/tmp/test-media.jpg", contentType: "image/jpeg" }],
      }),
    );
  });

  it("does not invent a mention for an attachment-only mention-required room", async () => {
    const coreRuntime = createPluginRuntimeMock();
    coreRuntime.channel.mentions.buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
    coreRuntime.channel.mentions.matchesMentionPatterns = vi.fn(() => false);
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("group");
    const runtime = createRuntimeEnv();
    const channelConfig = {
      rooms: { "room-group": { requireMention: true } },
    };

    await handleNextcloudTalkInbound({
      message: createMessage({
        roomToken: "room-group",
        roomName: "Ops",
        isGroupChat: true,
        text: "",
        attachment: {
          fileId: "9007",
          name: "receipt.pdf",
          mimeType: "application/pdf",
          declaredSizeBytes: 1_024,
          shareUrl: "https://cloud.example.com/s/redacted-share-token",
          hideDownload: false,
        },
      }),
      account: createAccount({
        config: {
          ...channelConfig,
          dmPolicy: "pairing",
          allowFrom: [],
          mediaAllowFrom: ["user-1"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["user-1"],
        },
      }),
      config: { channels: { "nextcloud-talk": channelConfig } } as CoreConfig,
      runtime,
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    expect(coreRuntime.channel.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("nextcloud-talk: drop room room-group (no mention)");
  });

  it("stages an attachment-only message in a mention-not-required room", async () => {
    const coreRuntime = createPluginRuntimeMock();
    coreRuntime.channel.mentions.buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
    coreRuntime.channel.mentions.matchesMentionPatterns = vi.fn(() => false);
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("group");
    const channelConfig = {
      rooms: { "room-group": { requireMention: false } },
    };

    await handleNextcloudTalkInbound({
      message: createMessage({
        roomToken: "room-group",
        roomName: "Ops",
        isGroupChat: true,
        text: "",
        attachment: {
          fileId: "9013",
          name: "receipt.pdf",
          mimeType: "application/pdf",
          declaredSizeBytes: 1_024,
          shareUrl: "https://cloud.example.com/s/redacted-share-token",
          hideDownload: false,
        },
      }),
      account: createAccount({
        config: {
          ...channelConfig,
          dmPolicy: "pairing",
          allowFrom: [],
          mediaAllowFrom: ["user-1"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["user-1"],
        },
      }),
      config: { channels: { "nextcloud-talk": channelConfig } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ bodyForAgent: "", rawBody: "", commandBody: "" }),
        media: [{ path: "/tmp/test-media.jpg", contentType: "image/jpeg" }],
      }),
    );
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary structured text authoritative outside file-share activities", async () => {
    const coreRuntime = createPluginRuntimeMock();
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    const structuredText = '{"message":"ordinary rich text","parameters":[]}';

    await handleNextcloudTalkInbound({
      message: createMessage({ text: structuredText }),
      account: createAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["user-1"],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          body: expect.stringContaining(structuredText),
          bodyForAgent: structuredText,
          rawBody: structuredText,
          commandBody: structuredText,
        }),
      }),
    );
    const contextInput = requireFirstMockArg(
      coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
      "Nextcloud Talk structured-text context",
    );
    expect(contextInput).not.toHaveProperty("media");
    expect(JSON.stringify(contextInput)).not.toContain("Nextcloud Talk attachment unavailable");
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("keeps a structured slash-command payload unchanged on the attachment branch", async () => {
    const coreRuntime = createPluginRuntimeMock();
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    const structuredCommand = '{"message":"/status","parameters":[]}';

    await handleNextcloudTalkInbound({
      message: createMessage({ text: structuredCommand }),
      account: createAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["user-1"],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          body: expect.stringContaining(structuredCommand),
          bodyForAgent: structuredCommand,
          rawBody: structuredCommand,
          commandBody: structuredCommand,
        }),
      }),
    );
    const contextInput = requireFirstMockArg(
      coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
      "Nextcloud Talk structured-command context",
    );
    expect(contextInput).not.toHaveProperty("media");
    expect(JSON.stringify(contextInput)).not.toContain("Nextcloud Talk attachment unavailable");
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("passes a successful staged image path and type into inbound context", async () => {
    const coreRuntime = createPluginRuntimeMock();
    (
      coreRuntime.channel.media.saveRemoteMedia as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      id: "camera-shot.png",
      path: "/tmp/camera-shot.png",
      size: 4_096,
      contentType: "image/png",
    });
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });

    await handleNextcloudTalkInbound({
      message: createMessage({
        text: "inspect this image",
        attachment: {
          fileId: "9010",
          name: "camera-shot.png",
          mimeType: "image/png",
          declaredSizeBytes: 4_096,
          shareUrl: "https://cloud.example.com/s/redacted-share-token",
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
      runtime: createRuntimeEnv(),
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        filePathHint: "camera-shot.png",
        fallbackContentType: "image/png",
        originalFilename: "camera-shot.png",
      }),
    );
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [{ path: "/tmp/camera-shot.png", contentType: "image/png" }],
      }),
    );
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("passes a successful staged PDF path and type into inbound context", async () => {
    const coreRuntime = createPluginRuntimeMock();
    (
      coreRuntime.channel.media.saveRemoteMedia as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      id: "receipt.pdf",
      path: "/tmp/receipt.pdf",
      size: 8_192,
      contentType: "application/pdf",
    });
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });

    await handleNextcloudTalkInbound({
      message: createMessage({
        text: "inspect this PDF",
        attachment: {
          fileId: "9011",
          name: "receipt.pdf",
          mimeType: "application/pdf",
          declaredSizeBytes: 8_192,
          shareUrl: "https://cloud.example.com/s/redacted-share-token",
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
      runtime: createRuntimeEnv(),
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        filePathHint: "receipt.pdf",
        fallbackContentType: "application/pdf",
        originalFilename: "receipt.pdf",
      }),
    );
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [{ path: "/tmp/receipt.pdf", contentType: "application/pdf" }],
      }),
    );
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("routes a native Talk audio-only MP4 voice message to the shared audio path", async () => {
    const coreRuntime = createPluginRuntimeMock();
    (
      coreRuntime.channel.media.saveRemoteMedia as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      id: "voice-note.mp3",
      path: "/tmp/voice-note.mp3",
      size: 12_288,
      contentType: "video/mp4",
    });
    resolveNextcloudTalkAuthenticatedMediaSourceMock.mockResolvedValueOnce({
      ok: true,
      url: "https://cloud.example.com/remote.php/dav/files/test-user/Talk/voice-note.mp3",
      origin: "https://cloud.example.com",
      hostname: "cloud.example.com",
      fileName: "voice-note.mp3",
      authorization: "Basic redacted-test-credential",
      contentTypeOverride: "audio/mp4",
    });
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });

    await handleNextcloudTalkInbound({
      message: createMessage({
        text: "voice note",
        attachment: {
          fileId: "9012",
          name: "voice-note.mp3",
          mimeType: "video/mp4",
          declaredSizeBytes: 12_288,
          shareUrl: "https://cloud.example.com/s/redacted-share-token",
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
      runtime: createRuntimeEnv(),
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        filePathHint: "voice-note.mp3",
        fallbackContentType: "audio/mp4",
        originalFilename: "voice-note.mp3",
      }),
    );
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        media: [{ path: "/tmp/voice-note.mp3", contentType: "audio/mp4" }],
      }),
    );
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "omitted", mediaAllowFrom: undefined },
    { label: "empty", mediaAllowFrom: [] },
    { label: "explicit nonmatch", mediaAllowFrom: ["other-user"] },
  ])(
    "logs $label media allowlist denial after normal admission without fetching",
    async ({ mediaAllowFrom }) => {
      const coreRuntime = createPluginRuntimeMock();
      setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
      createChannelPairingControllerMock.mockReturnValue({
        readStoreForDmPolicy: vi.fn(async () => []),
        issueChallenge: vi.fn(),
      });
      const runtime = createRuntimeEnv();

      await handleNextcloudTalkInbound({
        message: createMessage({
          text: "please inspect this receipt",
          attachment: {
            fileId: "9001",
            name: "receipt.pdf",
            mimeType: "application/pdf",
            declaredSizeBytes: 24_576,
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
        runtime,
      });

      expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith(
        "nextcloud-talk: inbound media non-outcome reason=media_sender_not_allowlisted account=default message=msg-1 sender=user-1",
      );
      expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            bodyForAgent: "please inspect this receipt",
            rawBody: "please inspect this receipt",
          }),
        }),
      );
      expect(
        requireFirstMockArg(
          coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
          "Nextcloud Talk buildContext call",
        ),
      ).not.toHaveProperty("media");
      expect(
        JSON.stringify(
          requireFirstMockArg(
            coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
            "Nextcloud Talk media-denied context",
          ),
        ),
      ).not.toContain("Nextcloud Talk attachment unavailable");
      expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { label: "omitted", mediaAllowFrom: undefined },
    { label: "empty", mediaAllowFrom: [] },
    { label: "explicit nonmatch", mediaAllowFrom: ["other-user"] },
  ])(
    "drops attachment-only media when the media allowlist is $label",
    async ({ mediaAllowFrom }) => {
      const coreRuntime = createPluginRuntimeMock();
      setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
      createChannelPairingControllerMock.mockReturnValue({
        readStoreForDmPolicy: vi.fn(async () => []),
        issueChallenge: vi.fn(),
      });
      const runtime = createRuntimeEnv();

      await handleNextcloudTalkInbound({
        message: createMessage({
          text: "",
          attachment: {
            fileId: "9001",
            name: "receipt.pdf",
            mimeType: "application/pdf",
            declaredSizeBytes: 24_576,
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
        runtime,
      });

      expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
      expect(runtime.log).toHaveBeenCalledWith(
        "nextcloud-talk: inbound media non-outcome reason=media_sender_not_allowlisted account=default message=msg-1 sender=user-1",
      );
      expect(coreRuntime.channel.inbound.buildContext).not.toHaveBeenCalled();
      expect(coreRuntime.channel.inbound.dispatch).not.toHaveBeenCalled();
      expect(coreRuntime.channel.inbound.dispatchReply).not.toHaveBeenCalled();
    },
  );

  it("rejects hide-download media before fetching", async () => {
    const coreRuntime = createPluginRuntimeMock();
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInbound({
      message: createMessage({
        text: "private receipt",
        attachment: {
          fileId: "9002",
          name: "private.pdf",
          mimeType: "application/pdf",
          declaredSizeBytes: 1_024,
          shareUrl: "https://cloud.example.com/s/redacted-share-token",
          hideDownload: true,
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
      "nextcloud-talk: inbound media non-outcome reason=media_hidden_download account=default message=msg-1 sender=user-1",
    );
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          body: expect.stringContaining("[Nextcloud Talk attachment unavailable]"),
          bodyForAgent: "private receipt\n\n[Nextcloud Talk attachment unavailable]",
          rawBody: "private receipt",
          commandBody: "private receipt",
        }),
      }),
    );
    expect(
      requireFirstMockArg(
        coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
        "Nextcloud Talk hidden-media context",
      ),
    ).not.toHaveProperty("media");
  });

  it("bounds missing attachment metadata before fetching", async () => {
    const coreRuntime = createPluginRuntimeMock();
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInbound({
      message: createMessage({
        text: "caption survives",
        attachmentIssue: "media_missing_metadata",
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
      "nextcloud-talk: inbound media non-outcome reason=media_missing_metadata account=default message=msg-1 sender=user-1",
    );
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          bodyForAgent: "caption survives\n\n[Nextcloud Talk attachment unavailable]",
          rawBody: "caption survives",
          commandBody: "caption survives",
        }),
      }),
    );
    expect(
      requireFirstMockArg(
        coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
        "Nextcloud Talk malformed-media context",
      ),
    ).not.toHaveProperty("media");
  });

  it("rejects declared oversize media before fetching", async () => {
    const coreRuntime = createPluginRuntimeMock();
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInbound({
      message: createMessage({
        text: "large receipt",
        attachment: {
          fileId: "9003",
          name: "large.pdf",
          mimeType: "application/pdf",
          declaredSizeBytes: 2 * 1024 * 1024,
          shareUrl: "https://cloud.example.com/s/redacted-share-token",
          hideDownload: false,
        },
      }),
      account: createAccount({
        config: {
          dmPolicy: "allowlist",
          allowFrom: ["user-1"],
          mediaAllowFrom: ["user-1"],
          mediaMaxMb: 1,
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
    });

    expect(coreRuntime.channel.media.saveRemoteMedia).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "nextcloud-talk: inbound media non-outcome reason=media_declared_oversize account=default message=msg-1 sender=user-1 sizeBytes=2097152 maxBytes=1048576",
    );
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          bodyForAgent: "large receipt\n\n[Nextcloud Talk attachment unavailable]",
          rawBody: "large receipt",
          commandBody: "large receipt",
        }),
      }),
    );
    expect(
      requireFirstMockArg(
        coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
        "Nextcloud Talk oversize-media context",
      ),
    ).not.toHaveProperty("media");
  });

  it("fails closed when the configured API account cannot resolve attachment access", async () => {
    resolveNextcloudTalkAuthenticatedMediaSourceMock.mockResolvedValueOnce({
      ok: false,
      reason: "media_auth_unavailable",
    });
    const coreRuntime = createPluginRuntimeMock();
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInbound({
      message: createMessage({
        text: "inspect this",
        attachment: {
          fileId: "9004",
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
      "nextcloud-talk: inbound media non-outcome reason=media_auth_unavailable account=default message=msg-1 sender=user-1",
    );
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          bodyForAgent: "inspect this\n\n[Nextcloud Talk attachment unavailable]",
          rawBody: "inspect this",
          commandBody: "inspect this",
        }),
      }),
    );
  });

  it.each([
    {
      label: "HTTP unavailable",
      error: new MediaFetchError(
        "http_error",
        "https://cloud.example.com/s/private-token returned secret-error-detail",
        { status: 404 },
      ),
      expectedLog:
        "nextcloud-talk: inbound media non-outcome reason=media_unavailable account=default message=msg-1 sender=user-1 status=404",
    },
    {
      label: "fetch timeout",
      error: new MediaFetchError(
        "fetch_failed",
        "timeout reading https://cloud.example.com/s/private-token secret-error-detail",
      ),
      expectedLog:
        "nextcloud-talk: inbound media non-outcome reason=media_fetch_failed account=default message=msg-1 sender=user-1",
    },
    {
      label: "staging failure",
      error: new Error("stage failed for private-token with secret-error-detail"),
      expectedLog:
        "nextcloud-talk: inbound media non-outcome reason=media_stage_failed account=default message=msg-1 sender=user-1",
    },
  ])("preserves caption and bounded diagnostics for $label", async ({ error, expectedLog }) => {
    const coreRuntime = createPluginRuntimeMock();
    (
      coreRuntime.channel.media.saveRemoteMedia as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(error);
    setNextcloudTalkRuntime(coreRuntime as unknown as PluginRuntime);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInbound({
      message: createMessage({
        text: "inspect this sensitive receipt",
        attachment: {
          fileId: "9009",
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
          mediaAllowFrom: ["user-1"],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledWith(expectedLog);
    const serializedLogs = JSON.stringify(
      (runtime.log as unknown as ReturnType<typeof vi.fn>).mock.calls,
    );
    expect(serializedLogs).not.toContain("private-token");
    expect(serializedLogs).not.toContain("secret-error-detail");
    expect(serializedLogs).not.toContain("inspect this sensitive receipt");
    expect(coreRuntime.channel.inbound.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          bodyForAgent: "inspect this sensitive receipt\n\n[Nextcloud Talk attachment unavailable]",
          rawBody: "inspect this sensitive receipt",
          commandBody: "inspect this sensitive receipt",
        }),
      }),
    );
    expect(
      requireFirstMockArg(
        coreRuntime.channel.inbound.buildContext as ReturnType<typeof vi.fn>,
        "Nextcloud Talk failed-media context",
      ),
    ).not.toHaveProperty("media");
    expect(coreRuntime.channel.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });
});
