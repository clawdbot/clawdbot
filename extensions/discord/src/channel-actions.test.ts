// Discord tests cover channel actions plugin behavior.
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";

const handleDiscordMessageActionMock = vi.hoisted(() =>
  vi.fn(async () => ({ content: [], details: { ok: true } })),
);

const handleActionModule = await import("./actions/handle-action.js");
vi.spyOn(handleActionModule, "handleDiscordMessageAction").mockImplementation(
  handleDiscordMessageActionMock,
);
const { discordMessageActions } = await import("./channel-actions.js");

type DiscordDiscovery = ReturnType<NonNullable<typeof discordMessageActions.describeMessageTool>>;
function schemaForAction(discovery: DiscordDiscovery, action: string) {
  const schema = discovery?.schema;
  return (Array.isArray(schema) ? schema : schema ? [schema] : []).find((entry) =>
    entry.actions?.some((candidate) => candidate === action),
  );
}

describe("discordMessageActions", () => {
  it("returns no tool actions when no token-sourced Discord accounts are enabled", () => {
    withEnv({ DISCORD_BOT_TOKEN: undefined }, () => {
      const discovery = discordMessageActions.describeMessageTool?.({
        cfg: {
          channels: {
            discord: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
      });

      expect(discovery).toEqual({
        actions: [],
        capabilities: [],
        schema: null,
      });
    });
  });

  it("describes enabled Discord actions for token-backed accounts", () => {
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: {
        channels: {
          discord: {
            token: "Bot token-main",
            actions: {
              polls: true,
              reactions: true,
              permissions: true,
              channels: false,
              roles: false,
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(discovery?.capabilities).toEqual(["presentation"]);
    expect(discovery?.actions).toEqual([
      "send",
      "poll",
      "react",
      "reactions",
      "emoji-list",
      "upload-file",
      "read",
      "edit",
      "delete",
      "pin",
      "unpin",
      "list-pins",
      "permissions",
      "thread-create",
      "thread-list",
      "thread-reply",
      "search",
      "sticker",
      "member-info",
      "role-info",
      "emoji-upload",
      "sticker-upload",
      "channel-info",
      "channel-list",
      "voice-status",
      "event-list",
      "event-create",
    ]);
  });

  it("describes actions when the Discord token is an unresolved SecretRef", () => {
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: {
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
            actions: {
              polls: true,
              reactions: true,
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(discovery?.capabilities).toEqual(["presentation"]);
    expect(discovery?.actions).toEqual([
      "send",
      "poll",
      "react",
      "reactions",
      "emoji-list",
      "upload-file",
      "read",
      "edit",
      "delete",
      "pin",
      "unpin",
      "list-pins",
      "permissions",
      "thread-create",
      "thread-list",
      "thread-reply",
      "search",
      "sticker",
      "member-info",
      "role-info",
      "emoji-upload",
      "sticker-upload",
      "channel-info",
      "channel-list",
      "channel-create",
      "channel-edit",
      "channel-delete",
      "channel-move",
      "category-create",
      "category-edit",
      "category-delete",
      "voice-status",
      "event-list",
      "event-create",
    ]);
  });

  it("requires trusted requester sender for privileged guild admin actions from tool contexts", () => {
    for (const action of ["channel-delete", "timeout", "kick", "ban"] as const) {
      expect(
        discordMessageActions.requiresTrustedRequesterSender?.({
          action,
          toolContext: { currentChannelProvider: "discord" },
        }),
      ).toBe(true);
      expect(
        discordMessageActions.requiresTrustedRequesterSender?.({
          action,
        }),
      ).toBe(false);
    }
    expect(
      discordMessageActions.requiresTrustedRequesterSender?.({
        action: "channel-delete",
        toolContext: { currentChannelProvider: "telegram" },
      }),
    ).toBe(true);
    expect(
      discordMessageActions.requiresTrustedRequesterSender?.({
        action: "read",
        toolContext: { currentChannelProvider: "discord" },
      }),
    ).toBe(false);
  });

  it("describes scoped account actions when only the account token is an unresolved SecretRef", () => {
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: {
        channels: {
          discord: {
            actions: {
              polls: true,
              reactions: false,
            },
            accounts: {
              ops: {
                token: { source: "file", provider: "filemain", id: "/DISCORD_BOT_TOKEN" },
                actions: {
                  polls: false,
                  reactions: true,
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      accountId: "ops",
    });

    expect(discovery?.actions).toEqual([
      "send",
      "react",
      "reactions",
      "emoji-list",
      "upload-file",
      "read",
      "edit",
      "delete",
      "pin",
      "unpin",
      "list-pins",
      "permissions",
      "thread-create",
      "thread-list",
      "thread-reply",
      "search",
      "sticker",
      "member-info",
      "role-info",
      "emoji-upload",
      "sticker-upload",
      "channel-info",
      "channel-list",
      "channel-create",
      "channel-edit",
      "channel-delete",
      "channel-move",
      "category-create",
      "category-edit",
      "category-delete",
      "voice-status",
      "event-list",
      "event-create",
    ]);
  });

  it("honors account-scoped action gates during discovery", () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot token-main",
          actions: {
            reactions: false,
            polls: true,
          },
          accounts: {
            work: {
              token: "Bot token-work",
              actions: {
                reactions: true,
                polls: false,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const defaultDiscovery = discordMessageActions.describeMessageTool?.({
      cfg,
      accountId: "default",
    });
    const workDiscovery = discordMessageActions.describeMessageTool?.({
      cfg,
      accountId: "work",
    });

    expect(defaultDiscovery?.actions).toEqual([
      "send",
      "poll",
      "upload-file",
      "read",
      "edit",
      "delete",
      "pin",
      "unpin",
      "list-pins",
      "permissions",
      "thread-create",
      "thread-list",
      "thread-reply",
      "search",
      "sticker",
      "member-info",
      "role-info",
      "emoji-upload",
      "sticker-upload",
      "channel-info",
      "channel-list",
      "channel-create",
      "channel-edit",
      "channel-delete",
      "channel-move",
      "category-create",
      "category-edit",
      "category-delete",
      "voice-status",
      "event-list",
      "event-create",
    ]);
    expect(workDiscovery?.actions).toEqual([
      "send",
      "react",
      "reactions",
      "emoji-list",
      "upload-file",
      "read",
      "edit",
      "delete",
      "pin",
      "unpin",
      "list-pins",
      "permissions",
      "thread-create",
      "thread-list",
      "thread-reply",
      "search",
      "sticker",
      "member-info",
      "role-info",
      "emoji-upload",
      "sticker-upload",
      "channel-info",
      "channel-list",
      "channel-create",
      "channel-edit",
      "channel-delete",
      "channel-move",
      "category-create",
      "category-edit",
      "category-delete",
      "voice-status",
      "event-list",
      "event-create",
    ]);
    expect(schemaForAction(defaultDiscovery, "send")).toMatchObject({
      actions: ["send"],
      properties: {
        components: { description: expect.stringContaining("Discord Components V2") },
      },
    });
    expect(schemaForAction(workDiscovery, "react")).toMatchObject({
      actions: expect.arrayContaining(["react", "reactions"]),
      properties: {
        emoji: { description: expect.stringContaining('action:"emoji-list"') },
      },
    });
    expect(schemaForAction(workDiscovery, "send")).toMatchObject({
      actions: ["send"],
      visibility: "all-configured",
      properties: {
        components: { description: expect.stringContaining("Discord Components V2") },
      },
    });
  });

  it("hides upload-file when Discord message actions are disabled", () => {
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: {
        channels: {
          discord: {
            token: "Bot token-main",
            actions: {
              messages: false,
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(discovery?.actions).toContain("send");
    expect(discovery?.actions).not.toContain("upload-file");
    expect(discovery?.actions).not.toContain("read");
    expect(discovery?.actions).not.toContain("edit");
    expect(schemaForAction(discovery, "send")).toMatchObject({
      actions: ["send"],
      properties: {
        components: { description: expect.stringContaining("Discord Components V2") },
      },
    });
  });

  it("describes usable custom emoji formats and available server emoji discovery", () => {
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: {
        channels: {
          discord: {
            token: "Bot token-main",
          },
        },
      } as OpenClawConfig,
    });
    expect(schemaForAction(discovery, "react")).toMatchObject({
      actions: ["react", "reactions"],
      properties: {
        emoji: {
          description: expect.stringMatching(
            /Unicode.*name:id.*<:name:id>.*<a:name:id>.*emoji-list/,
          ),
        },
      },
    });
    expect(schemaForAction(discovery, "send")).toMatchObject({
      actions: ["send"],
      properties: {
        components: {
          description: expect.stringContaining("Discord Components V2"),
          properties: {
            blocks: { type: "array" },
            modal: { type: "object" },
          },
        },
      },
    });
  });

  it.each(["read", "search", "edit", "delete", "react", "pin", "channel-info"])(
    "routes %s actions through gateway execution mode",
    (action) => {
      expect(discordMessageActions.resolveExecutionMode?.({ action: action as never })).toBe(
        "gateway",
      );
    },
  );

  it.each([
    "send",
    "poll",
    "upload-file",
    "thread-reply",
    "sticker",
    "emoji-upload",
    "sticker-upload",
    "event-create",
  ])("keeps %s on local execution mode", (action) => {
    expect(discordMessageActions.resolveExecutionMode?.({ action: action as never })).toBe("local");
  });

  it("extracts send targets for message and thread reply actions", () => {
    expect(
      discordMessageActions.extractToolSend?.({
        args: { action: "sendMessage", to: "channel:123" },
      }),
    ).toEqual({ to: "channel:123" });

    expect(
      discordMessageActions.extractToolSend?.({
        args: { action: "threadReply", channelId: "987" },
      }),
    ).toEqual({ to: "channel:987" });

    expect(
      discordMessageActions.extractToolSend?.({
        args: { action: "threadReply", channelId: "   " },
      }),
    ).toBeNull();
  });

  it("prepares Discord send payload channel data for durable core delivery", async () => {
    const prepared = await discordMessageActions.prepareSendPayload?.({
      ctx: {
        channel: "discord",
        action: "send",
        cfg: {} as OpenClawConfig,
        params: {
          components: JSON.stringify({
            text: "Choose",
            blocks: [
              {
                type: "actions",
                buttons: [{ label: "Yes", callbackData: "yes" }],
              },
            ],
          }),
          embeds: undefined,
          filename: "photo.png",
        },
      },
      to: "channel:123",
      payload: { text: "hello", mediaUrl: "/tmp/photo.png" },
    });

    expect(prepared).toEqual({
      text: "hello",
      mediaUrl: "/tmp/photo.png",
      channelData: {
        discord: {
          components: {
            text: "Choose",
            blocks: [
              {
                type: "actions",
                buttons: [{ label: "Yes", callbackData: "yes" }],
              },
            ],
          },
          filename: "photo.png",
        },
      },
    });
  });

  it("prepares inbound event delivery metadata for durable core sends", async () => {
    const prepared = await discordMessageActions.prepareSendPayload?.({
      ctx: {
        channel: "discord",
        action: "send",
        cfg: {} as OpenClawConfig,
        params: {},
        sessionKey: "agent:main:discord:channel:c1",
        inboundEventKind: "room_event",
      },
      to: "channel:123",
      payload: { text: "hello" },
    });

    expect(prepared).toEqual({
      text: "hello",
      channelData: {
        discord: {
          __openclawInboundEventDelivery: {
            sessionKey: "agent:main:discord:channel:c1",
            inboundEventKind: "room_event",
          },
        },
      },
    });
  });

  it("keeps non-serializable Discord component sends on the legacy action path", async () => {
    const prepared = await discordMessageActions.prepareSendPayload?.({
      ctx: {
        channel: "discord",
        action: "send",
        cfg: {} as OpenClawConfig,
        params: {
          components: () => [],
        },
      },
      to: "channel:123",
      payload: { text: "hello" },
    });

    expect(prepared).toBeNull();
  });

  it("delegates action handling to the Discord action handler", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "Bot token-main",
        },
      },
    } as OpenClawConfig;
    const toolContext: ChannelMessageActionContext["toolContext"] = {
      currentChannelProvider: "discord",
    };
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const mediaAccess: NonNullable<ChannelMessageActionContext["mediaAccess"]> = {
      localRoots: ["/tmp/media"],
      readFile: mediaReadFile,
    };
    const mediaLocalRoots = ["/tmp/media"];
    const reply = {
      source: "implicit" as const,
      replyToId: "source-message-1",
      mode: "first" as const,
    };

    await discordMessageActions.handleAction?.({
      channel: "discord",
      action: "send",
      params: { to: "channel:123", message: "hello" },
      cfg,
      accountId: "ops",
      requesterAccountId: "ops",
      requesterSenderId: "user-1",
      senderIsOwner: true,
      toolContext,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      conversationReadOrigin: "delegated",
      reply,
    });

    expect(handleDiscordMessageActionMock).toHaveBeenCalledWith({
      action: "send",
      params: { to: "channel:123", message: "hello" },
      cfg,
      accountId: "ops",
      requesterAccountId: "ops",
      requesterSenderId: "user-1",
      senderIsOwner: true,
      toolContext,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      conversationReadOrigin: "delegated",
      reply,
    });
  });
});
