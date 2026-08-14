// Discord tests cover native command.model picker plugin behavior.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord-api-types/v10";
import * as commandRegistryModule from "openclaw/plugin-sdk/command-auth-native";
import type {
  ChatCommandDefinition,
  CommandArgsParsing,
} from "openclaw/plugin-sdk/command-auth-native";
import type { ModelsProviderData } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import * as runtimeConfigSnapshotModule from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as commandTextModule from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineThrowingDiscordChannelGetter } from "../test-support/partial-channel.js";
import { resolveDiscordChannelContext } from "./agent-components-context.js";
import * as modelPickerPreferencesModule from "./model-picker-preferences.js";
import * as modelPickerModule from "./model-picker.state.js";
import { createModelsProviderData as createBaseModelsProviderData } from "./model-picker.test-utils.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import { applyDiscordModelPickerSelection } from "./native-command-model-picker-apply.js";
import {
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect,
  replyWithDiscordModelPickerProviders,
} from "./native-command-ui.js";
import { createNoopThreadBindingManager, type ThreadBindingManager } from "./thread-bindings.js";

vi.mock("openclaw/plugin-sdk/runtime-env", { spy: true });

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

function createResolvedAgentRoute(overrides: Partial<ResolvedAgentRoute> = {}): ResolvedAgentRoute {
  return {
    agentId: "main",
    channel: "discord",
    accountId: "default",
    sessionKey: "agent:main:discord:dm:owner",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "session",
    matchedBy: "default",
    ...overrides,
  };
}

function createModelsProviderData(entries: Record<string, string[]>): ModelsProviderData {
  return createBaseModelsProviderData(entries, { defaultProviderOrder: "sorted" });
}

