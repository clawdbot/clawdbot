import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelType, type AutocompleteInteraction } from "@buape/carbon";
import type { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { clearSessionStoreCacheForTest } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

type ConversationRuntimeModule = typeof import("openclaw/plugin-sdk/conversation-binding-runtime");
type ResolveConfiguredBindingRoute = ConversationRuntimeModule["resolveConfiguredBindingRoute"];
type ConfiguredBindingRouteResult = ReturnType<ResolveConfiguredBindingRoute>;
type EnsureConfiguredBindingRouteReady =
  ConversationRuntimeModule["ensureConfiguredBindingRouteReady"];

function createUnboundConfiguredRouteResult(): ConfiguredBindingRouteResult {
  return {
    bindingResolution: null,
    route: {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: SESSION_KEY,
      mainSessionKey: SESSION_KEY,
      lastRoutePolicy: "main",
      matchedBy: "default",
    },
  };
}
const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() =>
  vi.fn<EnsureConfiguredBindingRouteReady>(async () => ({ ok: true })),
);
const resolveConfiguredBindingRouteMock = vi.hoisted(() =>
  vi.fn<ResolveConfiguredBindingRoute>(() => createUnboundConfiguredRouteResult()),
);
const providerThinkingMocks = vi.hoisted(() => ({
  resolveProviderBinaryThinking: vi.fn(),
  resolveProviderDefaultThinkingLevel: vi.fn(),
  resolveProviderXHighThinking: vi.fn(),
}));
const buildModelsProviderDataMock = vi.hoisted(() => vi.fn());

type ConfiguredBindingRoute = ConfiguredBindingRouteResult;
type ConfiguredBindingResolution = NonNullable<ConfiguredBindingRoute["bindingResolution"]>;

function createConfiguredRouteResult(
  params: Parameters<ResolveConfiguredBindingRoute>[0],
): ConfiguredBindingRoute {
  return {
    bindingResolution: {
      record: {
        bindingId: "binding-1",
        targetSessionKey: SESSION_KEY,
        targetKind: "session",
        status: "active",
        boundAt: Date.now(),
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "C1",
        },
      },
    } as ConfiguredBindingResolution,
    boundSessionKey: SESSION_KEY,
    route: {
      ...params.route,
      agentId: "main",
      sessionKey: SESSION_KEY,
      matchedBy: "binding.channel",
      lastRoutePolicy: "session",
    },
  };
}

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", async () => {
  const { createConfiguredBindingConversationRuntimeModuleMock } =
    await import("../test-support/configured-binding-runtime.js");
  return await createConfiguredBindingConversationRuntimeModuleMock<
    typeof import("openclaw/plugin-sdk/conversation-binding-runtime")
  >(
    {
      ensureConfiguredBindingRouteReadyMock,
      resolveConfiguredBindingRouteMock,
    },
    () =>
      vi.importActual<typeof import("openclaw/plugin-sdk/conversation-binding-runtime")>(
        "openclaw/plugin-sdk/conversation-binding-runtime",
      ),
  );
});

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  normalizeProviderId: (value: string) => value.trim().toLowerCase(),
  resolveDefaultModelForAgent: (params: { cfg: ReturnType<typeof loadConfig> }) => {
    const configuredModel = params.cfg.agents?.defaults?.model;
    const primary =
      typeof configuredModel === "string"
        ? configuredModel.trim()
        : (configuredModel?.primary?.trim() ?? "");
    const slashIndex = primary.indexOf("/");
    if (slashIndex > 0 && slashIndex < primary.length - 1) {
      return {
        provider: primary.slice(0, slashIndex).trim().toLowerCase(),
        model: primary.slice(slashIndex + 1).trim(),
      };
    }
    return {
      provider: "anthropic",
      model: "claude-sonnet-4.5",
    };
  },
}));

vi.mock("openclaw/plugin-sdk/models-provider-runtime", () => ({
  buildModelsProviderData: buildModelsProviderDataMock,
}));

const STORE_PATH = path.join(
  os.tmpdir(),
  `openclaw-discord-think-autocomplete-${process.pid}.json`,
);
const SESSION_KEY = "agent:main:main";
let findCommandByNativeName: typeof import("openclaw/plugin-sdk/command-auth").findCommandByNativeName;
let resolveCommandArgChoices: typeof import("openclaw/plugin-sdk/command-auth").resolveCommandArgChoices;
let resolveDiscordNativeChoiceContext: typeof import("./native-command-ui.js").resolveDiscordNativeChoiceContext;

async function loadDiscordThinkAutocompleteModulesForTest() {
  vi.resetModules();
  vi.doMock("../../../../src/plugins/provider-thinking.js", () => ({
    resolveProviderBinaryThinking: providerThinkingMocks.resolveProviderBinaryThinking,
    resolveProviderDefaultThinkingLevel: providerThinkingMocks.resolveProviderDefaultThinkingLevel,
    resolveProviderXHighThinking: providerThinkingMocks.resolveProviderXHighThinking,
  }));
  const commandAuth = await import("openclaw/plugin-sdk/command-auth");
  const nativeCommandUi = await import("./native-command-ui.js");
  return {
    findCommandByNativeName: commandAuth.findCommandByNativeName,
    resolveCommandArgChoices: commandAuth.resolveCommandArgChoices,
    resolveDiscordNativeChoiceContext: nativeCommandUi.resolveDiscordNativeChoiceContext,
  };
}

