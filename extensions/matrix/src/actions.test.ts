import { beforeEach, describe, expect, it } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { matrixMessageActions } from "./actions.js";
import { setMatrixRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

const profileAction = "set-profile" as const;

const runtimeStub = {
  config: {
    current: () => ({}),
  },
  media: {
    loadWebMedia: async () => {
      throw new Error("not used");
    },
    mediaKindFromMime: () => "image",
    isVoiceCompatibleAudio: () => false,
    getImageMetadata: async () => null,
    resizeToJpeg: async () => Buffer.from(""),
  },
  state: {
    resolveStateDir: () => "/tmp/openclaw-matrix-test",
  },
  channel: {
    text: {
      resolveTextChunkLimit: () => 4000,
      resolveChunkMode: () => "length",
      chunkMarkdownText: (text: string) => (text ? [text] : []),
      chunkMarkdownTextWithMode: (text: string) => (text ? [text] : []),
      resolveMarkdownTableMode: () => "code",
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

function createConfiguredMatrixConfig(): CoreConfig {
  return {
    channels: {
      matrix: {
        enabled: true,
        homeserver: "https://matrix.example.org",
        userId: "@bot:example.org",
        accessToken: "token",
      },
    },
  } as CoreConfig;
}

describe("matrixMessageActions", () => {
  beforeEach(() => {
    setMatrixRuntime(runtimeStub);
  });

  it("exposes poll create but only handles poll votes inside the plugin", () => {
    const describeMessageTool = matrixMessageActions.describeMessageTool;
    const supportsAction = matrixMessageActions.supportsAction ?? (() => false);

    expect(describeMessageTool).toBeTypeOf("function");
    expect(supportsAction).toBeTypeOf("function");

    const discovery = describeMessageTool({
      cfg: createConfiguredMatrixConfig(),
    } as never);
    if (!discovery) {
      throw new Error("describeMessageTool returned null");
    }
    const actions = discovery.actions;
    expect(actions).toContain("poll");
    expect(actions).toContain("poll-vote");
    expect(supportsAction({ action: "poll" } as never)).toBe(false);
    expect(supportsAction({ action: "poll-vote" } as never)).toBe(true);
  });

  it("exposes and describes self-profile updates", () => {
    const describeMessageTool = matrixMessageActions.describeMessageTool;
    const supportsAction = matrixMessageActions.supportsAction ?? (() => false);

    const discovery = describeMessageTool({
      cfg: createConfiguredMatrixConfig(),
      senderIsOwner: true,
    } as never);
    if (!discovery) {
      throw new Error("describeMessageTool returned null");
    }
    const actions = discovery.actions;
    const schema = discovery.schema;
    if (!schema) {
      throw new Error("matrix schema missing");
    }
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};

    expect(actions).toContain(profileAction);
    expect(supportsAction({ action: profileAction } as never)).toBe(true);
    expect(discovery.mediaSourceParams).toEqual({
      "set-profile": ["avatarUrl", "avatarPath"],
    });
    expect(Object.keys(properties).toSorted()).toEqual([
      "avatarPath",
      "avatarUrl",
      "avatar_path",
      "avatar_url",
      "displayName",
      "display_name",
    ]);
    expect(properties.displayName).toHaveProperty("type", "string");
    expect(properties.avatarUrl).toHaveProperty("type", "string");
    expect(properties.avatarPath).toHaveProperty("type", "string");
  });

  it("hides self-profile updates for non-owner discovery", () => {
    const discovery = matrixMessageActions.describeMessageTool({
      cfg: createConfiguredMatrixConfig(),
      senderIsOwner: false,
    } as never);
    if (!discovery) {
      throw new Error("describeMessageTool returned null");
    }

    expect(discovery.actions).not.toContain(profileAction);
    expect(discovery.schema).toBeNull();
  });

  it("hides self-profile updates when owner status is unknown", () => {
    const discovery = matrixMessageActions.describeMessageTool({
      cfg: createConfiguredMatrixConfig(),
    } as never);
    if (!discovery) {
      throw new Error("describeMessageTool returned null");
    }

    expect(discovery.actions).not.toContain(profileAction);
    expect(discovery.schema).toBeNull();
  });

  it("hides gated actions when the default Matrix account disables them", () => {
    const discovery = matrixMessageActions.describeMessageTool({
      cfg: {
        channels: {
          matrix: {
            defaultAccount: "assistant",
            actions: {
              messages: true,
              reactions: true,
              pins: true,
              profile: true,
              memberInfo: true,
              channelInfo: true,
              verification: true,
            },
            accounts: {
              assistant: {
                homeserver: "https://matrix.example.org",
                userId: "@bot:example.org",
                accessToken: "token",
                encryption: true,
                actions: {
                  messages: false,
                  reactions: false,
                  pins: false,
                  profile: false,
                  memberInfo: false,
                  channelInfo: false,
                  verification: false,
                },
              },
            },
          },
        },
      } as CoreConfig,
    } as never);
    if (!discovery) {
      throw new Error("describeMessageTool returned null");
    }
    const actions = discovery.actions;

    expect(actions).toEqual(["poll", "poll-vote"]);
  });

  it("hides actions until defaultAccount is set for ambiguous multi-account configs", () => {
    const discovery = matrixMessageActions.describeMessageTool({
      cfg: {
        channels: {
          matrix: {
            accounts: {
              assistant: {
                homeserver: "https://matrix.example.org",
                accessToken: "assistant-token",
              },
              ops: {
                homeserver: "https://matrix.example.org",
                accessToken: "ops-token",
              },
            },
          },
        },
      } as CoreConfig,
    } as never);
    if (!discovery) {
      throw new Error("describeMessageTool returned null");
    }
    const actions = discovery.actions;

    expect(actions).toStrictEqual([]);
  });

  it("honors the selected Matrix account during discovery", () => {
    const cfg = {
      channels: {
        matrix: {
          defaultAccount: "assistant",
          accounts: {
            assistant: {
              homeserver: "https://matrix.example.org",
              userId: "@assistant:example.org",
              accessToken: "assistant-token",
              actions: {
                messages: true,
                reactions: false,
              },
            },
            ops: {
              homeserver: "https://matrix.example.org",
              userId: "@ops:example.org",
              accessToken: "ops-token",
              actions: {
                messages: true,
                reactions: true,
              },
            },
          },
        },
      },
    } as CoreConfig;

    const describeMessageTool = matrixMessageActions.describeMessageTool;
    if (!describeMessageTool) {
      throw new Error("matrix message action discovery is unavailable");
    }

    const assistantDiscovery = describeMessageTool({
      cfg,
      accountId: "assistant",
    } as never);
    const opsDiscovery = describeMessageTool({
      cfg,
      accountId: "ops",
    } as never);

    if (!assistantDiscovery || !opsDiscovery) {
      throw new Error("matrix action discovery returned null");
    }

    const assistantActions = assistantDiscovery.actions;
    const opsActions = opsDiscovery.actions;

    expect(assistantActions).not.toContain("react");
    expect(assistantActions).not.toContain("reactions");
    expect(opsActions).toContain("react");
    expect(opsActions).toContain("reactions");
  });
});
