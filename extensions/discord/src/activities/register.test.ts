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

function createApi(
  config: Record<string, unknown>,
  runtimeConfig: Record<string, unknown> = config,
) {
  const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
  const widgetPresenters: Array<Parameters<OpenClawPluginApi["registerWidgetPresenter"]>[0]> = [];
  const resolvePath = vi.fn((input: string) => `/plugin-root/${input}`);
  const api = {
    config,
    logger: { warn: vi.fn() },
    runtime: {
      state: { openKeyedStore: vi.fn(() => createMemoryKeyedStore()) },
      config: { current: () => runtimeConfig },
    },
    registerHttpRoute: vi.fn((route) => routes.push(route)),
    registerWidgetPresenter: vi.fn((presenter) => widgetPresenters.push(presenter)),
    resolvePath,
  } as unknown as OpenClawPluginApi;
  return { api, routes, widgetPresenters, resolvePath };
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

  it("registers static transport surfaces before runtime config is published", () => {
    const runtimeConfig = {
      channels: {
        discord: {
          token: "test",
          activities: { clientSecret: "secret", applicationId: "123" },
        },
      },
    };
    const test = createApi({ channels: { discord: { token: "test" } } }, runtimeConfig);

    registerDiscordActivities(test.api);

    expect(test.routes).toEqual([
      expect.objectContaining({ path: "/discord/activity", auth: "plugin", match: "prefix" }),
    ]);
    expect(test.resolvePath).toHaveBeenCalledWith("assets/embedded-app-sdk.mjs");
    expect(test.widgetPresenters).toEqual([
      expect.objectContaining({
        target: "current_channel",
        capabilities: { sourceKinds: ["html"], maxSourceBytes: 48 * 1024 },
      }),
    ]);
    const presenter = test.widgetPresenters[0];
    expect(
      presenter?.target === "current_channel" &&
        presenter.match({
          messageChannel: "discord",
          accountId: "default",
          nativeChannelId: "987654321",
        }),
    ).toBe(true);
    expect(getDiscordActivitiesRuntime()).toBeDefined();
  });

  it.each([
    {
      name: "Activities are unconfigured",
      config: { channels: { discord: { token: "test" } } },
    },
    {
      name: "the client secret is missing",
      config: {
        channels: { discord: { token: "test", activities: { applicationId: "123" } } },
      },
    },
    {
      name: "the Discord account is disabled",
      config: {
        channels: {
          discord: {
            enabled: false,
            token: "test",
            activities: { clientSecret: "secret", applicationId: "123" },
          },
        },
      },
    },
  ])("keeps the static presenter unavailable when $name", ({ config }) => {
    const test = createApi({}, config);
    registerDiscordActivities(test.api);

    const presenter = test.widgetPresenters[0];
    expect(
      presenter?.target === "current_channel" &&
        presenter.match({
          messageChannel: "discord",
          accountId: "default",
          nativeChannelId: "987654321",
        }),
    ).toBe(false);
  });
});
