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
  setNextcloudTalkRuntime({
    channel: {
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
}

function createTestRuntimeEnv(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("nextcloud-talk inbound authz", () => {
  it("does not treat DM pairing-store entries as group allowlist entries", async () => {
    const readAllowFromStore = vi.fn(async () => ["attacker"]);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);

    installInboundAuthzRuntime({ readAllowFromStore, buildMentionRegexes });

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
    };

    const account: ResolvedNextcloudTalkAccount = {
      accountId: "default",
      enabled: true,
      baseUrl: "",
      secret: "",
      secretSource: "none", // pragma: allowlist secret
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "allowlist",
        groupAllowFrom: [],
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
  });

  it("matches group rooms by token instead of colliding room names", async () => {
    const readAllowFromStore = vi.fn(async () => []);
    const buildMentionRegexes = vi.fn(() => [/@openclaw/i]);

    installInboundAuthzRuntime({ readAllowFromStore, buildMentionRegexes });

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
    };

    const account: ResolvedNextcloudTalkAccount = {
      accountId: "default",
      enabled: true,
      baseUrl: "",
      secret: "",
      secretSource: "none",
      config: {
        dmPolicy: "pairing",
        allowFrom: [],
        groupPolicy: "allowlist",
        groupAllowFrom: ["trusted-user"],
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
  });
});
