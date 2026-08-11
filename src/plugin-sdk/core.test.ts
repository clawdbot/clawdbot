/**
 * Tests core plugin SDK exports and channel plugin construction.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi, PluginRegistrationMode } from "../plugins/types.js";
import {
  createChannelPluginBase,
  createChatChannelPlugin,
  defineChannelPluginEntry,
  type ChannelPlugin,
} from "./channel-core.js";

function createChannelPlugin(id: string): ChannelPlugin {
  return {
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: `${id} channel`,
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => null,
    },
    outbound: { deliveryMode: "direct" },
  };
}

function createApi(registrationMode: PluginRegistrationMode): OpenClawPluginApi {
  return {
    registrationMode,
    runtime: { registrationMode } as unknown as PluginRuntime,
    registerChannel: vi.fn(),
    registerTool: vi.fn(),
  } as unknown as OpenClawPluginApi;
}

describe("defineChannelPluginEntry", () => {
  it("defers and memoizes config schema factories", () => {
    const configSchema = {
      schema: { type: "object" as const, additionalProperties: false },
    };
    const createConfigSchema = vi.fn(() => configSchema);
    const entry = defineChannelPluginEntry({
      id: "lazy-config-schema",
      name: "Lazy Config Schema",
      description: "lazy config schema test",
      plugin: createChannelPlugin("lazy-config-schema"),
      configSchema: createConfigSchema,
    });

    expect(createConfigSchema).not.toHaveBeenCalled();
    expect(entry.configSchema).toBe(configSchema);
    expect(entry.configSchema).toBe(configSchema);
    expect(createConfigSchema).toHaveBeenCalledTimes(1);
  });

  it("runs tool registrations without channel runtime wiring during tool discovery", () => {
    const setRuntime = vi.fn<(runtime: PluginRuntime) => void>();
    const registerCliMetadata = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerCapabilities = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerFull = vi.fn<(api: OpenClawPluginApi) => void>((api) => {
      api.registerTool(
        {
          name: "channel_tool",
          label: "Channel Tool",
          description: "channel tool",
          parameters: {},
          execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
        },
        { name: "channel_tool" },
      );
    });
    const entry = defineChannelPluginEntry({
      id: "runtime-tool-discovery",
      name: "Runtime Tool Discovery",
      description: "runtime tool discovery test",
      plugin: createChannelPlugin("runtime-tool-discovery"),
      setRuntime,
      registerCliMetadata,
      registerFull,
      registerCapabilities,
    });

    const api = createApi("tool-discovery");
    entry.register(api);

    expect(api.registerChannel).not.toHaveBeenCalled();
    expect(setRuntime).not.toHaveBeenCalled();
    expect(registerCliMetadata).not.toHaveBeenCalled();
    expect(registerFull).toHaveBeenCalledWith(api);
    expect(registerCapabilities).toHaveBeenCalledExactlyOnceWith(api);
    expect(api.registerTool).toHaveBeenCalledTimes(1);
  });

  it("wires runtime helpers during discovery registration", () => {
    const setRuntime = vi.fn<(runtime: PluginRuntime) => void>();
    const registerCliMetadata = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerFull = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerCapabilities = vi.fn<(api: OpenClawPluginApi) => void>();
    const entry = defineChannelPluginEntry({
      id: "runtime-discovery",
      name: "Runtime Discovery",
      description: "runtime discovery test",
      plugin: createChannelPlugin("runtime-discovery"),
      setRuntime,
      registerCliMetadata,
      registerFull,
      registerCapabilities,
    });

    const api = createApi("discovery");
    entry.register(api);

    expect(api.registerChannel).toHaveBeenCalledTimes(1);
    expect(registerCliMetadata).toHaveBeenCalledTimes(1);
    expect(setRuntime).toHaveBeenCalledWith(api.runtime);
    expect(registerFull).not.toHaveBeenCalled();
    expect(registerCapabilities).toHaveBeenCalledExactlyOnceWith(api);
  });

  it("keeps setup-runtime and full registration wired to runtime helpers", () => {
    const setRuntime = vi.fn<(runtime: PluginRuntime) => void>();
    const registerCliMetadata = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerFull = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerCapabilities = vi.fn<(api: OpenClawPluginApi) => void>();
    const entry = defineChannelPluginEntry({
      id: "runtime-activation",
      name: "Runtime Activation",
      description: "runtime activation test",
      plugin: createChannelPlugin("runtime-activation"),
      setRuntime,
      registerCliMetadata,
      registerFull,
      registerCapabilities,
    });

    const cliApi = createApi("cli-metadata");
    entry.register(cliApi);
    expect(registerCliMetadata).toHaveBeenCalledWith(cliApi);
    expect(registerCapabilities).not.toHaveBeenCalled();
    registerCliMetadata.mockClear();

    entry.register(createApi("setup-only"));
    expect(registerCapabilities).not.toHaveBeenCalled();

    const setupApi = createApi("setup-runtime");
    entry.register(setupApi);
    expect(setRuntime).toHaveBeenCalledWith(setupApi.runtime);
    expect(registerCliMetadata).not.toHaveBeenCalled();
    expect(registerFull).not.toHaveBeenCalled();
    expect(registerCapabilities).not.toHaveBeenCalled();

    setRuntime.mockClear();
    const fullApi = createApi("full");
    entry.register(fullApi);
    expect(setRuntime).toHaveBeenCalledWith(fullApi.runtime);
    expect(registerCliMetadata).toHaveBeenCalledWith(fullApi);
    expect(registerFull).toHaveBeenCalledWith(fullApi);
    expect(registerCapabilities).toHaveBeenCalledExactlyOnceWith(fullApi);
  });
});

describe("createChannelPluginBase", () => {
  it("keeps meta id aligned with the channel id", () => {
    const plugin = createChannelPluginBase({
      id: "metadata-id-channel",
      meta: {
        label: "Metadata ID Channel",
        selectionLabel: "Metadata ID Channel",
        docsPath: "/channels/metadata-id-channel",
        blurb: "metadata id channel",
      },
      setup: {} as NonNullable<ChannelPlugin["setup"]>,
    });

    expect(plugin.meta.id).toBe("metadata-id-channel");
  });
});

describe("createChatChannelPlugin", () => {
  it("preserves DM routing through the declarative security shorthand", () => {
    const dmRouting = {
      resolveDmScope: () => "per-peer" as const,
      resolveDmRoute: () => ({ kind: "core" as const }),
    };
    const plugin = createChatChannelPlugin({
      base: createChannelPlugin("security-routing") as ChannelPlugin<{ accountId: string }>,
      security: {
        dm: {
          channelKey: "security-routing",
          resolvePolicy: () => "allowlist",
          resolveAllowFrom: () => [],
        },
        dmRouting,
      },
    });

    expect(plugin.security?.dmRouting).toBe(dmRouting);
  });

  it("preserves account-scoped current-conversation binding support", () => {
    const conversationBindings: NonNullable<ChannelPlugin["conversationBindings"]> = {
      isCurrentConversationBindingSupported: ({ accountId }) => accountId !== "enterprise",
    };
    const plugin = createChatChannelPlugin({
      base: {
        ...createChannelPlugin("account-scoped-bindings"),
        conversationBindings,
      },
    });

    expect(plugin.conversationBindings?.supportsCurrentConversationBinding).toBe(true);
    expect(
      plugin.conversationBindings?.isCurrentConversationBindingSupported?.({
        accountId: "workspace",
      }),
    ).toBe(true);
    expect(
      plugin.conversationBindings?.isCurrentConversationBindingSupported?.({
        accountId: "enterprise",
      }),
    ).toBe(false);
  });
});
