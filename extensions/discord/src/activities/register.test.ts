import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDiscordActivities } from "./register.js";
import { getDiscordActivitiesRuntime, setDiscordActivitiesRuntime } from "./runtime.js";
import { createMemoryKeyedStore } from "./test-helpers.test-support.js";

afterEach(() => {
  setDiscordActivitiesRuntime(undefined);
  vi.unstubAllEnvs();
});

function createApi(config: Record<string, unknown>) {
  const routes: unknown[] = [];
  const tools: unknown[] = [];
  const warn = vi.fn();
  const api = {
    config,
    logger: { warn },
    runtime: {
      state: { openKeyedStore: vi.fn(() => createMemoryKeyedStore()) },
      config: { current: () => config },
    },
    registerHttpRoute: vi.fn((route) => routes.push(route)),
    registerTool: vi.fn((tool) => tools.push(tool)),
  } as unknown as OpenClawPluginApi;
  return { api, routes, tools, warn };
}

describe("Discord Activities registration", () => {
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

  it("registers the public plugin route and Discord-only tool factory when configured", () => {
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
    expect(test.tools).toHaveLength(1);
    const factory = test.tools[0] as (context: { messageChannel?: string }) => unknown;
    expect(factory({ messageChannel: "slack" })).toBeNull();
    expect(factory({ messageChannel: "discord" })).not.toBeNull();
  });
});
