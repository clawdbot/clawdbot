import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord-api-types/v10";
import * as commandRegistryModule from "openclaw/plugin-sdk/command-auth";
import type { ChatCommandDefinition, CommandArgsParsing } from "openclaw/plugin-sdk/command-auth";
import type { ModelsProviderData } from "openclaw/plugin-sdk/command-auth";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import * as globalsModule from "openclaw/plugin-sdk/runtime-env";
import {
  loadSessionStore,
  resolveStorePath,
  saveSessionStore,
} from "openclaw/plugin-sdk/session-store-runtime";
import * as commandTextModule from "openclaw/plugin-sdk/text-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineThrowingDiscordChannelGetter } from "../test-support/partial-channel.js";
import { resolveDiscordChannelContext } from "./agent-components-helpers.js";
import * as modelPickerPreferencesModule from "./model-picker-preferences.js";
import * as modelPickerModule from "./model-picker.js";
import { createModelsProviderData as createBaseModelsProviderData } from "./model-picker.test-utils.js";
import {
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect,
  replyWithDiscordModelPickerProviders,
  type DispatchDiscordCommandInteraction,
} from "./native-command-ui.js";
import { createNoopThreadBindingManager, type ThreadBindingManager } from "./thread-bindings.js";

type ModelPickerContext = Parameters<typeof createDiscordModelPickerFallbackButton>[0]["ctx"];
type PickerButton = ReturnType<typeof createDiscordModelPickerFallbackButton>;
type PickerSelect = ReturnType<typeof createDiscordModelPickerFallbackSelect>;
type PickerButtonInteraction = Parameters<PickerButton["run"]>[0];
type PickerButtonData = Parameters<PickerButton["run"]>[1];
type PickerSelectInteraction = Parameters<PickerSelect["run"]>[0];
type PickerSelectData = Parameters<PickerSelect["run"]>[1];

type MockInteraction = {
  user: { id: string; username: string; globalName: string };
  channel: { type: ChannelType; id: string; name?: string; parentId?: string };
  guild: { id: string } | null;
  rawData: { id: string; member: { roles: string[] } };
  values?: string[];
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
  acknowledged: boolean;
  client: object;
};

let tempDir: string;

function createModelsProviderData(entries: Record<string, string[]>): ModelsProviderData {
  return createBaseModelsProviderData(entries, { defaultProviderOrder: "sorted" });
}

async function waitForCondition(
  predicate: () => boolean,
  opts?: { attempts?: number; delayMs?: number },
): Promise<void> {
  const attempts = opts?.attempts ?? 50;
  const delayMs = opts?.delayMs ?? 0;
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("condition not met");
}

function createModelPickerContext(): ModelPickerContext {
  const cfg = {
    session: {
      store: path.join(tempDir, "sessions.json"),
    },
    channels: {
      discord: {
        dm: {
          enabled: true,
          policy: "open",
        },
      },
    },
  } as unknown as OpenClawConfig;

  return {
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    threadBindings: createNoopThreadBindingManager("default"),
    postApplySettleMs: 0,
  };
}

function createInteraction(params?: { userId?: string; values?: string[] }): MockInteraction {
  const userId = params?.userId ?? "owner";
  const interaction = {
    user: {
      id: userId,
      username: "tester",
      globalName: "Tester",
    },
    channel: {
      type: ChannelType.DM,
      id: "dm-1",
    },
    guild: null,
    rawData: {
      id: "interaction-1",
      member: { roles: [] },
    },
    values: params?.values,
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
    update: vi.fn().mockResolvedValue({ ok: true }),
    editReply: vi.fn().mockResolvedValue({ ok: true }),
    acknowledge: vi.fn(),
    acknowledged: false,
    client: {},
  };
  interaction.acknowledge.mockImplementation(async () => {
    interaction.acknowledged = true;
    return { ok: true };
  });
  return interaction;
}

function createDefaultModelPickerData(): ModelsProviderData {
  return createModelsProviderData({
    openai: ["gpt-4.1", "gpt-4o"],
    anthropic: ["claude-sonnet-4-5"],
  });
}

function createModelCommandDefinition(): ChatCommandDefinition {
  return {
    key: "model",
    nativeName: "model",
    description: "Switch model",
    textAliases: ["/model"],
    acceptsArgs: true,
    argsParsing: "none" as CommandArgsParsing,
    scope: "native",
  };
}

