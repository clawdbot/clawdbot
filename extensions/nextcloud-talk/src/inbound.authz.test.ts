// Nextcloud Talk tests cover inbound.authz plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

function installInboundAuthzRuntime(params: {
  readAllowFromStore: () => Promise<string[]>;
  buildMentionRegexes: () => RegExp[];
}) {
  const saveRemoteMedia = vi.fn();
  setNextcloudTalkRuntime({
    channel: {
      media: {
        saveRemoteMedia,
      },
      pairing: {
        readAllowFromStore: params.readAllowFromStore,
      },
      commands: {
        shouldHandleTextCommands: () => false,
      },
      text: {
        hasControlCommand: () => false,
      },
      mentions: {
        buildMentionRegexes: params.buildMentionRegexes,
        matchesMentionPatterns: () => false,
      },
    },
  } as unknown as PluginRuntime);
  return { saveRemoteMedia };
}

function createTestRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

const TEST_ATTACHMENT = {
  fileId: "9001",
  name: "receipt.pdf",
  mimeType: "application/pdf",
  declaredSizeBytes: 1_024,
  shareUrl: "https://cloud.example.com/s/redacted-share-token",
  hideDownload: false,
} as const;

describe("nextcloud-talk inbound authz", () => {
  it("does not treat DM pairing-store entries as group allowlist entries", async () => {
    const readAllowFromStore = vi.fn(async () => ["attacker"]);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);

    const { saveRemoteMedia } = installInboundAuthzRuntime({
      readAllowFromStore,
      buildMentionRegexes,
    });

    const message: NextcloudTalkInboundMessage = {
      messageId: "m-1",
      roomToken: "room-1",
      roomName: "Room 1",
      senderId: "attacker",
      senderName: "Attacker",
      text: "hello",
      mediaType: "text/plain",
      timestamp: Date.now(),
      isGroupChat: true,
      attachment: TEST_ATTACHMENT,
    };

    const account: ResolvedNextcloudTalkAccount = {
      accountId: "default",
      enabled: true,
      baseUrl: "https://cloud.example.com",
      secret: "",
      secretSource: "none", // pragma: allowlist secret
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "allowlist",
        groupAllowFrom: [],
        mediaAllowFrom: ["*"],
      },
    };

    const config: CoreConfig = {
      channels: {
        "nextcloud-talk": {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      },
    };

    await handleNextcloudTalkInbound({
      message,
      account,
      config,
      runtime: createTestRuntimeEnv(),
    });

    expect(readAllowFromStore).not.toHaveBeenCalled();
    expect(buildMentionRegexes).not.toHaveBeenCalled();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });

  it("matches group rooms by token instead of colliding room names", async () => {
    const readAllowFromStore = vi.fn(async () => []);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);

    const { saveRemoteMedia } = installInboundAuthzRuntime({
      readAllowFromStore,
      buildMentionRegexes,
    });

    const message: NextcloudTalkInboundMessage = {
      messageId: "m-2",
      roomToken: "room-attacker",
      roomName: "Room Trusted",
      senderId: "trusted-user",
      senderName: "Trusted User",
      text: "hello",
      mediaType: "text/plain",
      timestamp: Date.now(),
      isGroupChat: true,
      attachment: TEST_ATTACHMENT,
    };

    const account: ResolvedNextcloudTalkAccount = {
      accountId: "default",
      enabled: true,
      baseUrl: "https://cloud.example.com",
      secret: "",
      secretSource: "none",
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "allowlist",
        groupAllowFrom: ["trusted-user"],
        mediaAllowFrom: ["*"],
        rooms: {
          "room-trusted": {
            enabled: true,
          },
        },
      },
    };

    await handleNextcloudTalkInbound({
      message,
      account,
      config: {
        channels: {
          "nextcloud-talk": {
            groupPolicy: "allowlist",
            groupAllowFrom: ["trusted-user"],
          },
        },
      },
      runtime: createTestRuntimeEnv(),
    });

    expect(buildMentionRegexes).not.toHaveBeenCalled();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });

  it("does not fetch media for a disabled room", async () => {
    const readAllowFromStore = vi.fn(async () => []);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
    const { saveRemoteMedia } = installInboundAuthzRuntime({
      readAllowFromStore,
      buildMentionRegexes,
    });

    await handleNextcloudTalkInbound({
      message: {
        messageId: "m-3",
        roomToken: "room-disabled",
        roomName: "Disabled Room",
        senderId: "trusted-user",
        senderName: "Trusted User",
        text: "@openclaw inspect this",
        mediaType: "text/plain",
        timestamp: Date.now(),
        isGroupChat: true,
        attachment: TEST_ATTACHMENT,
      },
      account: {
        accountId: "default",
        enabled: true,
        baseUrl: "https://cloud.example.com",
        secret: "",
        secretSource: "none",
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: ["trusted-user"],
          mediaAllowFrom: ["*"],
          rooms: { "room-disabled": { enabled: false } },
        },
      },
      config: {
        channels: {
          "nextcloud-talk": {
            groupPolicy: "allowlist",
            groupAllowFrom: ["trusted-user"],
            rooms: { "room-disabled": { enabled: false } },
          },
        },
      },
      runtime: createTestRuntimeEnv(),
    });

    expect(buildMentionRegexes).not.toHaveBeenCalled();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });

  it("does not fetch media for a sender denied by the nested room allowlist", async () => {
    const readAllowFromStore = vi.fn(async () => []);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);
    const { saveRemoteMedia } = installInboundAuthzRuntime({
      readAllowFromStore,
      buildMentionRegexes,
    });

    await handleNextcloudTalkInbound({
      message: {
        messageId: "m-4",
        roomToken: "room-locked",
        roomName: "Locked Room",
        senderId: "blocked-user",
        senderName: "Blocked User",
        text: "@openclaw inspect this",
        mediaType: "text/plain",
        timestamp: Date.now(),
        isGroupChat: true,
        attachment: TEST_ATTACHMENT,
      },
      account: {
        accountId: "default",
        enabled: true,
        baseUrl: "https://cloud.example.com",
        secret: "",
        secretSource: "none",
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          mediaAllowFrom: ["*"],
          rooms: { "room-locked": { allowFrom: ["trusted-user"] } },
        },
      },
      config: {
        channels: {
          "nextcloud-talk": {
            groupPolicy: "allowlist",
            groupAllowFrom: [],
            rooms: { "room-locked": { allowFrom: ["trusted-user"] } },
          },
        },
      },
      runtime: createTestRuntimeEnv(),
    });

    expect(buildMentionRegexes).not.toHaveBeenCalled();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });
});
