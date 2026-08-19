// Line tests cover how the bot resolves the inbound media cap it hands to the handlers.
import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

type DeliverFn = (
  event: webhook.Event,
  destination: string,
  control: Record<string, unknown>,
) => Promise<void>;

const { createLineWebhookSpoolMock, handleLineWebhookEventsMock } = vi.hoisted(() => ({
  createLineWebhookSpoolMock: vi.fn(),
  // Typed parameters so the recorded call can be read back as the handler context.
  handleLineWebhookEventsMock: vi.fn(
    async (_events: webhook.Event[], _context: { mediaMaxBytes: number }) => {},
  ),
}));

vi.mock("./webhook-spool.js", () => ({
  createLineWebhookSpool: createLineWebhookSpoolMock,
}));
vi.mock("./bot-handlers.js", () => ({
  handleLineWebhookEvents: handleLineWebhookEventsMock,
}));

const { createLineBot } = await import("./bot.js");

const MB = 1024 * 1024;

function configWith(mediaMaxMb?: number): OpenClawConfig {
  return {
    channels: {
      line: {
        enabled: true,
        channelAccessToken: "test-token",
        channelSecret: "test-secret",
        ...(mediaMaxMb === undefined ? {} : { mediaMaxMb }),
      },
    },
  } as OpenClawConfig;
}

// The bot only reveals the resolved cap by handing it to the handlers, so drive
// the spool's deliver callback once and read what the handlers were given.
async function resolveMediaMaxBytes(opts: {
  configuredMediaMaxMb?: number;
  optionMediaMaxMb?: number;
}): Promise<number> {
  let deliver: DeliverFn | undefined;
  createLineWebhookSpoolMock.mockImplementation((spoolOptions: { deliver: DeliverFn }) => {
    deliver = spoolOptions.deliver;
    return { accept: vi.fn(), start: vi.fn(), stop: vi.fn() };
  });

  createLineBot({
    channelAccessToken: "test-token",
    channelSecret: "test-secret",
    config: configWith(opts.configuredMediaMaxMb),
    ...(opts.optionMediaMaxMb === undefined ? {} : { mediaMaxMb: opts.optionMediaMaxMb }),
  });

  if (!deliver) {
    throw new Error("createLineBot did not build a spool deliver callback");
  }
  await deliver({ type: "message" } as webhook.Event, "destination", {});

  const context = handleLineWebhookEventsMock.mock.calls.at(-1)?.[1];
  if (typeof context?.mediaMaxBytes !== "number") {
    throw new Error("handleLineWebhookEvents was not given a mediaMaxBytes");
  }
  return context.mediaMaxBytes;
}

describe("createLineBot media cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { mediaMaxMb: 0, label: "zero" },
    { mediaMaxMb: -5, label: "negative" },
  ])("treats a $label mediaMaxMb as unset instead of a 0-byte cap", async ({ mediaMaxMb }) => {
    // A non-positive cap would otherwise reject every non-empty inbound download.
    await expect(resolveMediaMaxBytes({ configuredMediaMaxMb: mediaMaxMb })).resolves.toBe(10 * MB);
  });

  it("keeps the default when mediaMaxMb is unset", async () => {
    await expect(resolveMediaMaxBytes({})).resolves.toBe(10 * MB);
  });

  it("still caps at a configured positive mediaMaxMb", async () => {
    await expect(resolveMediaMaxBytes({ configuredMediaMaxMb: 2 })).resolves.toBe(2 * MB);
  });

  it("keeps the caller override ahead of account config", async () => {
    await expect(
      resolveMediaMaxBytes({ configuredMediaMaxMb: 2, optionMediaMaxMb: 3 }),
    ).resolves.toBe(3 * MB);
  });

  it("falls through a non-positive caller override to the account config", async () => {
    await expect(
      resolveMediaMaxBytes({ configuredMediaMaxMb: 2, optionMediaMaxMb: 0 }),
    ).resolves.toBe(2 * MB);
  });
});
