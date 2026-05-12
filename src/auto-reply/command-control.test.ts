import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import { hasControlCommand, hasInlineCommandTokens } from "./command-detection.js";
import { listChatCommands } from "./commands-registry.js";
import { parseActivationCommand } from "./group-activation.js";
import { parseSendPolicyCommand } from "./send-policy.js";
import type { MsgContext } from "./templating.js";
import { installDiscordRegistryHooks } from "./test-helpers/command-auth-registry-fixture.js";

installDiscordRegistryHooks();

describe("resolveCommandAuthorization", () => {
  const formatAllowFrom = ({ allowFrom }: { allowFrom: Array<string | number> }) => {
    const values: string[] = [];
    for (const entry of allowFrom) {
      const value = String(entry).trim();
      if (value) {
        values.push(value);
      }
    }
    return values;
  };

  function createAllowFromPlugin(
    id: string,
    resolveAllowFrom: () => Array<string | number> | undefined,
  ) {
    return {
      pluginId: id,
      plugin: {
        ...createOutboundTestPlugin({
          id,
          outbound: { deliveryMode: "direct" },
        }),
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          resolveAllowFrom,
          formatAllowFrom,
        },
      },
      source: "test" as const,
    };
  }

  function createThrowingAllowFromPlugin(id: string, error: string) {
    return createAllowFromPlugin(id, () => {
      throw new Error(error);
    });
  }

  function createOwnerEnforcingAllowFromPlugin(
    id: string,
    resolveAllowFrom: () => Array<string | number> | undefined,
  ) {
    const entry = createAllowFromPlugin(id, resolveAllowFrom);
    return {
      ...entry,
      plugin: {
        ...entry.plugin,
        commands: { enforceOwnerForCommands: true },
      },
    };
  }

  function registerAllowFromPlugins(...plugins: ReturnType<typeof createAllowFromPlugin>[]) {
    setActivePluginRegistry(createTestRegistry(plugins));
  }

  function resolveTestChannelAuthorization(params: {
    from: string;
    senderId?: string;
    senderE164?: string;
    allowFrom: string[];
  }) {
    registerAllowFromPlugins(createAllowFromPlugin("mobilechat", () => params.allowFrom));
    const cfg = {
      channels: { mobilechat: { allowFrom: params.allowFrom } },
    } as OpenClawConfig;
    const ctx = {
      Provider: "mobilechat",
      Surface: "mobilechat",
      From: params.from,
      SenderId: params.senderId,
      SenderE164: params.senderE164,
    } as MsgContext;
    return resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });
  }

  it.each([
    {
      name: "falls back from empty SenderId to SenderE164",
      from: "mobilechat:+999",
      senderId: "",
      senderE164: "+123",
      allowFrom: ["+123"],
      expectedSenderId: "+123",
    },
    {
      name: "falls back from whitespace SenderId to SenderE164",
      from: "mobilechat:+999",
      senderId: "   ",
      senderE164: "+123",
      allowFrom: ["+123"],
      expectedSenderId: "+123",
    },
    {
      name: "falls back to From when SenderId and SenderE164 are whitespace",
      from: "+999",
      senderId: "   ",
      senderE164: "   ",
      allowFrom: ["+999"],
      expectedSenderId: "+999",
    },
    {
      name: "falls back from un-normalizable SenderId to SenderE164",
      from: "mobilechat:+999",
      senderId: "wat",
      senderE164: "+123",
      allowFrom: ["+123"],
      expectedSenderId: "+123",
    },
    {
      name: "prefers SenderE164 when SenderId does not match allowFrom",
      from: "mobilechat:group:room-1",
      senderId: "opaque-user",
      senderE164: "+41796666864",
      allowFrom: ["+41796666864"],
      expectedSenderId: "+41796666864",
    },
  ])("$name", ({ from, senderId, senderE164, allowFrom, expectedSenderId }) => {
    const auth = resolveTestChannelAuthorization({
      from,
      senderId,
      senderE164,
      allowFrom,
    });

    expect(auth.senderId).toBe(expectedSenderId);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("uses explicit owner allowlist when allowFrom is wildcard", () => {
    const cfg = {
      commands: { ownerAllowFrom: ["whatsapp:+15551234567"] },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;

    const ownerCtx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:+15551234567",
      SenderE164: "+15551234567",
    } as MsgContext;
    const ownerAuth = resolveCommandAuthorization({
      ctx: ownerCtx,
      cfg,
      commandAuthorized: true,
    });
    expect(ownerAuth.senderIsOwner).toBe(true);
    expect(ownerAuth.isAuthorizedSender).toBe(true);

    const otherCtx = {
      Provider: "whatsapp",
      Surface: "whatsapp",
      From: "whatsapp:+19995551234",
      SenderE164: "+19995551234",
    } as MsgContext;
    const otherAuth = resolveCommandAuthorization({
      ctx: otherCtx,
      cfg,
      commandAuthorized: true,
    });
    expect(otherAuth.senderIsOwner).toBe(false);
    expect(otherAuth.isAuthorizedSender).toBe(false);
  });

  it("rejects wildcard channel senders when the plugin enforces owner-only commands", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: {
            ...createOutboundTestPlugin({
              id: "discord",
              outbound: { deliveryMode: "direct" },
            }),
            commands: { enforceOwnerForCommands: true },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
              resolveAllowFrom: () => ["*"],
              formatAllowFrom,
            },
          },
          source: "test",
        },
      ]),
    );
    const cfg = {
      channels: { discord: { allowFrom: ["*"] } },
    } as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        From: "discord:123",
        SenderId: "123",
      } as MsgContext,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(false);
  });

  it("rejects channel-validated native commands when plugin owner enforcement has no owner allowlist", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: {
            ...createOutboundTestPlugin({
              id: "discord",
              outbound: { deliveryMode: "direct" },
            }),
            commands: { enforceOwnerForCommands: true },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
              resolveAllowFrom: () => ["*"],
              formatAllowFrom,
            },
          },
          source: "test",
        },
      ]),
    );
    const cfg = {
      channels: { discord: { allowFrom: ["*"] } },
    } as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "direct",
        From: "discord:123",
        SenderId: "123",
        CommandSource: "native",
      } as MsgContext,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(false);
  });

  it("uses explicit owner allowlist when allowFrom is empty", () => {
    const cfg = {
      commands: { ownerAllowFrom: ["whatsapp:+15551234567"] },
      channels: { whatsapp: {} },
    } as OpenClawConfig;

    const ownerAuth = resolveCommandAuthorization({
      ctx: {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: "whatsapp:+15551234567",
        SenderE164: "+15551234567",
      } as MsgContext,
      cfg,
      commandAuthorized: true,
    });
    expect(ownerAuth.senderIsOwner).toBe(true);
    expect(ownerAuth.isAuthorizedSender).toBe(true);

    const otherAuth = resolveCommandAuthorization({
      ctx: {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: "whatsapp:+19995551234",
        SenderE164: "+19995551234",
      } as MsgContext,
      cfg,
      commandAuthorized: true,
    });
    expect(otherAuth.senderIsOwner).toBe(false);
    expect(otherAuth.isAuthorizedSender).toBe(false);
  });

  it("uses owner allowlist override from context when configured", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: createOutboundTestPlugin({
            id: "discord",
            outbound: { deliveryMode: "direct" },
          }),
          source: "test",
        },
      ]),
    );
    const cfg = {
      channels: { discord: {} },
    } as OpenClawConfig;

    const ctx = {
      Provider: "discord",
      Surface: "discord",
      From: "discord:123",
      SenderId: "123",
      OwnerAllowFrom: ["discord:123"],
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(true);
    expect(auth.ownerList).toEqual(["123"]);
  });

  it("suppresses inherited owner status when the context forbids it", () => {
    const cfg = {
      channels: { telegram: { allowFrom: ["owner-123"] } },
    } as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "exec-event",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        From: "owner-123",
        To: "owner-123",
        ForceSenderIsOwnerFalse: true,
      } as MsgContext,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.senderIsOwner).toBe(false);
  });

  it("does not infer a provider from channel allowlists for webchat command contexts", () => {
    const cfg = {
      channels: { whatsapp: { allowFrom: ["+15551234567"] } },
    } as OpenClawConfig;

    const ctx = {
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      SenderId: "openclaw-control-ui",
    } as MsgContext;

    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.providerId).toBeUndefined();
    expect(auth.isAuthorizedSender).toBe(true);
  });

  it("does not apply channel-prefixed owner wildcards to webchat command contexts", () => {
    const cfg = {
      commands: { ownerAllowFrom: ["discord:*"] },
    } as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        SenderId: "123456789012345678",
        GatewayClientScopes: ["operator.write"],
      } as MsgContext,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.providerId).toBeUndefined();
    expect(auth.senderIsOwner).toBe(false);
  });

  it("does not apply channel-prefixed owner identities to webchat command contexts", () => {
    const cfg = {
      commands: { ownerAllowFrom: ["discord:123456789012345678"] },
    } as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        SenderId: "123456789012345678",
        GatewayClientScopes: ["operator.write"],
      } as MsgContext,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.providerId).toBeUndefined();
    expect(auth.senderIsOwner).toBe(false);
  });

  it("applies channel-prefixed owner identities to matching providers", () => {
    const cfg = {
      commands: { ownerAllowFrom: ["discord:123456789012345678"] },
    } as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "discord",
        Surface: "discord",
        From: "discord:123456789012345678",
        SenderId: "123456789012345678",
      } as MsgContext,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.providerId).toBe("discord");
    expect(auth.senderIsOwner).toBe(true);
  });

  it("does not apply channel-prefixed owner wildcards to mismatched providers", () => {
    const cfg = {
      commands: { ownerAllowFrom: ["telegram:*"] },
    } as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "discord",
        Surface: "discord",
        From: "discord:123456789012345678",
        SenderId: "123456789012345678",
      } as MsgContext,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.providerId).toBe("discord");
    expect(auth.senderIsOwner).toBe(false);
  });

  it("preserves external channel command auth in mixed webchat contexts", () => {
    const cfg = {
      commands: { allowFrom: { whatsapp: ["+15551234567"] } },
      channels: { whatsapp: { allowFrom: ["+15551234567"] } },
    } as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "webchat",
        Surface: "whatsapp",
        OriginatingChannel: "whatsapp",
        From: "whatsapp:+19995551234",
        SenderE164: "+19995551234",
      } as MsgContext,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.providerId).toBe("whatsapp");
    expect(auth.isAuthorizedSender).toBe(false);
  });

  it("falls back to channel allowFrom when provider allowlist resolution throws", () => {
    registerAllowFromPlugins(
      createThrowingAllowFromPlugin("telegram", "channels.telegram.botToken: unresolved SecretRef"),
    );
    const cfg = {
      channels: { telegram: { allowFrom: ["123"] } },
    } as OpenClawConfig;

    const auth = resolveCommandAuthorization({
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        From: "telegram:123",
        SenderId: "123",
      } as MsgContext,
      cfg,
      commandAuthorized: true,
    });

    expect(auth.ownerList).toEqual(["123"]);
    expect(auth.senderIsOwner).toBe(true);
    expect(auth.isAuthorizedSender).toBe(true);
  });

  describe("commands.allowFrom", () => {
    const commandsAllowFromConfig = {
      commands: {
        allowFrom: {
          "*": ["user123"],
        },
      },
      channels: { whatsapp: { allowFrom: ["+different"] } },
    } as OpenClawConfig;

    function makeWhatsAppContext(senderId: string): MsgContext {
      return {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: `whatsapp:${senderId}`,
        SenderId: senderId,
      } as MsgContext;
    }

    function makeDiscordContext(senderId: string, fromOverride?: string): MsgContext {
      return {
        Provider: "discord",
        Surface: "discord",
        From: fromOverride ?? `discord:${senderId}`,
        SenderId: senderId,
      } as MsgContext;
    }

    function resolveWithCommandsAllowFrom(senderId: string, commandAuthorized: boolean) {
      return resolveCommandAuthorization({
        ctx: makeWhatsAppContext(senderId),
        cfg: commandsAllowFromConfig,
        commandAuthorized,
      });
    }

    it("uses commands.allowFrom global list when configured", () => {
      const authorizedAuth = resolveWithCommandsAllowFrom("user123", true);

      expect(authorizedAuth.isAuthorizedSender).toBe(true);

      const unauthorizedAuth = resolveWithCommandsAllowFrom("otheruser", true);

      expect(unauthorizedAuth.isAuthorizedSender).toBe(false);
    });

    it("ignores commandAuthorized when commands.allowFrom is configured", () => {
      const authorizedAuth = resolveWithCommandsAllowFrom("user123", false);

      expect(authorizedAuth.isAuthorizedSender).toBe(true);

      const unauthorizedAuth = resolveWithCommandsAllowFrom("otheruser", false);

      expect(unauthorizedAuth.isAuthorizedSender).toBe(false);
    });

    it("uses commands.allowFrom provider-specific list over global", () => {
      const cfg = {
        commands: {
          allowFrom: {
            "*": ["globaluser"],
            whatsapp: ["+15551234567"],
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig;

      // User in global list but not in whatsapp-specific list
      const globalUserCtx = {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: "whatsapp:globaluser",
        SenderId: "globaluser",
      } as MsgContext;

      const globalAuth = resolveCommandAuthorization({
        ctx: globalUserCtx,
        cfg,
        commandAuthorized: true,
      });

      // Provider-specific list overrides global, so globaluser is not authorized
      expect(globalAuth.isAuthorizedSender).toBe(false);

      // User in whatsapp-specific list
      const whatsappUserCtx = {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: "whatsapp:+15551234567",
        SenderE164: "+15551234567",
      } as MsgContext;

      const whatsappAuth = resolveCommandAuthorization({
        ctx: whatsappUserCtx,
        cfg,
        commandAuthorized: true,
      });

      expect(whatsappAuth.isAuthorizedSender).toBe(true);
    });

    it("falls back to channel allowFrom when commands.allowFrom not set", () => {
      const cfg = {
        channels: { whatsapp: { allowFrom: ["+15551234567"] } },
      } as OpenClawConfig;

      const authorizedCtx = {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: "whatsapp:+15551234567",
        SenderE164: "+15551234567",
      } as MsgContext;

      const auth = resolveCommandAuthorization({
        ctx: authorizedCtx,
        cfg,
        commandAuthorized: true,
      });

      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("allows all senders when commands.allowFrom includes wildcard", () => {
      const cfg = {
        commands: {
          allowFrom: {
            "*": ["*"],
          },
        },
        channels: { whatsapp: { allowFrom: ["+specific"] } },
      } as OpenClawConfig;

      const anyUserCtx = {
        Provider: "whatsapp",
        Surface: "whatsapp",
        From: "whatsapp:anyuser",
        SenderId: "anyuser",
      } as MsgContext;

      const auth = resolveCommandAuthorization({
        ctx: anyUserCtx,
        cfg,
        commandAuthorized: true,
      });

      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("requires owner identity before commands.allowFrom when the plugin enforces owner-only commands", () => {
      registerAllowFromPlugins(createOwnerEnforcingAllowFromPlugin("telegram", () => ["*"]));
      const cfg = {
        commands: {
          allowFrom: {
            "*": ["*"],
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
      } as OpenClawConfig;

      const auth = resolveCommandAuthorization({
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "group",
          From: "telegram:999",
          SenderId: "999",
          CommandSource: "native",
        } as MsgContext,
        cfg,
        commandAuthorized: true,
      });

      expect(auth.senderIsOwner).toBe(false);
      expect(auth.isAuthorizedSender).toBe(false);
    });

    it("keeps commands.allowFrom available to non-owner command users when an owner allowlist is configured", () => {
      const cfg = {
        commands: {
          ownerAllowFrom: ["discord:owner"],
          allowFrom: {
            discord: ["helper"],
          },
        },
        channels: { discord: { allowFrom: ["*"] } },
      } as OpenClawConfig;

      const auth = resolveCommandAuthorization({
        ctx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "group",
          From: "discord:helper",
          SenderId: "helper",
          CommandSource: "native",
        } as MsgContext,
        cfg,
        commandAuthorized: true,
      });

      expect(auth.senderIsOwner).toBe(false);
      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("does not treat conversation ids in From as sender identities", () => {
      const cfg = {
        commands: {
          allowFrom: {
            discord: ["channel:123456789012345678"],
          },
        },
      } as OpenClawConfig;

      const auth = resolveCommandAuthorization({
        ctx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "channel",
          From: "discord:channel:123456789012345678",
          SenderId: "999999999999999999",
        } as MsgContext,
        cfg,
        commandAuthorized: false,
      });

      expect(auth.isAuthorizedSender).toBe(false);
    });

    it("still falls back to From for direct messages when sender fields are absent", () => {
      const cfg = {
        commands: {
          allowFrom: {
            discord: ["123456789012345678"],
          },
        },
      } as OpenClawConfig;

      const auth = resolveCommandAuthorization({
        ctx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          From: "discord:123456789012345678",
          SenderId: " ",
          SenderE164: " ",
        } as MsgContext,
        cfg,
        commandAuthorized: false,
      });

      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("does not fall back to conversation-shaped From when chat type is missing", () => {
      const cfg = {
        commands: {
          allowFrom: {
            "*": ["demo:group:room-1"],
          },
        },
      } as OpenClawConfig;

      const auth = resolveCommandAuthorization({
        ctx: {
          Provider: "whatsapp",
          Surface: "whatsapp",
          From: "demo:group:room-1",
          SenderId: " ",
          SenderE164: " ",
        } as MsgContext,
        cfg,
        commandAuthorized: false,
      });

      expect(auth.isAuthorizedSender).toBe(false);
    });

    it("normalizes Discord commands.allowFrom prefixes and mentions", () => {
      const cfg = {
        commands: {
          allowFrom: {
            discord: ["user:123", "<@!456>", "pk:member-1"],
          },
        },
      } as OpenClawConfig;

      const userAuth = resolveCommandAuthorization({
        ctx: makeDiscordContext("123"),
        cfg,
        commandAuthorized: false,
      });

      expect(userAuth.isAuthorizedSender).toBe(true);

      const mentionAuth = resolveCommandAuthorization({
        ctx: makeDiscordContext("456"),
        cfg,
        commandAuthorized: false,
      });

      expect(mentionAuth.isAuthorizedSender).toBe(true);

      const pkAuth = resolveCommandAuthorization({
        ctx: makeDiscordContext("member-1", "discord:999"),
        cfg,
        commandAuthorized: false,
      });

      expect(pkAuth.isAuthorizedSender).toBe(true);

      const deniedAuth = resolveCommandAuthorization({
        ctx: makeDiscordContext("other"),
        cfg,
        commandAuthorized: false,
      });

      expect(deniedAuth.isAuthorizedSender).toBe(false);
    });
    it("fails closed when provider inference hits unresolved SecretRef allowlists", () => {
      registerAllowFromPlugins(
        createThrowingAllowFromPlugin(
          "telegram",
          "channels.telegram.botToken: unresolved SecretRef",
        ),
      );

      const cfg = {
        commands: {
          allowFrom: {
            telegram: ["123"],
          },
        },
        channels: {
          telegram: {
            allowFrom: ["123"],
          },
        },
      } as OpenClawConfig;

      const auth = resolveCommandAuthorization({
        ctx: {
          SenderId: "123",
        } as MsgContext,
        cfg,
        commandAuthorized: false,
      });

      expect(auth.providerId).toBe("telegram");
      expect(auth.isAuthorizedSender).toBe(false);
    });

    it("preserves provider resolution errors when inferred fallback allowFrom is empty", () => {
      registerAllowFromPlugins(
        createThrowingAllowFromPlugin(
          "telegram",
          "channels.telegram.botToken: unresolved SecretRef",
        ),
      );

      const auth = resolveCommandAuthorization({
        ctx: {
          SenderId: "123",
        } as MsgContext,
        cfg: {
          commands: {
            allowFrom: {
              telegram: ["123"],
            },
          },
          channels: {
            telegram: {},
          },
        } as OpenClawConfig,
        commandAuthorized: true,
      });

      expect(auth.providerId).toBeUndefined();
      expect(auth.isAuthorizedSender).toBe(false);
    });

    it("fails closed for global commands.allowFrom when inference errors drop every provider", () => {
      registerAllowFromPlugins(
        createThrowingAllowFromPlugin("slack", "channels.slack.token: unresolved SecretRef"),
      );

      const auth = resolveCommandAuthorization({
        ctx: {
          SenderId: "123",
        } as MsgContext,
        cfg: {
          commands: {
            allowFrom: {
              "*": ["123"],
            },
          },
          channels: {
            slack: {},
          },
        } as OpenClawConfig,
        commandAuthorized: false,
      });

      expect(auth.providerId).toBeUndefined();
      expect(auth.isAuthorizedSender).toBe(false);
    });
    it("does not let an unrelated provider resolution error poison inferred commands.allowFrom", () => {
      registerAllowFromPlugins(
        createAllowFromPlugin("telegram", () => ["123"]),
        createThrowingAllowFromPlugin("slack", "channels.slack.token: unresolved SecretRef"),
      );

      const auth = resolveCommandAuthorization({
        ctx: {
          SenderId: "123",
        } as MsgContext,
        cfg: {
          commands: {
            allowFrom: {
              telegram: ["123"],
            },
          },
          channels: {
            telegram: {
              allowFrom: ["123"],
            },
          },
        } as OpenClawConfig,
        commandAuthorized: false,
      });

      expect(auth.providerId).toBe("telegram");
      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("preserves default-account allowFrom on SecretRef fallback", () => {
      registerAllowFromPlugins(
        createThrowingAllowFromPlugin(
          "telegram",
          "channels.telegram.botToken: unresolved SecretRef",
        ),
      );

      const auth = resolveCommandAuthorization({
        ctx: {
          Provider: "telegram",
          Surface: "telegram",
          SenderId: "123",
        } as MsgContext,
        cfg: {
          channels: {
            telegram: {
              accounts: {
                default: {
                  allowFrom: ["123"],
                },
              },
            },
          },
        } as OpenClawConfig,
        commandAuthorized: true,
      });

      expect(auth.ownerList).toEqual(["123"]);
      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("treats undefined allowFrom as an open channel, not a resolution failure", () => {
      registerAllowFromPlugins(createAllowFromPlugin("discord", () => undefined));

      const auth = resolveCommandAuthorization({
        ctx: {
          Provider: "discord",
          Surface: "discord",
          SenderId: "123",
        } as MsgContext,
        cfg: {
          channels: {
            discord: {},
          },
        } as OpenClawConfig,
        commandAuthorized: true,
      });

      expect(auth.isAuthorizedSender).toBe(true);
    });

    it("does not log raw resolution messages from thrown allowFrom errors", () => {
      registerAllowFromPlugins(createThrowingAllowFromPlugin("telegram", "SECRET-TOKEN-123"));

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        resolveCommandAuthorization({
          ctx: {
            Provider: "telegram",
            Surface: "telegram",
            SenderId: "123",
          } as MsgContext,
          cfg: {
            channels: {
              telegram: {
                allowFrom: ["123"],
              },
            },
          } as OpenClawConfig,
          commandAuthorized: true,
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls.at(0)?.[0] ?? "")).toContain("Error");
        expect(String(warn.mock.calls.at(0)?.[0] ?? "")).not.toContain("SECRET-TOKEN-123");
      } finally {
        warn.mockRestore();
      }
    });
  });

  it("grants senderIsOwner for internal channel with operator.admin scope", () => {
    const cfg = {} as OpenClawConfig;
    const ctx = {
      Provider: "webchat",
      Surface: "webchat",
      GatewayClientScopes: ["operator.admin"],
    } as MsgContext;
    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });
    expect(auth.senderIsOwner).toBe(true);
  });

  it("does not grant senderIsOwner for internal channel without admin scope", () => {
    const cfg = {} as OpenClawConfig;
    const ctx = {
      Provider: "webchat",
      Surface: "webchat",
      GatewayClientScopes: ["operator.approvals"],
    } as MsgContext;
    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });
    expect(auth.senderIsOwner).toBe(false);
  });

  it("does not grant senderIsOwner for external channel even with admin scope", () => {
    const cfg = {} as OpenClawConfig;
    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      From: "telegram:12345",
      GatewayClientScopes: ["operator.admin"],
    } as MsgContext;
    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });
    expect(auth.senderIsOwner).toBe(false);
  });
});

describe("control command parsing", () => {
  it("requires slash for send policy", () => {
    expect(parseSendPolicyCommand("/send on")).toEqual({
      hasCommand: true,
      mode: "allow",
    });
    expect(parseSendPolicyCommand("/send: on")).toEqual({
      hasCommand: true,
      mode: "allow",
    });
    expect(parseSendPolicyCommand("/send")).toEqual({ hasCommand: true });
    expect(parseSendPolicyCommand("/send:")).toEqual({ hasCommand: true });
    expect(parseSendPolicyCommand("send on")).toEqual({ hasCommand: false });
    expect(parseSendPolicyCommand("send")).toEqual({ hasCommand: false });
  });

  it("requires slash for activation", () => {
    expect(parseActivationCommand("/activation mention")).toEqual({
      hasCommand: true,
      mode: "mention",
    });
    expect(parseActivationCommand("/activation: mention")).toEqual({
      hasCommand: true,
      mode: "mention",
    });
    expect(parseActivationCommand("/activation:")).toEqual({
      hasCommand: true,
    });
    expect(parseActivationCommand("activation mention")).toEqual({
      hasCommand: false,
    });
  });

  it("treats bare commands as non-control", () => {
    expect(hasControlCommand("send")).toBe(false);
    expect(hasControlCommand("help")).toBe(false);
    expect(hasControlCommand("/commands")).toBe(true);
    expect(hasControlCommand("/commands:")).toBe(true);
    expect(hasControlCommand("commands")).toBe(false);
    expect(hasControlCommand("/status")).toBe(true);
    expect(hasControlCommand("/status:")).toBe(true);
    expect(hasControlCommand("status")).toBe(false);
    expect(hasControlCommand("usage")).toBe(false);

    for (const command of listChatCommands()) {
      for (const alias of command.textAliases) {
        expect(hasControlCommand(alias)).toBe(true);
        expect(hasControlCommand(`${alias}:`)).toBe(true);
      }
    }
    expect(hasControlCommand("/compact")).toBe(true);
    expect(hasControlCommand("/compact:")).toBe(true);
    expect(hasControlCommand("compact")).toBe(false);
  });

  it("respects disabled config/debug commands", () => {
    const cfg = { commands: { config: false, debug: false } };
    expect(hasControlCommand("/config show", cfg)).toBe(false);
    expect(hasControlCommand("/debug show", cfg)).toBe(false);
  });

  it("requires commands to be the full message", () => {
    expect(hasControlCommand("hello /status")).toBe(false);
    expect(hasControlCommand("/status please")).toBe(false);
    expect(hasControlCommand("prefix /send on")).toBe(false);
    expect(hasControlCommand("/send on")).toBe(true);
  });

  it("detects inline command tokens", () => {
    expect(hasInlineCommandTokens("hello /status")).toBe(true);
    expect(hasInlineCommandTokens("hey /think high")).toBe(true);
    expect(hasInlineCommandTokens("plain text")).toBe(false);
    expect(hasInlineCommandTokens("http://example.com/path")).toBe(false);
    expect(hasInlineCommandTokens("stop")).toBe(false);
  });

  it("ignores telegram commands addressed to other bots", () => {
    expect(
      hasControlCommand("/help@otherbot", undefined, {
        botUsername: "openclaw",
      }),
    ).toBe(false);
    expect(
      hasControlCommand("/help@openclaw", undefined, {
        botUsername: "openclaw",
      }),
    ).toBe(true);
  });

  it("detects commands wrapped in inbound metadata blocks", () => {
    const metaWrapped = [
      "Conversation info (untrusted metadata):",
      "```json",
      '{"message_id":"msg-abc","chat_id":"chat-123"}',
      "```",
      "",
      "/model spark",
    ].join("\n");
    expect(hasControlCommand(metaWrapped)).toBe(true);
  });

  it("detects /new command after metadata prefix", () => {
    const metaWrapped = [
      "Sender (untrusted metadata):",
      "```json",
      '{"name":"Alice","id":"user-1"}',
      "```",
      "",
      "/new spark",
    ].join("\n");
    expect(hasControlCommand(metaWrapped)).toBe(true);
  });

  it("detects /status command after timestamp + metadata prefix", () => {
    const metaWrapped = [
      "[Wed 2026-03-11 23:51 PDT] Conversation info (untrusted metadata):",
      "```json",
      '{"chat_id":"chat-123"}',
      "```",
      "",
      "/status",
    ].join("\n");
    expect(hasControlCommand(metaWrapped)).toBe(true);
  });
});