describe("discord native /think autocomplete", () => {
  beforeAll(async () => {
    providerThinkingMocks.resolveProviderBinaryThinking.mockReturnValue(undefined);
    providerThinkingMocks.resolveProviderDefaultThinkingLevel.mockReturnValue(undefined);
    providerThinkingMocks.resolveProviderXHighThinking.mockImplementation(({ provider, context }) =>
      provider === "openai-codex" && ["gpt-5.4", "gpt-5.4-pro"].includes(context.modelId)
        ? true
        : undefined,
    );
    buildModelsProviderDataMock.mockResolvedValue({
      byProvider: new Map<string, Set<string>>(),
      providers: [],
      resolvedDefault: {
        provider: "anthropic",
        model: "claude-sonnet-4.5",
      },
      modelNames: new Map<string, string>(),
    });
    ({ findCommandByNativeName, resolveCommandArgChoices, resolveDiscordNativeChoiceContext } =
      await loadDiscordThinkAutocompleteModulesForTest());
  });

  beforeEach(() => {
    clearSessionStoreCacheForTest();
    ensureConfiguredBindingRouteReadyMock.mockReset();
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: true });
    resolveConfiguredBindingRouteMock.mockReset();
    resolveConfiguredBindingRouteMock.mockReturnValue(createUnboundConfiguredRouteResult());
    providerThinkingMocks.resolveProviderBinaryThinking.mockReset();
    providerThinkingMocks.resolveProviderBinaryThinking.mockReturnValue(undefined);
    providerThinkingMocks.resolveProviderDefaultThinkingLevel.mockReset();
    providerThinkingMocks.resolveProviderDefaultThinkingLevel.mockReturnValue(undefined);
    providerThinkingMocks.resolveProviderXHighThinking.mockReset();
    providerThinkingMocks.resolveProviderXHighThinking.mockImplementation(({ provider, context }) =>
      provider === "openai-codex" && ["gpt-5.4", "gpt-5.4-pro"].includes(context.modelId)
        ? true
        : undefined,
    );
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify({
        [SESSION_KEY]: {
          updatedAt: Date.now(),
          providerOverride: "openai-codex",
          modelOverride: "gpt-5.4",
        },
      }),
      "utf8",
    );
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    try {
      fs.unlinkSync(STORE_PATH);
    } catch {}
  });

  function createConfig() {
    return {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-sonnet-4.5",
          },
        },
      },
      session: {
        store: STORE_PATH,
      },
    } as ReturnType<typeof loadConfig>;
  }

  it("uses the session override context for /think choices", async () => {
    const cfg = createConfig();
    const interaction = {
      options: {
        getFocused: () => ({ value: "xh" }),
      },
      respond: async (_choices: Array<{ name: string; value: string }>) => {},
      rawData: {},
      channel: { id: "D1", type: ChannelType.DM },
      user: { id: "U1" },
      guild: undefined,
      client: {},
    } as unknown as AutocompleteInteraction & {
      respond: (choices: Array<{ name: string; value: string }>) => Promise<void>;
    };

    const command = findCommandByNativeName("think", "discord");
    expect(command).toBeTruthy();
    const levelArg = command?.args?.find((entry) => entry.name === "level");
    expect(levelArg).toBeTruthy();
    if (!command || !levelArg) {
      return;
    }

    const context = await resolveDiscordNativeChoiceContext({
      interaction,
      cfg,
      accountId: "default",
      threadBindings: createNoopThreadBindingManager("default"),
    });
    expect(context).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
    });

    const choices = resolveCommandArgChoices({
      command,
      arg: levelArg,
      cfg,
      provider: context?.provider,
      model: context?.model,
    });
    const values = choices.map((choice) => choice.value);
    expect(values).toContain("xhigh");
  });

  it("falls back when a configured binding is unavailable", async () => {
    const cfg = createConfig();
    resolveConfiguredBindingRouteMock.mockImplementation(createConfiguredRouteResult);
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({
      ok: false,
      error: "acpx exited",
    });
    const interaction = {
      options: {
        getFocused: () => ({ value: "xh" }),
      },
      respond: async (_choices: Array<{ name: string; value: string }>) => {},
      rawData: {
        member: { roles: [] },
      },
      channel: { id: "C1", type: ChannelType.GuildText },
      user: { id: "U1" },
      guild: { id: "G1" },
      client: {},
    } as unknown as AutocompleteInteraction & {
      respond: (choices: Array<{ name: string; value: string }>) => Promise<void>;
    };

    const context = await resolveDiscordNativeChoiceContext({
      interaction,
      cfg,
      accountId: "default",
      threadBindings: createNoopThreadBindingManager("default"),
    });

    expect(context).toBeNull();
    expect(ensureConfiguredBindingRouteReadyMock).toHaveBeenCalledTimes(1);

    const command = findCommandByNativeName("think", "discord");
    const levelArg = command?.args?.find((entry) => entry.name === "level");
    expect(command).toBeTruthy();
    expect(levelArg).toBeTruthy();
    if (!command || !levelArg) {
      return;
    }
    const choices = resolveCommandArgChoices({
      command,
      arg: levelArg,
      cfg,
      provider: context?.provider,
      model: context?.model,
    });
    const values = choices.map((choice) => choice.value);
    expect(values).not.toContain("xhigh");
  });
});
