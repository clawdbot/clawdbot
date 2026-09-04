import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { buildDiscordActivityCustomId } from "../component-custom-id.js";
import type { sendDiscordComponentMessage } from "../send.components.js";
import { createDiscordSendReceipt } from "../send.receipt.js";
import { createDiscordWidgetPresenter } from "./presenter.js";
import {
  createActivityTestConfig,
  createActivityTestRuntime,
} from "./test-helpers.test-support.js";

type WidgetPresenter = Parameters<OpenClawPluginApi["registerWidgetPresenter"]>[0];
type WidgetPresenterContext = Parameters<WidgetPresenter["availability"]>[0];
type SendResult = Awaited<ReturnType<typeof sendDiscordComponentMessage>>;

function discordContext(overrides: Partial<WidgetPresenterContext> = {}): WidgetPresenterContext {
  return {
    messageChannel: "discord",
    nativeChannelId: "987654321",
    accountId: "default",
    sessionKey: "agent:main:discord",
    ...overrides,
  };
}

function sendResult(messageId = "1000000000000000001"): SendResult {
  return {
    messageId,
    channelId: "987654321",
    receipt: createDiscordSendReceipt({
      platformMessageIds: [messageId],
      channelId: "987654321",
      kind: "card",
    }),
  };
}

async function present(
  presenter: WidgetPresenter,
  context: WidgetPresenterContext = discordContext(),
  html = "<!doctype html><html><body><p>Canonical</p></body></html>",
) {
  return await presenter.present({
    context,
    document: { kind: "html", html },
    title: "Status",
  });
}

