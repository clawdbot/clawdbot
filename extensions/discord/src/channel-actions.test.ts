import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
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
    expect(discovery?.schema).toBeUndefined();
    expect(discovery?.actions).toEqual(
      expect.arrayContaining([
        "send",
        "upload-file",
        "poll",
        "react",
        "reactions",
        "emoji-list",
        "permissions",
      ]),
    );
    expect(discovery?.actions).not.toContain("channel-create");
    expect(discovery?.actions).not.toContain("role-add");
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
    expect(discovery?.actions).toEqual(
      expect.arrayContaining(["send", "poll", "react", "reactions", "emoji-list"]),
    );
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

    expect(discovery?.actions).toEqual(
      expect.arrayContaining(["send", "react", "reactions", "emoji-list"]),
    );
    expect(discovery?.actions).not.toContain("poll");
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

    expect(defaultDiscovery?.actions).toEqual(expect.arrayContaining(["send", "poll"]));
    expect(defaultDiscovery?.actions).toContain("upload-file");
    expect(defaultDiscovery?.actions).not.toContain("react");
    expect(workDiscovery?.actions).toEqual(
      expect.arrayContaining(["send", "upload-file", "react", "reactions", "emoji-list"]),
    );
    expect(workDiscovery?.actions).not.toContain("poll");
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
    expect(discovery?.actions).not.toContain("delete");
  });

  it("does not expose Discord-native message tool schema", () => {
    const discovery = discordMessageActions.describeMessageTool?.({
      cfg: {
        channels: {
          discord: {
            token: "Bot token-main",
          },
        },
      } as OpenClawConfig,
    });
    expect(discovery?.schema).toBeUndefined();
  });

  it.each(["read", "search"])("routes %s actions through gateway execution mode", (action) => {
    expect(discordMessageActions.resolveExecutionMode?.({ action: action as never })).toBe(
      "gateway",
    );
  });

  it.each(["send", "upload-file", "edit", "delete", "react", "pin", "poll"])(
    "routes %s actions through local execution mode",
    (action) => {
      expect(discordMessageActions.resolveExecutionMode?.({ action: action as never })).toBe(
        "local",
      );
    },
  );

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

    await discordMessageActions.handleAction?.({
      channel: "discord",
      action: "send",
      params: { to: "channel:123", message: "hello" },
      cfg,
      accountId: "ops",
      requesterSenderId: "user-1",
      toolContext,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
    });

    expect(handleDiscordMessageActionMock).toHaveBeenCalledWith({
      action: "send",
      params: { to: "channel:123", message: "hello" },
      cfg,
      accountId: "ops",
      requesterSenderId: "user-1",
      toolContext,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
    });
  });
});
