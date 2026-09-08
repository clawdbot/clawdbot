// Discord tests cover monitor.agent components plugin behavior.
import { ChannelType, ComponentType } from "discord-api-types/v10";
import { expectPairingReplyText } from "openclaw/plugin-sdk/channel-test-helpers";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
} from "openclaw/plugin-sdk/system-event-runtime";
import { peekSystemEvents, resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ButtonInteraction,
  createInteraction,
  StringSelectMenuInteraction,
  type ComponentData,
} from "../internal/discord.js";
import {
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import {
  enqueueSystemEventMock,
  readAllowFromStoreMock,
  resetDiscordComponentRuntimeMocks,
  upsertPairingRequestMock,
} from "../test-support/component-runtime.js";
import { resolveComponentInteractionContext } from "./agent-components-context.js";
import {
  createAgentComponentButton,
  createAgentSelectMenu,
} from "./agent-components.system-controls.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";

describe("agent components", () => {
  const defaultDmSessionKey = buildAgentSessionKey({
    agentId: "main",
    channel: "discord",
    accountId: "default",
    peer: { kind: "direct", id: "123456789" },
  });
  const defaultGroupDmSessionKey = buildAgentSessionKey({
    agentId: "main",
    channel: "discord",
    accountId: "default",
    peer: { kind: "group", id: "group-dm-channel" },
  });

  const createCfg = (): OpenClawConfig => ({}) as OpenClawConfig;
  const createDmInteraction = (params: { interactionId: string; data?: Record<string, unknown> }) =>
    createInteraction(
      createInternalTestClient(),
      createInternalComponentInteractionPayload({
        id: params.interactionId,
        token: `token-${params.interactionId}`,
        channel_id: "dm-channel",
        user: {
          id: "123456789",
          username: "Alice",
          discriminator: "1234",
          global_name: null,
          avatar: null,
        },
        data: params.data,
      }),
    );

  const createDmButtonInteraction = (interactionId = "interaction-1") => {
    const interaction = createDmInteraction({ interactionId });
    if (!(interaction instanceof ButtonInteraction)) {
      throw new Error("expected a Discord button interaction");
    }
    const defer = vi.spyOn(interaction, "defer").mockResolvedValue(undefined);
    const reply = vi.spyOn(interaction, "reply").mockResolvedValue(undefined);
    return {
      interaction,
      defer,
      reply,
    };
  };

  const createDmSelectInteraction = (interactionId = "interaction-1") => {
    const interaction = createDmInteraction({
      interactionId,
      data: {
        component_type: ComponentType.StringSelect,
        values: ["alpha"],
      },
    });
    if (!(interaction instanceof StringSelectMenuInteraction)) {
      throw new Error("expected a Discord string select interaction");
    }
    const defer = vi.spyOn(interaction, "defer").mockResolvedValue(undefined);
    const reply = vi.spyOn(interaction, "reply").mockResolvedValue(undefined);
    return {
      interaction,
      defer,
      reply,
    };
  };

  const firstReplyContent = (reply: ReturnType<typeof vi.fn>): string => {
    const [call] = reply.mock.calls;
    if (!call) {
      throw new Error("expected interaction reply call");
    }
    const [payload] = call;
    if (!payload || typeof payload !== "object" || !("content" in payload)) {
      throw new Error("expected interaction reply content");
    }
    const { content } = payload as { content?: unknown };
    if (typeof content !== "string") {
      throw new Error("expected interaction reply content to be a string");
    }
    return content;
  };

  const createGroupDmButtonInteraction = (interactionId = "interaction-1") => {
    const interaction = createInteraction(
      createInternalTestClient(),
      createInternalComponentInteractionPayload({
        id: interactionId,
        token: `token-${interactionId}`,
        channel_id: "group-dm-channel",
        channel: {
          id: "group-dm-channel",
          type: ChannelType.GroupDM,
          name: "incident-room",
        },
        user: {
          id: "123456789",
          username: "Alice",
          discriminator: "1234",
          global_name: null,
          avatar: null,
        },
      }),
    );
    if (!(interaction instanceof ButtonInteraction)) {
      throw new Error("expected a Discord button interaction");
    }
    const defer = vi.spyOn(interaction, "defer").mockResolvedValue(undefined);
    const reply = vi.spyOn(interaction, "reply").mockResolvedValue(undefined);
    return {
      interaction,
      defer,
      reply,
    };
  };

  async function expectSuccessfulDmButtonInteraction(params: {
    dmPolicy: "pairing" | "open";
    expectPairingStoreRead: boolean;
    allowFrom?: string[];
  }) {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: params.dmPolicy,
      allowFrom: params.allowFrom,
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-button:dm-channel:hello:123456789:interaction-1",
      },
    );
    if (params.expectPairingStoreRead) {
      expect(readAllowFromStoreMock).toHaveBeenCalledWith("discord", "default");
    } else {
      expect(readAllowFromStoreMock).not.toHaveBeenCalled();
    }
  }

  beforeEach(() => {
    resetDiscordComponentRuntimeMocks();
    resetSystemEventsForTest();
  });

  it("does not create pairing after policy is revoked during the component store read", async () => {
    const cfg: OpenClawConfig = {
      channels: { discord: { dmPolicy: "pairing", allowFrom: [] } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    const stored = createDeferred<string[]>();
    const readStarted = createDeferred<void>();
    readAllowFromStoreMock.mockImplementationOnce(() => {
      readStarted.resolve();
      return stored.promise;
    });
    const button = createAgentComponentButton({
      cfg,
      accountId: "default",
      readPolicy: createDiscordLivePolicyReader({
        cfg,
        accountId: "default",
        token: "synthetic-token",
        resolvedAllowlist: { guildEntries: undefined, allowFrom: [] },
      }),
    });
    const { interaction, reply } = createDmButtonInteraction();
    try {
      const run = button.run(interaction, { componentId: "hello" } as ComponentData);
      await readStarted.promise;
      const revoked: OpenClawConfig = {
        channels: { discord: { dmPolicy: "disabled", allowFrom: [] } },
      };
      setRuntimeConfigSnapshot(revoked, revoked);
      stored.resolve([]);
      await run;

      expect(reply).toHaveBeenCalledExactlyOnceWith({
        content: "Access policy changed. Try this interaction again.",
        ephemeral: true,
      });
      expect(upsertPairingRequestMock).not.toHaveBeenCalled();
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    } finally {
      stored.resolve([]);
      clearRuntimeConfigSnapshot();
    }
  });

  it("sends pairing reply when DM sender is not allowlisted", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "pairing",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    const pairingText = firstReplyContent(reply);
    const code = expectPairingReplyText(pairingText, {
      channel: "discord",
      idLine: "Your Discord user id: 123456789",
    });
    expect(pairingText).toContain(`openclaw pairing approve discord ${code}`);
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).toHaveBeenCalledWith("discord", "default");
  });

  it("blocks DM interactions in allowlist mode when sender is not in configured allowFrom", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("classifies Group DM component interactions separately from direct messages", async () => {
    const { interaction, defer } = createGroupDmButtonInteraction();

    const ctx = await resolveComponentInteractionContext({
      interaction,
      label: "group-dm-test",
      defer: false,
    });

    expect(defer).not.toHaveBeenCalled();
    expect(ctx).toMatchObject({
      channelId: "group-dm-channel",
      user: { id: "123456789", username: "Alice", discriminator: "1234" },
      username: "Alice#1234",
      userId: "123456789",
      replyOpts: { ephemeral: true },
      isDirectMessage: false,
      isGroupDm: true,
      memberRoleIds: [],
      rawGuildId: undefined,
    });
  });

  it("blocks Group DM interactions that are not allowlisted even when dmPolicy is open", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "open",
      discordConfig: {
        dm: {
          groupEnabled: true,
          groupChannels: ["other-group-dm"],
        },
      } as DiscordAccountConfig,
    });
    const { interaction, defer, reply } = createGroupDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultGroupDmSessionKey)).toStrictEqual([]);
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("routes allowlisted Group DM interactions to the group session without applying DM policy", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "disabled",
      discordConfig: {
        dm: {
          groupEnabled: true,
          groupChannels: ["group-dm-channel"],
        },
      } as DiscordAccountConfig,
    });
    const { interaction, defer, reply } = createGroupDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultGroupDmSessionKey,
        contextKey: "discord:agent-button:group-dm-channel:hello:123456789:interaction-1",
      },
    );
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("authorizes DM interactions from pairing-store entries in pairing mode", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    await expectSuccessfulDmButtonInteraction({
      dmPolicy: "pairing",
      expectPairingStoreRead: true,
    });
    expect(upsertPairingRequestMock).not.toHaveBeenCalled();
  });

  it("allows DM component interactions in open mode without reading pairing store", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    await expectSuccessfulDmButtonInteraction({
      dmPolicy: "open",
      expectPairingStoreRead: false,
      allowFrom: ["*"],
    });
  });

  it("blocks DM component interactions in disabled mode without reading pairing store", async () => {
    readAllowFromStoreMock.mockResolvedValue(["123456789"]);
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "disabled",
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({
      content: "DM interactions are disabled.",
      ephemeral: true,
    });
    expect(peekSystemEvents(defaultDmSessionKey)).toStrictEqual([]);
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("matches tag-based allowlist entries for DM select menus", async () => {
    const select = createAgentSelectMenu({
      cfg: createCfg(),
      accountId: "default",
      discordConfig: { dangerouslyAllowNameMatching: true } as DiscordAccountConfig,
      dmPolicy: "allowlist",
      allowFrom: ["Alice#1234"],
    });
    const { interaction, defer, reply } = createDmSelectInteraction();

    await select.run(interaction, { componentId: "hello" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord select menu: hello interacted by Alice#1234 (123456789) (selected: alpha)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-select:dm-channel:hello:123456789:interaction-1",
      },
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("accepts cid payloads for agent button interactions", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { cid: "hello_cid" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello_cid clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-button:dm-channel:hello_cid:123456789:interaction-1",
      },
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it("keeps malformed percent cid values without throwing", async () => {
    const button = createAgentComponentButton({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
    });
    const { interaction, defer, reply } = createDmButtonInteraction();

    await button.run(interaction, { cid: "hello%2G" } as ComponentData);

    expect(defer).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      "[Discord component: hello%2G clicked by Alice#1234 (123456789)]",
      {
        sessionKey: defaultDmSessionKey,
        contextKey: "discord:agent-button:dm-channel:hello%2G:123456789:interaction-1",
      },
    );
    expect(readAllowFromStoreMock).not.toHaveBeenCalled();
  });

  it.each(["button", "select"] as const)(
    "queues distinct %s occurrences while deduplicating replayed occurrences",
    async (kind) => {
      const context = {
        cfg: createCfg(),
        accountId: "default",
        dmPolicy: "allowlist" as const,
        allowFrom: ["123456789"],
      };
      const control =
        kind === "button" ? createAgentComponentButton(context) : createAgentSelectMenu(context);
      const createInteractionForKind =
        kind === "button" ? createDmButtonInteraction : createDmSelectInteraction;
      const first = createInteractionForKind("interaction-1");
      const second = createInteractionForKind("interaction-2");
      const replay = createInteractionForKind("interaction-1");

      await enqueueSystemEventMock.withImplementation(
        (...args) => enqueueSystemEvent(...(args as Parameters<typeof enqueueSystemEvent>)),
        async () => {
          await control.run(first.interaction, { componentId: "hello" } as ComponentData);
          enqueueSystemEvent("An unrelated event occurred", {
            sessionKey: defaultDmSessionKey,
            contextKey: "discord:test:intervening",
          });
          await control.run(second.interaction, { componentId: "hello" } as ComponentData);
          await control.run(replay.interaction, { componentId: "hello" } as ComponentData);

          expect(enqueueSystemEventMock.mock.results.map(({ value }) => value)).toEqual([
            true,
            true,
            false,
          ]);
          const eventText =
            kind === "button"
              ? "[Discord component: hello clicked by Alice#1234 (123456789)]"
              : "[Discord select menu: hello interacted by Alice#1234 (123456789) (selected: alpha)]";
          expect(peekSystemEventEntries(defaultDmSessionKey)).toMatchObject([
            {
              text: eventText,
              contextKey: `discord:agent-${kind}:dm-channel:hello:123456789:interaction-1`,
            },
            {
              text: "An unrelated event occurred",
              contextKey: "discord:test:intervening",
            },
            {
              text: eventText,
              contextKey: `discord:agent-${kind}:dm-channel:hello:123456789:interaction-2`,
            },
          ]);
          for (const { reply } of [first, second, replay]) {
            expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
          }
        },
      );
    },
  );
});
