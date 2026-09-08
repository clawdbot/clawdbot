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

// Capture the spool callback so a reload can land between creation and delivery.
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
    // `messages` reloads without restarting LINE, so the existing monitor must see it.
    const startupConfig = configWithHistoryLimit(10);
    setRuntimeConfigSnapshot(startupConfig, configWithHistoryLimit(10));
    const bot = createDeliverableBot(startupConfig);

    const reloaded = configWithHistoryLimit(75);
    setRuntimeConfigSnapshot(reloaded, configWithHistoryLimit(75));
    const handled = await bot.deliverOnce();

    expect(handled.cfg).toBe(reloaded);
    expect(handled.historyLimit).toBe(75);
  });

  // A distinct supplied config is scoped. A missing source snapshot cannot prove
  // that it belongs to the process runtime.
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

  it("keeps a supplied config when the process snapshot appears after startup", async () => {
    const ownConfig = configWithHistoryLimit(10);
    const bot = createDeliverableBot(ownConfig);

    setRuntimeConfigSnapshot(configWithHistoryLimit(75), configWithHistoryLimit(75));
    const handled = await bot.deliverOnce();

    expect(handled.cfg).toBe(ownConfig);
    expect(handled.historyLimit).toBe(10);
  });

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
