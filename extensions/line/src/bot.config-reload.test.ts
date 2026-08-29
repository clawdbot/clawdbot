// Line tests cover which config a delivered LINE event is handled with.
import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DeliverFn = (
  event: webhook.Event,
  destination: string,
  control: Record<string, unknown>,
) => Promise<void>;

const { createLineWebhookSpoolMock, handleLineWebhookEventsMock } = vi.hoisted(() => ({
  createLineWebhookSpoolMock: vi.fn(),
  handleLineWebhookEventsMock: vi.fn(
    async (_events: webhook.Event[], _context: { cfg: OpenClawConfig; historyLimit: number }) => {},
  ),
}));

vi.mock("./webhook-spool.js", () => ({
  createLineWebhookSpool: createLineWebhookSpoolMock,
}));
vi.mock("./bot-handlers.js", () => ({
  handleLineWebhookEvents: handleLineWebhookEventsMock,
}));

const { createLineBot } = await import("./bot.js");

function configWithHistoryLimit(historyLimit: number): OpenClawConfig {
  return {
    channels: {
      line: { enabled: true, channelAccessToken: "test-token", channelSecret: "test-secret" },
    },
    messages: { groupChat: { historyLimit } },
  } as OpenClawConfig;
}

// The bot only reveals the config it chose by handing it to the handlers, so
// build one, then drive the spool's deliver callback and read what they were
// given. Creation and delivery stay separate so a reload can land between them,
// which is the only ordering the Gateway ever produces.
function createDeliverableBot(startupConfig: OpenClawConfig): {
  deliverOnce: () => Promise<{ cfg: OpenClawConfig; historyLimit: number }>;
} {
  let deliver: DeliverFn | undefined;
  createLineWebhookSpoolMock.mockImplementation((spoolOptions: { deliver: DeliverFn }) => {
    deliver = spoolOptions.deliver;
    return { accept: vi.fn(), start: vi.fn(), stop: vi.fn() };
  });

  createLineBot({
    channelAccessToken: "test-token",
    channelSecret: "test-secret",
    config: startupConfig,
  });

  if (!deliver) {
    throw new Error("createLineBot did not build a spool deliver callback");
  }
  const deliverEvent = deliver;
  return {
    deliverOnce: async () => {
      await deliverEvent({ type: "message" } as webhook.Event, "destination", {});
      const context = handleLineWebhookEventsMock.mock.calls.at(-1)?.[1];
      if (!context) {
        throw new Error("handleLineWebhookEvents was not called");
      }
      return { cfg: context.cfg, historyLimit: context.historyLimit };
    },
  };
}

describe("the config a delivered LINE event is handled with", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRuntimeConfigSnapshot();
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("follows a reload for a monitor the Gateway started from the process config", async () => {
    // The real sequence: the Gateway starts the channel with the config it
    // loaded, then a later write replaces the runtime config AND its source.
    // `messages` changes are hot-applied without restarting the channel, so a
    // monitor that never re-reads them keeps answering with the config it booted
    // on for the rest of the process.
    const startupConfig = configWithHistoryLimit(10);
    setRuntimeConfigSnapshot(startupConfig, configWithHistoryLimit(10));
    const bot = createDeliverableBot(startupConfig);

    const reloaded = configWithHistoryLimit(75);
    setRuntimeConfigSnapshot(reloaded, configWithHistoryLimit(75));
    const handled = await bot.deliverOnce();

    expect(handled.cfg).toBe(reloaded);
    expect(handled.historyLimit).toBe(75);
  });

  // A monitor handed a config that is not what the process loaded owns it; a
  // scoped or test monitor must not be hijacked by an unrelated global reload.
  // Not every runtime snapshot carries the source it was built from - a pinned
  // load publishes the config alone - and that is the case where the shared
  // selector answers with the runtime config for any input at all.
  it.each([
    { label: "against a snapshot that carries its source", withSource: true },
    { label: "against a snapshot published without its source", withSource: false },
  ])(
    "keeps a config of its own rather than the process-global one, $label",
    async ({ withSource }) => {
      const ownConfig = configWithHistoryLimit(10);
      const startupRuntime = configWithHistoryLimit(33);
      setRuntimeConfigSnapshot(startupRuntime, ...(withSource ? [startupRuntime] : []));
      const bot = createDeliverableBot(ownConfig);

      setRuntimeConfigSnapshot(configWithHistoryLimit(75), configWithHistoryLimit(75));
      const handled = await bot.deliverOnce();

      expect(handled.cfg).toBe(ownConfig);
      expect(handled.historyLimit).toBe(10);
    },
  );

  it("keeps the account's own history limit ahead of the reloaded shared default", async () => {
    const startupConfig = {
      channels: {
        line: {
          enabled: true,
          channelAccessToken: "test-token",
          channelSecret: "test-secret",
          historyLimit: 5,
        },
      },
      messages: { groupChat: { historyLimit: 10 } },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(startupConfig, startupConfig);
    const bot = createDeliverableBot(startupConfig);

    setRuntimeConfigSnapshot(configWithHistoryLimit(75), configWithHistoryLimit(75));
    const handled = await bot.deliverOnce();

    expect(handled.historyLimit).toBe(5);
  });
});