function mockModelCommandPipeline(modelCommand: ChatCommandDefinition) {
  vi.spyOn(commandRegistryModule, "findCommandByNativeName").mockImplementation((name) =>
    name === "model" ? modelCommand : undefined,
  );
  vi.spyOn(commandRegistryModule, "listChatCommands").mockReturnValue([modelCommand]);
  vi.spyOn(commandRegistryModule, "resolveCommandArgMenu").mockReturnValue(null);
}

function createModelsViewSelectData(): PickerSelectData {
  return {
    cmd: "model",
    act: "model",
    view: "models",
    u: "owner",
    p: "openai",
    pg: "1",
  };
}

function createModelsViewSubmitData(): PickerButtonData {
  return {
    cmd: "model",
    act: "submit",
    view: "models",
    u: "owner",
    p: "openai",
    pg: "1",
    mi: "2",
  };
}

async function safeInteractionCall<T>(_label: string, fn: () => Promise<T>): Promise<T | null> {
  return await fn();
}

function createDispatchSpy() {
  return vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({ accepted: true });
}

function createModelPickerFallbackButton(
  context: ModelPickerContext,
  dispatchCommandInteraction: DispatchDiscordCommandInteraction = createDispatchSpy(),
) {
  return createDiscordModelPickerFallbackButton({
    ctx: context,
    safeInteractionCall,
    dispatchCommandInteraction,
  });
}

function createModelPickerFallbackSelect(
  context: ModelPickerContext,
  dispatchCommandInteraction: DispatchDiscordCommandInteraction = createDispatchSpy(),
) {
  return createDiscordModelPickerFallbackSelect({
    ctx: context,
    safeInteractionCall,
    dispatchCommandInteraction,
  });
}

async function runSubmitButton(params: {
  context: ModelPickerContext;
  data: PickerButtonData;
  dispatchCommandInteraction?: DispatchDiscordCommandInteraction;
  userId?: string;
}) {
  const button = createModelPickerFallbackButton(params.context, params.dispatchCommandInteraction);
  const submitInteraction = createInteraction({ userId: params.userId ?? "owner" });
  await button.run(submitInteraction as unknown as PickerButtonInteraction, params.data);
  return submitInteraction;
}

async function runModelSelect(params: {
  context: ModelPickerContext;
  data?: PickerSelectData;
  dispatchCommandInteraction?: DispatchDiscordCommandInteraction;
  userId?: string;
  values?: string[];
}) {
  const select = createModelPickerFallbackSelect(params.context, params.dispatchCommandInteraction);
  const selectInteraction = createInteraction({
    userId: params.userId ?? "owner",
    values: params.values ?? ["gpt-4o"],
  });
  await select.run(
    selectInteraction as unknown as PickerSelectInteraction,
    params.data ?? createModelsViewSelectData(),
  );
  return selectInteraction;
}

function expectDispatchedModelSelection(params: {
  dispatchSpy: ReturnType<typeof createDispatchSpy>;
  model: string;
  runtime?: string;
}) {
  const dispatchCall = params.dispatchSpy.mock.calls[0]?.[0];
  expect(dispatchCall?.prompt).toBe(
    params.runtime
      ? `/model ${params.model} --runtime ${params.runtime}`
      : `/model ${params.model}`,
  );
  expect(dispatchCall?.commandArgs?.values?.model).toBe(params.model);
}

function createBoundThreadBindingManager(params: {
  accountId: string;
  threadId: string;
  targetSessionKey: string;
  agentId: string;
}): ThreadBindingManager {
  const baseManager = createNoopThreadBindingManager(params.accountId);
  const now = Date.now();
  return {
    ...baseManager,
    getIdleTimeoutMs: () => 24 * 60 * 60 * 1000,
    getMaxAgeMs: () => 0,
    getByThreadId: (threadId: string) =>
      threadId === params.threadId
        ? {
            accountId: params.accountId,
            channelId: "parent-1",
            threadId: params.threadId,
            targetKind: "subagent",
            targetSessionKey: params.targetSessionKey,
            agentId: params.agentId,
            boundBy: "system",
            boundAt: now,
            lastActivityAt: now,
            idleTimeoutMs: 24 * 60 * 60 * 1000,
            maxAgeMs: 0,
          }
        : baseManager.getByThreadId(threadId),
  };
}