describe("Discord Activity widget presenter", () => {
  it("matches only configured Discord channel routes", async () => {
    const presenter = createDiscordWidgetPresenter(createActivityTestRuntime());

    expect(presenter.target).toBe("current_channel");
    if (presenter.target !== "current_channel") {
      throw new Error("expected current-channel presenter");
    }
    expect(presenter.match(discordContext())).toBe(true);
    expect(presenter.match(discordContext({ messageChannel: "slack" }))).toBe(false);
    expect(
      presenter.match(
        discordContext({
          nativeChannelId: undefined,
          deliveryContext: { channel: "discord", to: "discord:user:987654321" },
        }),
      ),
    ).toBe(false);

    const unconfigured = createDiscordWidgetPresenter(
      createActivityTestRuntime(createActivityTestConfig({ clientSecret: "" })),
    );
    expect(unconfigured.target).toBe("current_channel");
    expect(unconfigured.target === "current_channel" && unconfigured.match(discordContext())).toBe(
      false,
    );
    await expect(unconfigured.availability(discordContext())).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });

    await expect(
      presenter.present({
        context: discordContext(),
        document: { kind: "html", html: "<p>too long</p>" },
        title: "x".repeat(81),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "presentation_error", message: "title must be 80 characters or fewer" },
    });
  });

  it("stores the canonical document before posting a fixed launch button", async () => {
    const runtime = createActivityTestRuntime();
    const createWidget = vi.spyOn(runtime.store, "createWidget");
    const send = vi.fn(async (..._args: Parameters<typeof sendDiscordComponentMessage>) =>
      sendResult(),
    );
    const canonicalHtml = '<!doctype html><html><body data-owner="core">Canonical</body></html>';
    const presenter = createDiscordWidgetPresenter(runtime, {
      sendComponentMessage: send as unknown as typeof sendDiscordComponentMessage,
      now: () => 7,
    });

    const result = await present(presenter, discordContext(), canonicalHtml);
    expect(result).toMatchObject({
      ok: true,
      value: {
        kind: "message",
        receipt: { primaryPlatformMessageId: "1000000000000000001" },
      },
    });
    const widgetIdPromise = createWidget.mock.results[0]?.value;
    if (!widgetIdPromise) {
      throw new Error("expected widget creation");
    }
    const widgetId = await widgetIdPromise;
    const stored = await runtime.store.lookupWidget(widgetId);
    expect(stored).toMatchObject({
      html: canonicalHtml,
      title: "Status",
      channelId: "987654321",
      accountId: "default",
      createdAt: 7,
      deliveredMessageId: "1000000000000000001",
    });
    expect(send.mock.calls[0]?.[1]).toEqual({
      text: "Status",
      blocks: [
        {
          type: "actions",
          buttons: [
            {
              label: "Open widget",
              style: "secondary",
              internalCustomId: buildDiscordActivityCustomId(widgetId ?? ""),
            },
          ],
        },
      ],
    });
    expect(send.mock.calls[0]?.[2]).toMatchObject({
      accountId: "default",
      allowedMentions: { parse: [] },
    });
  });

  it("resolves provider-prefixed current-channel targets", async () => {
    const send = vi.fn(async () => sendResult());
    const presenter = createDiscordWidgetPresenter(createActivityTestRuntime(), {
      sendComponentMessage: send as unknown as typeof sendDiscordComponentMessage,
    });
    const context = discordContext({
      nativeChannelId: undefined,
      currentMessagingTarget: "discord:channel:987654321",
    });

    expect(presenter.target === "current_channel" && presenter.match(context)).toBe(true);
    await expect(present(presenter, context)).resolves.toMatchObject({ ok: true });
    expect(send).toHaveBeenCalledWith(
      "channel:987654321",
      expect.objectContaining({ text: "Status" }),
      expect.any(Object),
    );
  });

  it("rolls back only the undelivered widget when component delivery fails", async () => {
    const runtime = createActivityTestRuntime();
    const existingId = await runtime.store.createWidget({
      html: "<p>existing</p>",
      title: "Existing",
      channelId: "987654321",
      accountId: "default",
      createdAt: 1,
    });
    await runtime.store.markWidgetDelivered(existingId, "1000000000000000000");
    const failure = new Error("send failed");
    const presenter = createDiscordWidgetPresenter(runtime, {
      sendComponentMessage: vi.fn(async () => {
        throw failure;
      }) as unknown as typeof sendDiscordComponentMessage,
    });

    await expect(present(presenter)).rejects.toBe(failure);
    await expect(
      runtime.store.latestPostedWidgetForChannel("default", "987654321"),
    ).resolves.toMatchObject({ id: existingId, widget: { title: "Existing" } });
  });

  it("keeps a delivered widget when later component bookkeeping fails", async () => {
    const runtime = createActivityTestRuntime();
    const delivery = sendResult();
    const presenter = createDiscordWidgetPresenter(runtime, {
      sendComponentMessage: vi.fn(
        async (...args: Parameters<typeof sendDiscordComponentMessage>) => {
          await args[2].onDeliveryResult?.(delivery);
          throw new Error("component registry failed");
        },
      ) as unknown as typeof sendDiscordComponentMessage,
    });

    await expect(present(presenter)).resolves.toMatchObject({ ok: true });
    await expect(
      runtime.store.latestPostedWidgetForChannel("default", "987654321"),
    ).resolves.toMatchObject({ widget: { deliveredMessageId: delivery.messageId } });
  });

  it("surfaces delivery-record failures without deleting the delivered widget", async () => {
    const runtime = createActivityTestRuntime();
    const createWidget = vi.spyOn(runtime.store, "createWidget");
    vi.spyOn(runtime.store, "markWidgetDelivered").mockRejectedValueOnce(
      new Error("state unavailable"),
    );
    const presenter = createDiscordWidgetPresenter(runtime, {
      sendComponentMessage: vi.fn(async () =>
        sendResult(),
      ) as unknown as typeof sendDiscordComponentMessage,
    });

    await expect(present(presenter)).rejects.toThrow(
      "Discord widget was delivered, but its delivery state could not be saved",
    );
    const widgetIdPromise = createWidget.mock.results[0]?.value;
    if (!widgetIdPromise) {
      throw new Error("expected widget creation");
    }
    await expect(runtime.store.lookupWidget(await widgetIdPromise)).resolves.toMatchObject({
      deliveredMessageId: null,
    });
  });
});
