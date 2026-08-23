import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDiscordActivities } from "./register.js";
import { getDiscordActivitiesRuntime, setDiscordActivitiesRuntime } from "./runtime.js";
import { openDiscordActivityStores } from "./store.js";
import { createMemoryKeyedStore } from "./test-helpers.test-support.js";

afterEach(() => {
  setDiscordActivitiesRuntime(undefined);
  vi.unstubAllEnvs();
});

function createApi(config: Record<string, unknown>) {
  const routes: unknown[] = [];
  const tools: Array<{ tool: unknown; opts?: { name?: string } }> = [];
  const warn = vi.fn();
  const resolvePath = vi.fn((input: string) => `/plugin-root/${input}`);
  const api = {
    config,
    logger: { warn },
    runtime: {
      state: { openKeyedStore: vi.fn(() => createMemoryKeyedStore()) },
      config: { current: () => config },
    },
    registerHttpRoute: vi.fn((route) => routes.push(route)),
    registerTool: vi.fn((tool, opts) => tools.push({ tool, opts })),
    resolvePath,
  } as unknown as OpenClawPluginApi;
  return { api, routes, tools, warn, resolvePath };
}

describe("Discord Activities registration", () => {
  it("requires atomic plugin state updates", () => {
    const openKeyedStore = <T>() => {
      const store: PluginStateKeyedStore<T> = createMemoryKeyedStore<T>();
      store.update = undefined;
      return store;
    };

    expect(() => openDiscordActivityStores(openKeyedStore)).toThrow(
      "Discord Activities require atomic plugin state updates",
    );
  });

  it("registers no route, tool, or runtime when unconfigured", () => {
    const test = createApi({ channels: { discord: { token: "test" } } });
    registerDiscordActivities(test.api);
    expect(test.routes).toHaveLength(0);
    expect(test.tools).toHaveLength(0);
    expect(getDiscordActivitiesRuntime()).toBeUndefined();
  });

  it("warns and remains disabled when the secret is missing", () => {
    vi.stubEnv("DISCORD_CLIENT_SECRET", "");
    const test = createApi({
      channels: { discord: { token: "test", activities: { applicationId: "123" } } },
    });
    registerDiscordActivities(test.api);
    expect(test.warn).toHaveBeenCalledWith(expect.stringContaining("no client secret resolved"));
    expect(test.routes).toHaveLength(0);
    expect(test.tools).toHaveLength(0);
  });

  it("registers nothing for an explicitly disabled Discord account", () => {
    const test = createApi({
      channels: {
        discord: {
          enabled: false,
          token: "test",
          activities: { clientSecret: "secret", applicationId: "123" },
        },
      },
    });
    registerDiscordActivities(test.api);
    expect(test.routes).toHaveLength(0);
    expect(test.tools).toHaveLength(0);
    expect(getDiscordActivitiesRuntime()).toBeUndefined();
  });

  it("registers the public route and both Discord-only widget tool factories", () => {
    const test = createApi({
      channels: {
        discord: {
          token: "test",
          activities: { clientSecret: "secret", applicationId: "123" },
        },
      },
    });
    registerDiscordActivities(test.api);
    expect(test.routes).toHaveLength(1);
    expect(test.routes[0]).toMatchObject({
      path: "/discord/activity",
      auth: "plugin",
      match: "prefix",
    });
    expect(test.resolvePath).toHaveBeenCalledWith("assets/embedded-app-sdk.mjs");
    expect(test.tools.map(({ opts }) => opts?.name)).toEqual(["show_widget", "discord_widget"]);
    for (const { tool } of test.tools) {
      const factory = tool as (context: { messageChannel?: string }) => unknown;
      expect(factory({ messageChannel: "slack" })).toBeNull();
      expect(factory({ messageChannel: "discord" })).not.toBeNull();
    }
  });
});