function createModelPickerContext(): ModelPickerContext {
  const cfg = {
    session: {
      store: path.join(tempDir, "sessions.json"),
    },
    channels: {
      discord: {
        dmPolicy: "open",
        dm: {
          enabled: true,
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

type MockWithCalls = { mock: { calls: unknown[][] } };

function firstMockArg(mock: MockWithCalls, label: string) {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
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
  const dispatchCall = firstMockArg(params.dispatchSpy, "dispatchCommandInteraction") as
    | Parameters<DispatchDiscordCommandInteraction>[0]
    | undefined;
  expect(dispatchCall?.prompt).toBe(
    params.runtime
      ? `/model ${params.model} --runtime ${params.runtime}`
      : `/model ${params.model}`,
  );
  expect(dispatchCall?.commandArgs?.values?.model).toBe(params.model);
  expect(dispatchCall?.commandArgs?.raw).toBe(
    params.runtime ? `${params.model} --runtime ${params.runtime}` : params.model,
  );
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
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSnapshot").mockReturnValue(null);
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSourceSnapshot").mockReturnValue(null);
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

  it.each(["back", "nav", "bucket"] as const)(
    "preserves the selected provider bucket for %s interactions",
    async (action) => {
      const context = createModelPickerContext();
      const providers = Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [
          `provider-${String(index + 1).padStart(2, "0")}`,
          ["model"],
        ]),
      );
      vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(
        createModelsProviderData(providers),
      );
      const selectingBucket = action === "bucket";
      const interaction = createInteraction({
        userId: "owner",
        ...(selectingBucket ? { values: ["21-30"] } : {}),
      });
      const data = {
        cmd: "model",
        act: action,
        view: "providers",
        u: "owner",
        pg: "3",
        pb: selectingBucket ? "1-20" : "21-30",
      };

      if (selectingBucket) {
        await createModelPickerFallbackSelect(context).run(
          interaction as unknown as PickerSelectInteraction,
          data,
        );
      } else {
        await createModelPickerFallbackButton(context).run(
          interaction as unknown as PickerButtonInteraction,
          data,
        );
      }

      const rendered = JSON.stringify(firstMockArg(interaction.editReply, "interaction.editReply"));
      expect(rendered).toContain('"value":"provider-21"');
      expect(rendered).not.toContain('"value":"provider-01"');
    },
  );

  it("uses the hot-reloaded runtime config when old components reset to default", async () => {
    const context = createModelPickerContext();
    (context.cfg as { agents?: OpenClawConfig["agents"] }).agents = {
      defaults: {
        model: { primary: "openai/gpt-5.5" },
        models: {
          "openai/gpt-5.5": {},
        },
      },
    };
    const runtimeCfg = {
      ...context.cfg,
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-terra" },
          models: {
            "openai/gpt-5.5": {},
            "openai/gpt-5.6-terra": {},
          },
        },
      },
    } as OpenClawConfig;
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSnapshot").mockReturnValue(runtimeCfg);
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSourceSnapshot").mockReturnValue(
      runtimeCfg,
    );

    const staleData = createModelsProviderData({ openai: ["gpt-5.5"] });
    staleData.resolvedDefault = { provider: "openai", model: "gpt-5.5" };
    const runtimeData = createModelsProviderData({
      openai: ["gpt-5.5", "gpt-5.6-terra"],
    });
    runtimeData.resolvedDefault = { provider: "openai", model: "gpt-5.6-terra" };
    const loadSpy = vi
      .spyOn(modelPickerModule, "loadDiscordModelPickerData")
      .mockImplementation(async (cfg) => (cfg === runtimeCfg ? runtimeData : staleData));
    const modelCommand = createModelCommandDefinition();
    mockModelCommandPipeline(modelCommand);
    const dispatchSpy = createDispatchSpy();

    const resetInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "reset",
        view: "models",
        u: "owner",
        pg: "1",
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(loadSpy).toHaveBeenCalledWith(runtimeCfg, "main");
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-5.6-terra",
    });
    const dispatchCall = firstMockArg(dispatchSpy, "dispatchCommandInteraction") as
      | Parameters<DispatchDiscordCommandInteraction>[0]
      | undefined;
    expect(dispatchCall?.cfg).toBe(runtimeCfg);
    expect(resetInteraction.followUp).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "configured-default request",
      suppressedText:
        "Model set to openai/gpt-4o for this session. Configured default update requested.",
    },
    {
      label: "immutable configured default",
      suppressedText:
        "Model set to openai/gpt-4o for this session. Configured default unchanged because configuration is immutable.",
    },
    {
      label: "session-only selection",
      suppressedText:
        "Model set to openai/gpt-4o for this session only; configured default unchanged.",
    },
    {
      label: "generic fallback",
      suppressedText: undefined,
    },
  ])("renders the $label result after authoritative verification", async ({ suppressedText }) => {
    const context = createModelPickerContext();
    const result = await applyDiscordModelPickerSelection({
      interaction: createInteraction() as unknown as PickerButtonInteraction,
      selectionCommand: {
        prompt: "/model openai/gpt-4o",
        command: createModelCommandDefinition(),
      },
      dispatchCommandInteraction: vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({
        accepted: true,
        ...(suppressedText ? { hiddenFinalReply: { text: `\n ${suppressedText} \n` } } : {}),
      }),
      cfg: context.cfg,
      discordConfig: context.discordConfig,
      accountId: context.accountId,
      sessionPrefix: context.sessionPrefix,
      threadBindings: context.threadBindings,
      route: createResolvedAgentRoute(),
      resolvedModelRef: "openai/gpt-4o",
      preferenceScope: { accountId: "default", userId: "owner" },
      settleMs: 0,
      resolveCurrentModel: () => "openai/gpt-4o",
      resolveCurrentRuntime: () => "auto",
    });

    expect(result).toEqual({
      status: "success",
      effectiveModelRef: "openai/gpt-4o",
      noticeMessage: suppressedText ?? "✅ Model set to openai/gpt-4o.",
    });
  });

  it("keeps the mismatch warning when the hidden reply looked successful", async () => {
    const context = createModelPickerContext();
    const interaction = createInteraction();
    const recordRecentSpy = vi
      .spyOn(modelPickerPreferencesModule, "recordDiscordModelPickerRecentModel")
      .mockResolvedValue();
    const result = await applyDiscordModelPickerSelection({
      interaction: interaction as unknown as PickerButtonInteraction,
      selectionCommand: {
        prompt: "/model openai/gpt-4o",
        command: createModelCommandDefinition(),
      },
      dispatchCommandInteraction: vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({
        accepted: true,
        hiddenFinalReply: {
          text: "Model set to openai/gpt-4o for this session. Configured default update requested.",
        },
      }),
      cfg: context.cfg,
      discordConfig: context.discordConfig,
      accountId: context.accountId,
      sessionPrefix: context.sessionPrefix,
      threadBindings: context.threadBindings,
      route: createResolvedAgentRoute(),
      resolvedModelRef: "openai/gpt-4o",
      preferenceScope: { accountId: "default", userId: "owner" },
      settleMs: 0,
      resolveCurrentModel: () => "openai/gpt-4.1",
      resolveCurrentRuntime: () => "codex",
    });

    expect(result).toEqual({
      status: "mismatch",
      effectiveModelRef: "openai/gpt-4.1",
      noticeMessage:
        "⚠️ Tried to set openai/gpt-4o, but current selection is openai/gpt-4.1 with runtime codex.",
    });
    expect(recordRecentSpy).not.toHaveBeenCalled();
  });

  it("reports a hidden model error with the authoritative current selection", async () => {
    const context = createModelPickerContext();
    const recordRecentSpy = vi
      .spyOn(modelPickerPreferencesModule, "recordDiscordModelPickerRecentModel")
      .mockResolvedValue();
    const resolveCurrentModel = vi.fn(() => "openai/gpt-4.1");
    const resolveCurrentRuntime = vi.fn(() => "codex");
    const result = await applyDiscordModelPickerSelection({
      interaction: createInteraction() as unknown as PickerButtonInteraction,
      selectionCommand: {
        prompt: "/model openai/gpt-4o",
        command: createModelCommandDefinition(),
      },
      dispatchCommandInteraction: vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({
        accepted: true,
        hiddenFinalReply: {
          text: "  Model change was not applied because the session changed.  ",
          isError: true,
        },
      }),
      cfg: context.cfg,
      discordConfig: context.discordConfig,
      accountId: context.accountId,
      sessionPrefix: context.sessionPrefix,
      threadBindings: context.threadBindings,
      route: createResolvedAgentRoute(),
      resolvedModelRef: "openai/gpt-4o",
      preferenceScope: { accountId: "default", userId: "owner" },
      settleMs: 0,
      resolveCurrentModel,
      resolveCurrentRuntime,
    });

    expect(result).toEqual({
      status: "rejected",
      noticeMessage:
        "Model change was not applied because the session changed.\nCurrent selection: openai/gpt-4.1 with runtime codex.",
    });
    expect(resolveCurrentModel).toHaveBeenCalledOnce();
    expect(resolveCurrentRuntime).toHaveBeenCalledOnce();
    expect(recordRecentSpy).not.toHaveBeenCalled();
  });

  it.each([
    { selectedRuntime: "codex", currentRuntime: "codex", expectedStatus: "success" },
    { selectedRuntime: "auto", currentRuntime: "auto", expectedStatus: "success" },
    { selectedRuntime: "default", currentRuntime: "auto", expectedStatus: "success" },
    { selectedRuntime: "codex", currentRuntime: "auto", expectedStatus: "mismatch" },
  ])(
    "verifies authoritative runtime $selectedRuntime against $currentRuntime",
    async ({ selectedRuntime, currentRuntime, expectedStatus }) => {
      const context = createModelPickerContext();
      const recordRecentSpy = vi
        .spyOn(modelPickerPreferencesModule, "recordDiscordModelPickerRecentModel")
        .mockResolvedValue();
      const result = await applyDiscordModelPickerSelection({
        interaction: createInteraction() as unknown as PickerButtonInteraction,
        selectionCommand: {
          prompt: `/model openai/gpt-4o --runtime ${selectedRuntime}`,
          command: createModelCommandDefinition(),
        },
        dispatchCommandInteraction: vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({
          accepted: true,
          hiddenFinalReply: { text: "scope-aware core notice" },
        }),
        cfg: context.cfg,
        discordConfig: context.discordConfig,
        accountId: context.accountId,
        sessionPrefix: context.sessionPrefix,
        threadBindings: context.threadBindings,
        route: createResolvedAgentRoute(),
        resolvedModelRef: "openai/gpt-4o",
        selectedRuntime,
        preferenceScope: { accountId: "default", userId: "owner" },
        settleMs: 0,
        resolveCurrentModel: () => "openai/gpt-4o",
        resolveCurrentRuntime: () => currentRuntime,
      });

      expect(result.status).toBe(expectedStatus);
      if (expectedStatus === "success") {
        expect(result.noticeMessage).toBe("scope-aware core notice");
        expect(recordRecentSpy).toHaveBeenCalledOnce();
      } else {
        expect(result.noticeMessage).toBe(
          "⚠️ Tried to set openai/gpt-4o with runtime codex, but current selection is openai/gpt-4o with runtime auto.",
        );
        expect(recordRecentSpy).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps a pending model stable when hot reload reorders the catalog", async () => {
    const context = createModelPickerContext();
    const runtimeCfg = { ...context.cfg } as OpenClawConfig;
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSnapshot").mockReturnValue(runtimeCfg);
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSourceSnapshot").mockReturnValue(
      runtimeCfg,
    );

    const runtimeData = createModelsProviderData({ openai: ["a", "aa", "b"] });
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(runtimeData);
    mockModelCommandPipeline(createModelCommandDefinition());
    const dispatchSpy = createDispatchSpy();

    const submitInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "models",
        u: "owner",
        p: "openai",
        pg: "1",
        m: modelPickerModule.createDiscordModelPickerModelToken("openai", "b"),
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expectDispatchedModelSelection({ dispatchSpy, model: "openai/b" });
    expect(submitInteraction.followUp).toHaveBeenCalledOnce();

    dispatchSpy.mockClear();
    const legacyInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "models",
        u: "owner",
        p: "openai",
        pg: "1",
        mi: "2",
      },
      dispatchCommandInteraction: dispatchSpy,
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(
      JSON.stringify(firstMockArg(legacyInteraction.editReply, "interaction.editReply")),
    ).toContain("selection expired");
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

  it.each(["codex", "auto", "default"])(
    "routes selected runtime %s through the hidden /model command",
    async (runtime) => {
      const context = createModelPickerContext();
      const pickerData = createDefaultModelPickerData();
      pickerData.runtimeChoicesByProvider = new Map([
        [
          "openai",
          [
            { id: "codex", label: "Codex", description: "Use Codex." },
            { id: "openclaw", label: "OpenClaw Default", description: "Use OpenClaw." },
          ],
        ],
      ]);
      const modelCommand = createModelCommandDefinition();

      vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
      mockModelCommandPipeline(modelCommand);

      const dispatchSpy = createDispatchSpy();
      const submitInteraction = await runSubmitButton({
        context,
        data: { ...createModelsViewSubmitData(), r: runtime },
        dispatchCommandInteraction: dispatchSpy,
      });

      expect(submitInteraction.editReply).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      expectDispatchedModelSelection({
        dispatchSpy,
        model: "openai/gpt-4o",
        runtime,
      });
    },
  );

  it("does not carry the current runtime to another provider", async () => {
    const context = createModelPickerContext();
    (context.cfg as { agents?: { defaults?: { agentRuntime?: { id: string } } } }).agents = {
      defaults: { agentRuntime: { id: "codex" } },
    };
    const pickerData = createDefaultModelPickerData();
    pickerData.runtimeChoicesByProvider = new Map([
      [
        "openai",
        [
          { id: "codex", label: "Codex", description: "Use Codex." },
          { id: "openclaw", label: "OpenClaw Default", description: "Use OpenClaw." },
        ],
      ],
    ]);
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();
    await runSubmitButton({
      context,
      data: { ...createModelsViewSubmitData(), p: "anthropic", mi: "1" },
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "anthropic/claude-sonnet-4-5",
    });
  });

  it("keeps legacy model indices in JavaScript code-unit order", async () => {
    const context = createModelPickerContext();
    const pickerData = createModelsProviderData({
      openai: ["a-model", "Z-model"],
    });
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(createModelCommandDefinition());
    const dispatchSpy = createDispatchSpy();

    await runSubmitButton({
      context,
      data: {
        ...createModelsViewSubmitData(),
        mi: "1",
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/Z-model",
    });
  });

  it("does not treat legacy agentRuntime config as current picker state", async () => {
    const context = createModelPickerContext();
    (context.cfg as { agents?: { defaults?: { agentRuntime?: { id: string } } } }).agents = {
      defaults: { agentRuntime: { id: "claude-cli" } },
    };
    const pickerData = createDefaultModelPickerData();
    pickerData.runtimeChoicesByProvider = new Map([
      [
        "anthropic",
        [
          { id: "openclaw", label: "OpenClaw Default", description: "Use OpenClaw." },
          { id: "claude-cli", label: "Claude CLI", description: "Use Claude CLI." },
        ],
      ],
    ]);
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = createDispatchSpy();
    await runSubmitButton({
      context,
      data: { ...createModelsViewSubmitData(), p: "anthropic", mi: "1" },
      dispatchCommandInteraction: dispatchSpy,
    });

    expectDispatchedModelSelection({
      dispatchSpy,
      model: "anthropic/claude-sonnet-4-5",
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
    await vi.waitFor(() => expect(dispatchSpy).toHaveBeenCalledTimes(1));
    expect(submitInteraction.followUp).toHaveBeenCalledTimes(1);
    const followUpPayload = firstMockArg(submitInteraction.followUp, "interaction.followUp") as {
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
    const updatePayload = firstMockArg(interaction.editReply, "interaction.editReply");
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

  it("keeps a recent model stable when hot reload shifts its slot", async () => {
    const context = createModelPickerContext();
    const runtimeCfg = { ...context.cfg } as OpenClawConfig;
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSnapshot").mockReturnValue(runtimeCfg);
    vi.spyOn(runtimeConfigSnapshotModule, "getRuntimeConfigSourceSnapshot").mockReturnValue(
      runtimeCfg,
    );
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(
      createModelsProviderData({ openai: ["a", "b"] }),
    );
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue([
      "openai/a",
      "openai/b",
    ]);
    mockModelCommandPipeline(createModelCommandDefinition());
    const dispatchSpy = createDispatchSpy();

    await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "recents",
        u: "owner",
        pg: "1",
        m: modelPickerModule.createDiscordModelPickerModelToken("openai", "b"),
      },
      dispatchCommandInteraction: dispatchSpy,
    });
    expectDispatchedModelSelection({ dispatchSpy, model: "openai/b" });

    dispatchSpy.mockClear();
    const legacyInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "recents",
        u: "owner",
        pg: "1",
        rs: "1",
      },
      dispatchCommandInteraction: dispatchSpy,
    });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(
      JSON.stringify(firstMockArg(legacyInteraction.editReply, "interaction.editReply")),
    ).toContain("selection expired");
  });

  it("does not decode compact recents runtime against another provider", async () => {
    const context = createModelPickerContext();
    const pickerData = createModelsProviderData({
      openai: ["gpt-4o"],
      anthropic: ["claude-sonnet-4-5"],
    });
    pickerData.runtimeChoicesByProvider = new Map([
      ["openai", [{ id: "codex", label: "Codex", description: "Use Codex." }]],
      [
        "anthropic",
        [
          { id: "codex", label: "Codex", description: "Use Codex." },
          { id: "claude-cli", label: "Claude CLI", description: "Use Claude CLI." },
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
        cmd: "model",
        act: "submit",
        view: "recents",
        u: "owner",
        p: "openai",
        ri: "1",
        pg: "1",
        rs: "1",
      },
      dispatchCommandInteraction: dispatchSpy,
    });

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "anthropic/claude-sonnet-4-5",
    });
  });

  it("verifies the effective route returned by the core command", async () => {
    const context = createModelPickerContext();
    const effectiveRoute = createResolvedAgentRoute({
      agentId: "worker",
      sessionKey: "agent:worker:subagent:bound",
      mainSessionKey: "agent:worker:main",
    });
    const seenRoutes: unknown[] = [];
    const result = await applyDiscordModelPickerSelection({
      interaction: createInteraction() as unknown as PickerButtonInteraction,
      selectionCommand: {
        prompt: "/model openai/gpt-4o",
        command: createModelCommandDefinition(),
      },
      dispatchCommandInteraction: vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({
        accepted: true,
        effectiveRoute,
      }),
      cfg: context.cfg,
      discordConfig: context.discordConfig,
      accountId: context.accountId,
      sessionPrefix: context.sessionPrefix,
      threadBindings: context.threadBindings,
      route: createResolvedAgentRoute(),
      resolvedModelRef: "openai/gpt-4o",
      preferenceScope: { accountId: "default", userId: "owner" },
      settleMs: 0,
      resolveCurrentModel: (route) => {
        seenRoutes.push(route);
        return "openai/gpt-4.1";
      },
      resolveCurrentRuntime: (route) => {
        seenRoutes.push(route);
        return "auto";
      },
    });

    expect(seenRoutes).toEqual([effectiveRoute, effectiveRoute]);
    expect(result).toEqual({
      status: "mismatch",
      effectiveModelRef: "openai/gpt-4.1",
      noticeMessage:
        "⚠️ Tried to set openai/gpt-4o, but current selection is openai/gpt-4.1 with runtime auto.",
    });
  });

  it("reports a rejected hidden /model dispatch without reading authoritative state", async () => {
    const context = createModelPickerContext();
    const resolveCurrentModel = vi.fn(() => "openai/gpt-4.1");
    const resolveCurrentRuntime = vi.fn(() => "auto");
    const result = await applyDiscordModelPickerSelection({
      interaction: createInteraction() as unknown as PickerButtonInteraction,
      selectionCommand: {
        prompt: "/model openai/gpt-4o",
        command: createModelCommandDefinition(),
      },
      dispatchCommandInteraction: vi.fn<DispatchDiscordCommandInteraction>().mockResolvedValue({
        accepted: false,
      }),
      cfg: context.cfg,
      discordConfig: context.discordConfig,
      accountId: context.accountId,
      sessionPrefix: context.sessionPrefix,
      threadBindings: context.threadBindings,
      route: createResolvedAgentRoute(),
      resolvedModelRef: "openai/gpt-4o",
      preferenceScope: { accountId: "default", userId: "owner" },
      settleMs: 0,
      resolveCurrentModel,
      resolveCurrentRuntime,
    });

    expect(result).toEqual({
      status: "rejected",
      noticeMessage: "❌ Failed to apply openai/gpt-4o. Try /model openai/gpt-4o directly.",
    });
    expect(resolveCurrentModel).not.toHaveBeenCalled();
    expect(resolveCurrentRuntime).not.toHaveBeenCalled();
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
      openai: ["gpt-5.5-codex"],
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
    const cfg = {
      ...context.cfg,
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "openai/*": {},
            "vllm/*": {},
          },
        },
      },
    } as OpenClawConfig;

    await replyWithDiscordModelPickerProviders({
      interaction: interaction as never,
      cfg,
      command: "model",
      userId: "owner",
      accountId: context.accountId,
      threadBindings: context.threadBindings,
      preferFollowUp: false,
      safeInteractionCall: async (_label, fn) => await fn(),
    });

    expect(loadSpy).toHaveBeenCalledWith(cfg, "main");
    const payload = JSON.stringify(firstMockArg(interaction.reply, "interaction.reply"));
    expect(payload).toContain("openai");
    expect(payload).toContain("gpt-5.5-codex");
    expect(payload).not.toContain("Provider not found");
  });

  it("opens the current provider bucket on initial large-provider renders", async () => {
    const context = createModelPickerContext();
    const entries = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `provider-${String(i + 1).padStart(2, "0")}`,
        ["model"],
      ]),
    );
    const pickerData = createModelsProviderData(entries);
    pickerData.resolvedDefault = { provider: "provider-30", model: "model" };
    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    const interaction = createInteraction({ userId: "owner" });

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

    const payload = JSON.stringify(firstMockArg(interaction.reply, "interaction.reply"));
    expect(payload).toContain("provider-30");
    expect(payload).toContain(";a=back;v=providers;");
    expect(payload).toContain(";pb=");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