describe("Discord model picker interactions", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-discord-model-picker-"));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("registers distinct fallback ids for button and select handlers", () => {
    const context = createModelPickerContext();
    const button = createModelPickerFallbackButton(context);
    const select = createModelPickerFallbackSelect(context);

    expect(button.customId).not.toBe(select.customId);
    expect(button.customId.split(":")[0]).toBe(
      modelPickerModule.DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
    );
    expect(select.customId.split(":")[0]).toBe(
      modelPickerModule.DISCORD_MODEL_PICKER_CUSTOM_ID_KEY,
    );
  });

  it("ignores interactions from users other than the picker owner", async () => {
    const context = createModelPickerContext();
    const loadSpy = vi.spyOn(modelPickerModule, "loadDiscordModelPickerData");
    const button = createModelPickerFallbackButton(context);
    const interaction = createInteraction({ userId: "intruder" });

    const data: PickerButtonData = {
      cmd: "model",
      act: "back",
      view: "providers",
      u: "owner",
      pg: "1",
    };

    await button.run(interaction as unknown as PickerButtonInteraction, data);

    expect(interaction.acknowledge).toHaveBeenCalledTimes(1);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("defers owner picker interactions before loading model data", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const loadSpy = vi
      .spyOn(modelPickerModule, "loadDiscordModelPickerData")
      .mockImplementation(async () => {
        expect(interaction.acknowledge).toHaveBeenCalledTimes(1);
        return pickerData;
      });
    const select = createModelPickerFallbackSelect(context);
    const interaction = createInteraction({ userId: "owner", values: ["gpt-4o"] });

    await select.run(
      interaction as unknown as PickerSelectInteraction,
      createModelsViewSelectData(),
    );

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.update).not.toHaveBeenCalled();
  });

  it("requires submit click before routing selected model through /model pipeline", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();

    const selectInteraction = await runModelSelect({
      context,
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(selectInteraction.editReply).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();

    const submitInteraction = await runSubmitButton({
      context,
      data: createModelsViewSubmitData(),
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(submitInteraction.editReply).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
    });
  });

  it("applies the selected model even when component channel.name throws on a partial channel", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();
    const submitInteraction = createInteraction({ userId: "owner" });
    defineThrowingDiscordChannelGetter(submitInteraction.channel, "name");

    const button = createModelPickerFallbackButton(context, dispatchSpy);
    await button.run(
      submitInteraction as unknown as PickerButtonInteraction,
      createModelsViewSubmitData(),
    );

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
    });
  });

  it("applies the selected model even when component thread parent.name throws on a partial channel", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.guild = { id: "guild-1" };
    const threadChannel = {
      type: ChannelType.PublicThread,
      id: "thread-1",
      parentId: "parent-1",
      parent: { id: "parent-1", name: "parent-name" },
    } as {
      type: ChannelType;
      id: string;
      parentId: string;
      parent?: { id?: string; name?: string };
    };
    submitInteraction.channel = threadChannel as MockInteraction["channel"];
    defineThrowingDiscordChannelGetter(
      threadChannel.parent as { id?: string; name?: string },
      "name",
    );

    const button = createModelPickerFallbackButton(context, dispatchSpy);
    await button.run(
      submitInteraction as unknown as PickerButtonInteraction,
      createModelsViewSubmitData(),
    );

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
    });
  });

  it("routes selected runtime through the /model pipeline", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    pickerData.runtimeChoicesByProvider = new Map([
      [
        "openai",
        [
          {
            id: "pi",
            label: "OpenClaw Pi Default",
            description: "Use the built-in OpenClaw Pi runtime.",
          },
          {
            id: "codex",
            label: "codex",
            description: "Run openai models through the codex harness.",
          },
        ],
      ],
    ]);
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();
    await runSubmitButton({
      context,
      data: {
        ...createModelsViewSubmitData(),
        r: "codex",
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
      runtime: "codex",
    });
  });

  it("ignores category parent metadata for non-thread component channels", () => {
    const interaction = createInteraction({ userId: "owner" });
    interaction.guild = { id: "guild-1" };
    interaction.channel = {
      type: ChannelType.GuildText,
      id: "channel-1",
      name: "general",
      parentId: "category-1",
      parent: { id: "category-1", name: "category-name" },
    } as MockInteraction["channel"] & { parent?: { id?: string; name?: string } };

    const channelCtx = resolveDiscordChannelContext(
      interaction as unknown as Parameters<typeof resolveDiscordChannelContext>[0],
    );

    expect(channelCtx.isThread).toBe(false);
    expect(channelCtx.parentId).toBeUndefined();
    expect(channelCtx.parentName).toBeUndefined();
    expect(channelCtx.parentSlug).toBe("");
  });

  it("shows timeout status and skips recents write when apply is still processing", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const recordRecentSpy = vi
      .spyOn(modelPickerPreferencesModule, "recordDiscordModelPickerRecentModel")
      .mockResolvedValue();
    const dispatchSpy = createDispatchSpy();
    const withTimeoutSpy = vi
      .spyOn(commandTextModule, "withTimeout")
      .mockRejectedValue(new Error("timeout"));

    await runModelSelect({ context, dispatchCommandInteraction: dispatchSpy });

    const button = createModelPickerFallbackButton(context, dispatchSpy);
    const submitInteraction = createInteraction({ userId: "owner" });
    const submitData = createModelsViewSubmitData();

    await button.run(submitInteraction as unknown as PickerButtonInteraction, submitData);

    expect(withTimeoutSpy).toHaveBeenCalledTimes(1);
    await waitForCondition(() => dispatchSpy.mock.calls.length === 1);
    expect(submitInteraction.followUp).toHaveBeenCalledTimes(1);
    const followUpPayload = submitInteraction.followUp.mock.calls[0]?.[0] as {
      components?: Array<{ components?: Array<{ content?: string }> }>;
    };
    const followUpText = JSON.stringify(followUpPayload);
    expect(followUpText).toContain("still processing");
    expect(recordRecentSpy).not.toHaveBeenCalled();
  });

  it("clicking Recents button renders recents view", async () => {
    const context = createModelPickerContext();
    const pickerData = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
      anthropic: ["claude-sonnet-4-5"],
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue([
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-5",
    ]);

    const button = createModelPickerFallbackButton(context);
    const interaction = createInteraction({ userId: "owner" });

    const data: PickerButtonData = {
      cmd: "model",
      act: "recents",
      view: "recents",
      u: "owner",
      p: "openai",
      pg: "1",
    };

    await button.run(interaction as unknown as PickerButtonInteraction, data);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const updatePayload = interaction.editReply.mock.calls[0]?.[0];
    if (!updatePayload) {
      throw new Error("recents button did not emit an update payload");
    }
    const updateText = JSON.stringify(updatePayload);
    expect(updateText).toContain("gpt-4o");
    expect(updateText).toContain("claude-sonnet-4-5");
  });

  it("clicking recents model button applies model through /model pipeline", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue([
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-5",
    ]);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();

    // rs=2 -> first deduped recent (default is anthropic/claude-sonnet-4-5, so openai/gpt-4o remains)
    const submitInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "recents",
        u: "owner",
        pg: "1",
        rs: "2",
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(submitInteraction.editReply).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({ dispatchSpy, model: "openai/gpt-4o" });
  });

  it("verifies model state against the bound thread session", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      threadId: "thread-bound",
      targetSessionKey: "agent:worker:subagent:bound",
      agentId: "worker",
    });
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);
    const dispatchSpy = createDispatchSpy();
    const verboseSpy = vi.spyOn(globalsModule, "logVerbose").mockImplementation(() => {});

    const select = createModelPickerFallbackSelect(context, dispatchSpy);
    const selectInteraction = createInteraction({
      userId: "owner",
      values: ["gpt-4o"],
    });
    selectInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };
    const selectData = createModelsViewSelectData();
    await select.run(selectInteraction as unknown as PickerSelectInteraction, selectData);

    const button = createModelPickerFallbackButton(context, dispatchSpy);
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };
    const submitData = createModelsViewSubmitData();

    await button.run(submitInteraction as unknown as PickerButtonInteraction, submitData);

    const mismatchLog = verboseSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("model picker override mismatch"),
    )?.[0];
    expect(mismatchLog).toContain("session key agent:worker:subagent:bound");
  });

  it("persists suffixed LM Studio model overrides when dispatch leaves the routed session stale", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      threadId: "thread-bound",
      targetSessionKey: "agent:worker:subagent:bound",
      agentId: "worker",
    });
    const pickerData = createModelsProviderData({
      anthropic: ["claude-sonnet-4-5"],
      lmstudio: ["unsloth/gemma-4-26b-a4b-it@iq4_xs"],
    });
    const modelCommand = createModelCommandDefinition();
    const storePath = resolveStorePath(context.cfg.session?.store, { agentId: "worker" });
    await saveSessionStore(storePath, {
      "agent:worker:subagent:bound": {
        updatedAt: Date.now(),
        sessionId: "bound-session",
      },
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();
    const button = createModelPickerFallbackButton(context, dispatchSpy);
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };

    await button.run(submitInteraction as unknown as PickerButtonInteraction, {
      ...createModelsViewSubmitData(),
      p: "lmstudio",
      mi: "1",
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:worker:subagent:bound"]?.providerOverride).toBe("lmstudio");
    expect(store["agent:worker:subagent:bound"]?.modelOverride).toBe(
      "unsloth/gemma-4-26b-a4b-it@iq4_xs",
    );
    expect(store["agent:worker:subagent:bound"]?.liveModelSwitchPending).toBe(true);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "lmstudio/unsloth/gemma-4-26b-a4b-it@iq4_xs",
    });
    expect(JSON.stringify(submitInteraction.followUp.mock.calls[0]?.[0])).toContain(
      "✅ Model set to lmstudio/unsloth/gemma-4-26b-a4b-it@iq4_xs.",
    );
  });

  it("does not write a fallback override when hidden /model dispatch is rejected", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      threadId: "thread-bound",
      targetSessionKey: "agent:worker:subagent:bound",
      agentId: "worker",
    });
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();
    const storePath = resolveStorePath(context.cfg.session?.store, { agentId: "worker" });
    await saveSessionStore(storePath, {
      "agent:worker:subagent:bound": {
        updatedAt: Date.now(),
        sessionId: "bound-session",
      },
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const button = createModelPickerFallbackButton(
      context,
      vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({ accepted: false }),
    );
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };

    await button.run(
      submitInteraction as unknown as PickerButtonInteraction,
      createModelsViewSubmitData(),
    );

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store["agent:worker:subagent:bound"]?.providerOverride).toBeUndefined();
    expect(store["agent:worker:subagent:bound"]?.modelOverride).toBeUndefined();
    expect(JSON.stringify(submitInteraction.followUp.mock.calls[0]?.[0])).toContain(
      "❌ Failed to apply openai/gpt-4o.",
    );
  });

  it("loads model picker data from the effective bound route", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      threadId: "thread-bound",
      targetSessionKey: "agent:worker:subagent:bound",
      agentId: "worker",
    });
    const loadSpy = vi
      .spyOn(modelPickerModule, "loadDiscordModelPickerData")
      .mockResolvedValue(createDefaultModelPickerData());
    const interaction = createInteraction({ userId: "owner" });
    interaction.guild = { id: "guild-1" };
    interaction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
      name: "bound-thread",
      parentId: "parent-1",
    };

    await replyWithDiscordModelPickerProviders({
      interaction: interaction as never,
      cfg: context.cfg,
      command: "model",
      userId: "owner",
      accountId: context.accountId,
      threadBindings: context.threadBindings,
      preferFollowUp: false,
      safeInteractionCall: async (_label, fn) => await fn(),
    });

    expect(loadSpy).toHaveBeenCalledWith(context.cfg, "worker");
  });

  it("opens the first visible provider when the current model provider is filtered out", async () => {
    const context = createModelPickerContext();
    const pickerData = createModelsProviderData({
      "openai-codex": ["gpt-5.5-codex"],
      vllm: ["qwen3-local"],
    });
    pickerData.resolvedDefault = {
      provider: "anthropic",
      model: "claude-opus-4-5",
    };
    const loadSpy = vi
      .spyOn(modelPickerModule, "loadDiscordModelPickerData")
      .mockResolvedValue(pickerData);
    const interaction = createInteraction({ userId: "owner" });

    await replyWithDiscordModelPickerProviders({
      interaction: interaction as never,
      cfg: {
        ...context.cfg,
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
            models: {
              "openai-codex/*": {},
              "vllm/*": {},
            },
          },
        },
      } as OpenClawConfig,
      command: "model",
      userId: "owner",
      accountId: context.accountId,
      threadBindings: context.threadBindings,
      preferFollowUp: false,
      safeInteractionCall: async (_label, fn) => await fn(),
    });

    expect(loadSpy).toHaveBeenCalledWith(expect.any(Object), "main");
    const payload = JSON.stringify(interaction.reply.mock.calls[0]?.[0]);
    expect(payload).toContain("openai-codex");
    expect(payload).toContain("gpt-5.5-codex");
    expect(payload).not.toContain("Provider not found");
  });
});
