import { ChannelType } from "discord-api-types/v10";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildPluginBindingApprovalCustomId } from "openclaw/plugin-sdk/conversation-runtime";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type DiscordComponentEntry, type DiscordModalEntry } from "../components.js";
import type {
  ButtonInteraction,
  ComponentData,
  ModalInteraction,
  StringSelectMenuInteraction,
} from "../internal/discord.js";
import { createDiscordSendReceipt } from "../send.receipt.js";
import {
  dispatchPluginInteractiveHandlerMock,
  dispatchReplyMock,
  enqueueSystemEventMock,
  readSessionUpdatedAtMock,
  recordInboundSessionMock,
  resetDiscordComponentRuntimeMocks,
  resolveStorePathMock,
} from "../test-support/component-runtime.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";

type CreateDiscordComponentButton =
  typeof import("./agent-components.js").createDiscordComponentButton;
type CreateDiscordComponentModal =
  typeof import("./agent-components.js").createDiscordComponentModal;
type CreateDiscordComponentStringSelect =
  typeof import("./agent-components.js").createDiscordComponentStringSelect;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("openclaw/plugin-sdk/reply-dispatch-runtime").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;

let createDiscordComponentButton: CreateDiscordComponentButton;
let createDiscordComponentStringSelect: CreateDiscordComponentStringSelect;
let createDiscordComponentModal: CreateDiscordComponentModal;
let clearDiscordComponentEntries: typeof import("../components-registry.js").clearDiscordComponentEntries;
let registerDiscordComponentEntries: typeof import("../components-registry.js").registerDiscordComponentEntries;
let resolveDiscordComponentEntry: typeof import("../components-registry.js").resolveDiscordComponentEntry;
let resolveDiscordModalEntry: typeof import("../components-registry.js").resolveDiscordModalEntry;
let sendComponents: typeof import("../send.components.js");

let lastDispatchCtx: Record<string, unknown> | undefined;

type MockWithCalls = { mock: { calls: unknown[][] } };

