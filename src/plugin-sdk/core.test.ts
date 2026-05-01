import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi, PluginRegistrationMode } from "../plugins/types.js";
import { defineChannelPluginEntry } from "./core.js";

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
  it("runs tool registrations without channel runtime wiring during tool discovery", () => {
    const setRuntime = vi.fn<(runtime: PluginRuntime) => void>();
    const registerCliMetadata = vi.fn<(api: OpenClawPluginApi) => void>();
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
    });

    const api = createApi("tool-discovery");
    entry.register(api);

    expect(api.registerChannel).not.toHaveBeenCalled();
    expect(setRuntime).not.toHaveBeenCalled();
    expect(registerCliMetadata).not.toHaveBeenCalled();
    expect(registerFull).toHaveBeenCalledWith(api);
    expect(api.registerTool).toHaveBeenCalledTimes(1);
  });

  it("wires runtime helpers during discovery registration", () => {
    const setRuntime = vi.fn<(runtime: PluginRuntime) => void>();
    const registerCliMetadata = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerFull = vi.fn<(api: OpenClawPluginApi) => void>();
    const entry = defineChannelPluginEntry({
      id: "runtime-discovery",
      name: "Runtime Discovery",
      description: "runtime discovery test",
      plugin: createChannelPlugin("runtime-discovery"),
      setRuntime,
      registerCliMetadata,
      registerFull,
    });

    const api = createApi("discovery");
    entry.register(api);

    expect(api.registerChannel).toHaveBeenCalledTimes(1);
    expect(registerCliMetadata).toHaveBeenCalledTimes(1);
    expect(setRuntime).toHaveBeenCalledWith(api.runtime);
    expect(registerFull).not.toHaveBeenCalled();
  });

  it("keeps setup-runtime and full registration wired to runtime helpers", () => {
    const setRuntime = vi.fn<(runtime: PluginRuntime) => void>();
    const registerCliMetadata = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerFull = vi.fn<(api: OpenClawPluginApi) => void>();
    const entry = defineChannelPluginEntry({
      id: "runtime-activation",
      name: "Runtime Activation",
      description: "runtime activation test",
      plugin: createChannelPlugin("runtime-activation"),
      setRuntime,
      registerCliMetadata,
      registerFull,
    });

    const setupApi = createApi("setup-runtime");
    entry.register(setupApi);
    expect(setRuntime).toHaveBeenCalledWith(setupApi.runtime);
    expect(registerCliMetadata).not.toHaveBeenCalled();
    expect(registerFull).not.toHaveBeenCalled();

    setRuntime.mockClear();
    const fullApi = createApi("full");
    entry.register(fullApi);
    expect(setRuntime).toHaveBeenCalledWith(fullApi.runtime);
    expect(registerCliMetadata).toHaveBeenCalledWith(fullApi);
    expect(registerFull).toHaveBeenCalledWith(fullApi);
  });
});
