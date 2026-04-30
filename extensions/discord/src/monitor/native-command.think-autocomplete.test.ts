import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearSessionStoreCacheForTest } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type AutocompleteInteraction } from "../internal/discord.js";
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
  resolveProviderThinkingProfile: vi.fn(),
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
  resolveDefaultModelForAgent: (params: { cfg: OpenClawConfig }) => {
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

function installProviderThinkingRegistryForTest(): void {
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: "discord-test",
    source: "test",
    provider: {
      id: "discord-test-thinking",
      label: "Discord Test Thinking",
      aliases: ["anthropic", "openai-codex"],
      auth: [],
      isBinaryThinking: (context) =>
        providerThinkingMocks.resolveProviderBinaryThinking({
          provider: context.provider,
          context,
        }),
      supportsXHighThinking: (context) =>
        providerThinkingMocks.resolveProviderXHighThinking({
          provider: context.provider,
          context,
        }),
      resolveThinkingProfile: (context) =>
        providerThinkingMocks.resolveProviderThinkingProfile({
          provider: context.provider,
          context,
        }),
      resolveDefaultThinkingLevel: (context) =>
        providerThinkingMocks.resolveProviderDefaultThinkingLevel({
          provider: context.provider,
          context,
        }),
    },
  });
  setActivePluginRegistry(registry);
}

async function loadDiscordThinkAutocompleteModulesForTest() {
  vi.resetModules();
  installProviderThinkingRegistryForTest();
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
    providerThinkingMocks.resolveProviderThinkingProfile.mockReturnValue(undefined);
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
    providerThinkingMocks.resolveProviderThinkingProfile.mockReset();
    providerThinkingMocks.resolveProviderThinkingProfile.mockReturnValue(undefined);
    providerThinkingMocks.resolveProviderXHighThinking.mockReset();
    providerThinkingMocks.resolveProviderXHighThinking.mockImplementation(({ provider, context }) =>
      provider === "openai-codex" && ["gpt-5.4", "gpt-5.4-pro"].includes(context.modelId)
        ? true
        : undefined,
    );
    installProviderThinkingRegistryForTest();
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
    } as OpenClawConfig;
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
    expect(values).not.toContain("max");
    expect(values).not.toContain("adaptive");
  });

  it("includes max only for provider-advertised models", async () => {
    providerThinkingMocks.resolveProviderThinkingProfile.mockImplementation(
      ({ provider, context }) =>
        provider === "anthropic" && context.modelId === "claude-opus-4-7"
          ? { levels: [{ id: "off" }, { id: "max" }] }
          : undefined,
    );
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify({
        [SESSION_KEY]: {
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-7",
        },
      }),
      "utf8",
    );
    const cfg = createConfig();
    resolveConfiguredBindingRouteMock.mockImplementation(createConfiguredRouteResult);
    const interaction = {
      options: {
        getFocused: () => ({ value: "ma" }),
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
    expect(values).toContain("max");
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