function mockCall(mock: MockWithCalls, index: number, label: string): unknown[] {
  const resolvedIndex = index < 0 ? mock.mock.calls.length + index : index;
  const call = mock.mock.calls[resolvedIndex];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function mockCallArg(mock: MockWithCalls, index: number, label: string): unknown {
  return mockCall(mock, index, label)[0];
}

function getLastRecordedCtx(): Record<string, unknown> | undefined {
  const params = mockCallArg(recordInboundSessionMock, -1, "recordInboundSession") as {
    ctx?: Record<string, unknown>;
  };
  return params?.ctx;
}

function getLastPluginDispatchCtx(): Record<string, unknown> | undefined {
  const params = mockCallArg(
    dispatchPluginInteractiveHandlerMock,
    -1,
    "dispatchPluginInteractiveHandler",
  ) as { ctx?: Record<string, unknown> };
  return params?.ctx;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function firstMockCall(mock: MockWithCalls, label: string): unknown[] {
  return mockCall(mock, 0, label);
}

function firstMockArg(mock: MockWithCalls, label: string) {
  return firstMockCall(mock, label)[0];
}

function discordTestSendResult(messageId: string, channelId = "dm-channel") {
  return {
    messageId,
    channelId,
    receipt: createDiscordSendReceipt({ platformMessageIds: [messageId], channelId, kind: "card" }),
  };
}

describe("discord component interactions", () => {
  let editDiscordComponentMessageMock: ReturnType<typeof vi.spyOn>;
  const createCfg = (): OpenClawConfig =>
    ({
      channels: {
        discord: {
          replyToMode: "first",
        },
      },
    }) as OpenClawConfig;

  const createDiscordConfig = (overrides?: Partial<DiscordAccountConfig>): DiscordAccountConfig =>
    ({
      replyToMode: "first",
      ...overrides,
    }) as DiscordAccountConfig;

  type DispatchParams = Parameters<DispatchReplyWithBufferedBlockDispatcherFn>[0];

  type ComponentContext = Parameters<CreateDiscordComponentButton>[0];

  const createComponentContext = (overrides?: Partial<ComponentContext>) =>
    ({
      cfg: createCfg(),
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["123456789"],
      discordConfig: createDiscordConfig(),
      token: "token",
      ...overrides,
    }) as ComponentContext;

  const createComponentInteractionBase = () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const defer = vi.fn().mockResolvedValue(undefined);
    const rest = {
      get: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
      post: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    return {
      reply,
      defer,
      client: { rest },
      user: { id: "123456789", username: "AgentUser", discriminator: "0001" },
      message: { id: "msg-1" },
    };
  };

  const createComponentButtonInteraction = (overrides: Partial<ButtonInteraction> = {}) => {
    const base = createComponentInteractionBase();
    const interaction = {
      rawData: { channel_id: "dm-channel", id: "interaction-1" },
      customId: "occomp:cid=btn_1",
      ...base,
      ...overrides,
    } as unknown as ButtonInteraction;
    return { interaction, defer: base.defer, reply: base.reply };
  };

  const createComponentSelectInteraction = (
    overrides: Partial<StringSelectMenuInteraction> = {},
  ) => {
    const base = createComponentInteractionBase();
    const interaction = {
      rawData: { channel_id: "dm-channel", id: "interaction-select-1" },
      customId: "occomp:cid=sel_1",
      values: ["alpha"],
      ...base,
      ...overrides,
    } as unknown as StringSelectMenuInteraction;
    return { interaction, defer: base.defer, reply: base.reply };
  };

  const createModalInteraction = (overrides: Partial<ModalInteraction> = {}) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const rest = {
      get: vi.fn().mockResolvedValue({ type: ChannelType.DM }),
      post: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const fields = {
      getText: (key: string) => (key === "fld_1" ? "Casey" : undefined),
      getStringSelect: (_key: string) => undefined,
      getRoleSelect: (_key: string) => [],
      getUserSelect: (_key: string) => [],
    };
    const interaction = {
      rawData: { channel_id: "dm-channel", id: "interaction-2" },
      user: { id: "123456789", username: "AgentUser", discriminator: "0001" },
      customId: "ocmodal:mid=mdl_1",
      fields,
      acknowledge,
      reply,
      client: { rest },
      ...overrides,
    } as unknown as ModalInteraction;
    return { interaction, acknowledge, reply };
  };

  const createButtonEntry = (
    overrides: Partial<DiscordComponentEntry> = {},
  ): DiscordComponentEntry => ({
    id: "btn_1",
    kind: "button",
    label: "Approve",
    messageId: "msg-1",
    sessionKey: "session-1",
    agentId: "agent-1",
    accountId: "default",
    ...overrides,
  });

  const createModalEntry = (overrides: Partial<DiscordModalEntry> = {}): DiscordModalEntry => ({
    id: "mdl_1",
    title: "Details",
    messageId: "msg-2",
    sessionKey: "session-2",
    agentId: "agent-2",
    accountId: "default",
    fields: [
      {
        id: "fld_1",
        name: "name",
        label: "Name",
        type: "text",
      },
    ],
    ...overrides,
  });

  const createGuildPluginButton = (allowFrom: string[]) =>
    createDiscordComponentButton(
      createComponentContext({
        cfg: {
          commands: { useAccessGroups: true },
          channels: { discord: { replyToMode: "first" } },
        } as OpenClawConfig,
        allowFrom,
      }),
    );

  const createGuildPluginButtonInteraction = (interactionId: string) =>
    createComponentButtonInteraction({
      rawData: {
        channel_id: "guild-channel",
        guild_id: "guild-1",
        id: interactionId,
        member: { roles: [] },
      } as unknown as ButtonInteraction["rawData"],
      guild: { id: "guild-1", name: "Test Guild" } as unknown as ButtonInteraction["guild"],
    });

  async function expectPluginGuildInteractionAuth(params: {
    allowFrom: string[];
    interactionId: string;
    isAuthorizedSender: boolean;
  }) {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: true,
      handled: true,
      duplicate: false,
    });

    const button = createGuildPluginButton(params.allowFrom);
    const { interaction } = createGuildPluginButtonInteraction(params.interactionId);

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(1);
    const auth = requireRecord(getLastPluginDispatchCtx()?.auth, "plugin dispatch auth");
    expect(auth.isAuthorizedSender).toBe(params.isAuthorizedSender);
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  }

  beforeAll(async () => {
    ({
      createDiscordComponentButton,
      createDiscordComponentStringSelect,
      createDiscordComponentModal,
    } = await import("./agent-components.js"));
    ({
      clearDiscordComponentEntries,
      registerDiscordComponentEntries,
      resolveDiscordComponentEntry,
      resolveDiscordModalEntry,
    } = await import("../components-registry.js"));
    sendComponents = await import("../send.components.js");
  });

  beforeEach(() => {
    editDiscordComponentMessageMock = vi
      .spyOn(sendComponents, "editDiscordComponentMessage")
      .mockResolvedValue(discordTestSendResult("msg-1"));
    clearDiscordComponentEntries();
    resetDiscordComponentRuntimeMocks();
    lastDispatchCtx = undefined;
    enqueueSystemEventMock.mockClear();
    dispatchReplyMock
      .mockClear()
      .mockImplementation(
        async (params: DispatchParams): Promise<DispatchReplyWithBufferedBlockDispatcherResult> => {
          lastDispatchCtx = params.ctx;
          await params.dispatcherOptions.deliver({ text: "ok" }, { kind: "final" });
          return {
            queuedFinal: false,
            counts: {
              block: 0,
              final: 1,
              tool: 0,
            },
          };
        },
      );
    recordInboundSessionMock.mockClear().mockResolvedValue(undefined);
    readSessionUpdatedAtMock.mockClear().mockReturnValue(undefined);
    resolveStorePathMock.mockClear().mockReturnValue("/tmp/openclaw-sessions-test.json");
    dispatchPluginInteractiveHandlerMock.mockReset().mockResolvedValue({
      matched: false,
      handled: false,
      duplicate: false,
    });
  });

  it("routes button clicks with reply references", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(lastDispatchCtx?.BodyForAgent).toBe('Clicked "Approve".');
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    const dispatchParams = firstMockArg(dispatchReplyMock, "dispatchReplyMock") as
      | DispatchParams
      | undefined;
    expect(typeof dispatchParams?.dispatcherOptions.responsePrefixContextProvider).toBe("function");
    expect(typeof dispatchParams?.replyOptions?.onModelSelected).toBe("function");
    expect(resolveDiscordComponentEntry({ id: "btn_1" })).toBeNull();
  });

  it("records DM component interactions with user originating targets", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(lastDispatchCtx?.OriginatingTo).toBe("user:123456789");
    expect(lastDispatchCtx?.To).toBe("channel:dm-channel");
    expect(getLastRecordedCtx()?.OriginatingTo).toBe("user:123456789");
    expect(getLastRecordedCtx()?.To).toBe("channel:dm-channel");
  });

  it("uses raw callbackData for built-in fallback when no plugin handler matches", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "/codex_resume --browse-projects" })],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(lastDispatchCtx?.BodyForAgent).toBe("/codex_resume --browse-projects");
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
  });

  it("preserves selected values for select fallback when no plugin handler matches", async () => {
    registerDiscordComponentEntries({
      entries: [
        {
          id: "sel_1",
          kind: "select",
          label: "Pick",
          messageId: "msg-1",
          sessionKey: "session-1",
          agentId: "agent-1",
          accountId: "default",
          callbackData: "/codex_resume",
          selectType: "string",
          options: [{ value: "alpha", label: "Alpha" }],
        },
      ],
      modals: [],
    });

    const select = createDiscordComponentStringSelect(createComponentContext());
    const { interaction, reply } = createComponentSelectInteraction();

    await select.run(interaction, { cid: "sel_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(lastDispatchCtx?.BodyForAgent).toBe('Selected Alpha from "Pick".');
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
  });

  it("keeps reusable buttons active after use", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ reusable: true })],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction } = createComponentButtonInteraction();
    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    const { interaction: secondInteraction } = createComponentButtonInteraction({
      rawData: {
        channel_id: "dm-channel",
        id: "interaction-2",
      } as unknown as ButtonInteraction["rawData"],
    });
    await button.run(secondInteraction, { cid: "btn_1" } as ComponentData);

    expect(dispatchReplyMock).toHaveBeenCalledTimes(2);
    const entry = resolveDiscordComponentEntry({ id: "btn_1", consume: false });
    if (!entry) {
      throw new Error("expected reusable Discord component entry");
    }
    expect(entry.id).toBe("btn_1");
  });

  it("blocks buttons when allowedUsers does not match", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ allowedUsers: ["999"] })],
      modals: [],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
    const entry = resolveDiscordComponentEntry({ id: "btn_1", consume: false });
    if (!entry) {
      throw new Error("expected unauthorized Discord component entry to remain active");
    }
    expect(entry.id).toBe("btn_1");
  });

  it("blocks buttons from guilds removed from the allowlist", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(
      createComponentContext({
        cfg: {
          channels: { discord: { replyToMode: "first", groupPolicy: "allowlist" } },
        } as OpenClawConfig,
        discordConfig: createDiscordConfig({ groupPolicy: "allowlist" }),
        guildEntries: {},
      }),
    );
    const { interaction, reply } = createComponentButtonInteraction({
      rawData: {
        channel_id: "guild-channel",
        guild_id: "gone",
        id: "interaction-guild-removed",
        member: { roles: [] },
      } as unknown as ButtonInteraction["rawData"],
      guild: { id: "gone", name: "Test Guild" } as unknown as ButtonInteraction["guild"],
    });

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      title: "blocks buttons on disabled guild channels",
      guildId: "g1",
      interactionId: "interaction-guild-disabled",
      guildEntries: { g1: { channels: { "guild-channel": { enabled: false } } } },
    },
    {
      title: "blocks buttons on denied guild channels",
      guildId: "g1",
      interactionId: "interaction-guild-denied",
      guildEntries: { g1: { channels: { "guild-channel": { enabled: false } } } },
    },
  ])("$title", async ({ guildId, interactionId, guildEntries }) => {
    await expectBlockedGuildButton({ guildId, interactionId, guildEntries });
  });

  async function runModalSubmission(params?: { reusable?: boolean }) {
    registerDiscordComponentEntries({
      entries: [],
      modals: [createModalEntry({ reusable: params?.reusable ?? false })],
    });

    const modal = createDiscordComponentModal(
      createComponentContext({
        discordConfig: createDiscordConfig({ replyToMode: "all" }),
      }),
    );
    const { interaction, acknowledge } = createModalInteraction();

    await modal.run(interaction, { mid: "mdl_1" } as ComponentData);
    return { acknowledge };
  }

  async function expectBlockedGuildButton(params: {
    guildId: string;
    interactionId: string;
    guildEntries: Record<string, DiscordGuildEntryResolved>;
  }) {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(
      createComponentContext({
        cfg: {
          channels: { discord: { replyToMode: "first", groupPolicy: "allowlist" } },
        } as OpenClawConfig,
        discordConfig: createDiscordConfig({ groupPolicy: "allowlist" }),
        guildEntries: params.guildEntries,
      }),
    );
    const { interaction, reply } = createComponentButtonInteraction({
      rawData: {
        channel_id: "guild-channel",
        guild_id: params.guildId,
        id: params.interactionId,
        member: { roles: [] },
      } as unknown as ButtonInteraction["rawData"],
      guild: {
        id: params.guildId,
        name: "Test Guild",
      } as unknown as ButtonInteraction["guild"],
    });

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to use this button.",
      ephemeral: true,
    });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  }

  async function expectGuildModalAuth(params: {
    allowFrom: string[];
    interactionId: string;
    expectedAuthorized: boolean;
  }) {
    registerDiscordComponentEntries({
      entries: [],
      modals: [createModalEntry()],
    });

    const modal = createDiscordComponentModal(
      createComponentContext({
        cfg: {
          commands: { useAccessGroups: true },
          channels: { discord: { replyToMode: "first" } },
        } as OpenClawConfig,
        allowFrom: params.allowFrom,
      }),
    );
    const { interaction, acknowledge } = createModalInteraction({
      rawData: {
        channel_id: "guild-channel",
        guild_id: "guild-1",
        id: params.interactionId,
        member: { roles: [] },
      } as unknown as ModalInteraction["rawData"],
      guild: { id: "guild-1", name: "Test Guild" } as unknown as ModalInteraction["guild"],
    });

    await modal.run(interaction, { mid: "mdl_1" } as ComponentData);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.CommandAuthorized).toBe(params.expectedAuthorized);
  }

  it("routes modal submissions with field values", async () => {
    const { acknowledge } = await runModalSubmission();

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.BodyForAgent).toContain('Form "Details" submitted.');
    expect(lastDispatchCtx?.BodyForAgent).toContain("- Name: Casey");
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(resolveDiscordModalEntry({ id: "mdl_1" })).toBeNull();
  });

  it.each([
    {
      title: "does not mark guild modal events as command-authorized for non-allowlisted users",
      allowFrom: ["owner-1"],
      interactionId: "interaction-guild-1",
      expectedAuthorized: false,
    },
    {
      title: "marks guild modal events as command-authorized for allowlisted users",
      allowFrom: ["123456789"],
      interactionId: "interaction-guild-2",
      expectedAuthorized: true,
    },
  ])("$title", async ({ allowFrom, interactionId, expectedAuthorized }) => {
    await expectGuildModalAuth({ allowFrom, interactionId, expectedAuthorized });
  });

  it("keeps reusable modal entries active after submission", async () => {
    const { acknowledge } = await runModalSubmission({ reusable: true });

    expect(acknowledge).toHaveBeenCalledTimes(1);
    const entry = resolveDiscordModalEntry({ id: "mdl_1", consume: false });
    if (!entry) {
      throw new Error("expected reusable Discord modal entry");
    }
    expect(entry.id).toBe("mdl_1");
  });

  it("passes false auth to plugin Discord interactions for non-allowlisted guild users", async () => {
    await expectPluginGuildInteractionAuth({
      allowFrom: ["owner-1"],
      interactionId: "interaction-guild-plugin-1",
      isAuthorizedSender: false,
    });
  });

  it("passes true auth to plugin Discord interactions for allowlisted guild users", async () => {
    await expectPluginGuildInteractionAuth({
      allowFrom: ["123456789"],
      interactionId: "interaction-guild-plugin-2",
      isAuthorizedSender: true,
    });
  });

  it("routes plugin Discord interactions in group DMs by channel id instead of sender id", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: true,
      handled: true,
      duplicate: false,
    });

    const button = createDiscordComponentButton(
      createComponentContext({
        discordConfig: createDiscordConfig({
          dm: {
            groupEnabled: true,
            groupChannels: ["group-dm-1"],
          },
        }),
      }),
    );
    const { interaction } = createComponentButtonInteraction({
      rawData: {
        channel_id: "group-dm-1",
        id: "interaction-group-dm-1",
      } as unknown as ButtonInteraction["rawData"],
      channel: {
        id: "group-dm-1",
        type: ChannelType.GroupDM,
      } as unknown as ButtonInteraction["channel"],
    });

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(1);
    const ctx = getLastPluginDispatchCtx();
    expect(ctx?.conversationId).toBe("channel:group-dm-1");
    expect(ctx?.senderId).toBe("123456789");
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("marks built-in Group DM component fallbacks with group metadata", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry()],
      modals: [],
    });

    const button = createDiscordComponentButton(
      createComponentContext({
        discordConfig: createDiscordConfig({
          dm: {
            groupEnabled: true,
            groupChannels: ["group-dm-1"],
          },
        }),
      }),
    );
    const { interaction, reply } = createComponentButtonInteraction({
      rawData: {
        channel_id: "group-dm-1",
        id: "interaction-group-dm-fallback",
      } as unknown as ButtonInteraction["rawData"],
      channel: {
        id: "group-dm-1",
        type: ChannelType.GroupDM,
        name: "incident-room",
      } as unknown as ButtonInteraction["channel"],
    });

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    expect(lastDispatchCtx?.From).toBe("discord:group:group-dm-1");
    expect(lastDispatchCtx?.ChatType).toBe("group");
    expect(lastDispatchCtx?.ConversationLabel).toBe(
      "Group DM #incident-room channel id:group-dm-1",
    );
  });

  it("blocks Group DM modal triggers before showing the modal", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ kind: "modal-trigger", modalId: "mdl_1" })],
      modals: [createModalEntry()],
    });

    const button = createDiscordComponentButton(createComponentContext());
    const showModal = vi.fn().mockResolvedValue(undefined);
    const { interaction, reply } = createComponentButtonInteraction({
      rawData: {
        channel_id: "group-dm-1",
        id: "interaction-group-dm-modal-trigger",
      } as unknown as ButtonInteraction["rawData"],
      channel: {
        id: "group-dm-1",
        type: ChannelType.GroupDM,
        name: "incident-room",
      } as unknown as ButtonInteraction["channel"],
      showModal,
    });

    await button.run(interaction, { cid: "btn_1", mid: "mdl_1" } as ComponentData);

    expect(reply).toHaveBeenCalledWith({
      content: "Group DM interactions are disabled.",
      ephemeral: true,
    });
    expect(showModal).not.toHaveBeenCalled();
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("does not fall through to Claw when a plugin Discord interaction already replied", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockImplementation(async (params: unknown) => {
      const typedParams = params as {
        respond: { reply: (payload: { text: string; ephemeral: boolean }) => Promise<void> };
      };
      await typedParams.respond.reply({ text: "✓", ephemeral: true });
      return {
        matched: true,
        handled: true,
        duplicate: false,
      };
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("lets plugin Discord interactions clear components after acknowledging", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockImplementation(async (params: unknown) => {
      const typedParams = params as {
        respond: {
          acknowledge: () => Promise<void>;
          clearComponents: (payload: { text: string }) => Promise<void>;
        };
      };
      await typedParams.respond.acknowledge();
      await typedParams.respond.clearComponents({ text: "Handled" });
      return {
        matched: true,
        handled: true,
        duplicate: false,
      };
    });

    const button = createDiscordComponentButton(createComponentContext());
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const baseInteraction = createComponentButtonInteraction().interaction as unknown as Record<
      string,
      unknown
    >;
    const interaction = {
      ...baseInteraction,
      acknowledge,
      reply,
      update,
    } as unknown as ButtonInteraction;

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      content: "Handled",
      components: [],
    });
    expect(update).not.toHaveBeenCalled();
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("falls through to built-in Discord component routing when a plugin declines handling", async () => {
    registerDiscordComponentEntries({
      entries: [createButtonEntry({ callbackData: "codex:approve" })],
      modals: [],
    });
    dispatchPluginInteractiveHandlerMock.mockResolvedValue({
      matched: true,
      handled: false,
      duplicate: false,
    });

    const button = createDiscordComponentButton(createComponentContext());
    const { interaction, reply } = createComponentButtonInteraction();

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(dispatchPluginInteractiveHandlerMock).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ content: "✓", ephemeral: true });
    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
  });

  it("resolves plugin binding approvals without falling through to Claw", async () => {
    registerDiscordComponentEntries({
      entries: [
        createButtonEntry({
          callbackData: buildPluginBindingApprovalCustomId("approval-1", "allow-once"),
        }),
      ],
      modals: [],
    });
    const button = createDiscordComponentButton(createComponentContext());
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const baseInteraction = createComponentButtonInteraction().interaction as unknown as Record<
      string,
      unknown
    >;
    const interaction = {
      ...baseInteraction,
      acknowledge,
      followUp,
    } as unknown as ButtonInteraction;

    await button.run(interaction, { cid: "btn_1" } as ComponentData);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(editDiscordComponentMessageMock).toHaveBeenCalledTimes(1);
    const [target, messageId, payload, options] = firstMockCall(
      editDiscordComponentMessageMock,
      "editDiscordComponentMessageMock",
    );
    expect(target).toBe("user:123456789");
    expect(messageId).toBe("msg-1");
    expect(typeof (payload as { text?: unknown } | undefined)?.text).toBe("string");
    expect((options as { accountId?: unknown } | undefined)?.accountId).toBe("default");
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });
});
