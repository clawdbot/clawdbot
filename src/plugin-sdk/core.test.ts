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
  } as unknown as OpenClawPluginApi;
}

describe("defineChannelPluginEntry", () => {
  it("keeps runtime helpers out of discovery registration", () => {
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
    expect(setRuntime).not.toHaveBeenCalled();
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
