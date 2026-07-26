// Qa Lab tests cover canonical live transport adapter factory routing.
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../bus-state.js";
import { createQaChannelTransport } from "../qa-channel-transport.js";
import { createQaTransportAdapter } from "../qa-transport-registry.js";
import { listQaScenariosForExecutionProfile } from "../scenario-catalog.js";

const { createDiscord, createMatrix, createSlack, createTelegram, createWhatsApp } = vi.hoisted(
  () => ({
    createDiscord: vi.fn(),
    createMatrix: vi.fn(),
    createSlack: vi.fn(),
    createTelegram: vi.fn(),
    createWhatsApp: vi.fn(),
  }),
);

vi.mock("./discord/adapter.runtime.js", () => ({ createDiscordQaTransportAdapter: createDiscord }));
vi.mock("./matrix/adapter.runtime.js", () => ({ createMatrixQaTransportAdapter: createMatrix }));
vi.mock("./slack/adapter.runtime.js", () => ({ createSlackQaTransportAdapter: createSlack }));
vi.mock("./telegram/adapter.runtime.js", () => ({
  createTelegramQaTransportAdapter: createTelegram,
}));
vi.mock("./whatsapp/adapter.runtime.js", () => ({
  createWhatsAppQaTransportAdapter: createWhatsApp,
}));

import { discordQaCliRegistration } from "./discord/cli.js";
import { matrixQaCliRegistration } from "./matrix/cli.js";
import { slackQaCliRegistration } from "./slack/cli.js";
import { telegramQaCliRegistration } from "./telegram/cli.js";
import { whatsappQaCliRegistration } from "./whatsapp/cli.js";

const discordQaAdapterFactory = discordQaCliRegistration.adapterFactory;
const matrixQaAdapterFactory = matrixQaCliRegistration.adapterFactory;
const slackQaAdapterFactory = slackQaCliRegistration.adapterFactory;
const telegramQaAdapterFactory = telegramQaCliRegistration.adapterFactory;
const whatsappQaAdapterFactory = whatsappQaCliRegistration.adapterFactory;
if (
  !discordQaAdapterFactory ||
  !matrixQaAdapterFactory ||
  !slackQaAdapterFactory ||
  !telegramQaAdapterFactory ||
  !whatsappQaAdapterFactory
) {
  throw new Error("expected live transport adapter factories");
}

const factories = [
  telegramQaAdapterFactory,
  discordQaAdapterFactory,
  matrixQaAdapterFactory,
  slackQaAdapterFactory,
  whatsappQaAdapterFactory,
] as const;

describe("live transport adapter factories", () => {
  it("opts only the disposable Matrix adapter into same-channel parallelism", () => {
    expect(matrixQaAdapterFactory.isolatesInstances).toBe(true);
    expect(discordQaAdapterFactory.isolatesInstances).toBeUndefined();
    expect(slackQaAdapterFactory.isolatesInstances).toBeUndefined();
    expect(telegramQaAdapterFactory.isolatesInstances).toBeUndefined();
    expect(whatsappQaAdapterFactory.isolatesInstances).toBeUndefined();
  });

  it("selects Slack generic defaults from the YAML adapter profile", () => {
    expect(
      listQaScenariosForExecutionProfile("slack:adapter").map((scenario) => scenario.id),
    ).toEqual([
      "channel-chat-baseline",
      "channel-canary",
      "channel-mention-gating",
      "channel-top-level-reply-shape",
      "thread-follow-up",
      "thread-isolation",
    ]);
  });

  it("selects WhatsApp DM-safe defaults from the YAML adapter profile", () => {
    expect(
      listQaScenariosForExecutionProfile("whatsapp:adapter").map((scenario) => scenario.id),
    ).toEqual([
      "dm-chat-baseline",
      "channel-canary",
      "channel-dm-group-routing",
      "channel-mention-gating",
      "channel-top-level-reply-shape",
      "whatsapp-help-command",
    ]);
  });

  it.each([
    ["discord", createDiscord],
    ["matrix", createMatrix],
    ["telegram", createTelegram],
    ["slack", createSlack],
    ["whatsapp", createWhatsApp],
  ] as const)(
    "creates the canonical %s adapter through the shared registry",
    async (channelId, create) => {
      const adapterOptions = { sutAccountId: `${channelId}-sut` };
      const state = createQaBusState();
      const adapter = createQaChannelTransport(state);
      create.mockResolvedValueOnce(adapter);
      const created = await createQaTransportAdapter(
        {
          channelId,
          adapterOptions,
          driver: "live",
          outputDir: ".artifacts/qa-e2e",
          state,
        },
        factories,
      );

      expect(created.adapter.id).toBe(adapter.id);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterOptions,
          channelId,
          driver: "live",
          messages: expect.objectContaining({
            addInboundMessage: expect.any(Function),
            addOutboundMessage: expect.any(Function),
            editMessage: expect.any(Function),
          }),
        }),
      );
    },
  );
});
