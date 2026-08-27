import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveDiscordAccount } from "../accounts.js";
import { sendDiscordComponentMessage } from "../send.components.js";
import { buildDiscordPresentationComponents } from "../shared-interactive.js";
import { resolveDiscordChannelId as resolveDiscordTargetChannelId } from "../target-parsing.js";
import type { DiscordActivitiesRuntime } from "./runtime.js";

const DISCORD_WIDGET_HTML_MAX_BYTES = 48 * 1024;

type WidgetPresenter = Parameters<OpenClawPluginApi["registerWidgetPresenter"]>[0];
type WidgetPresenterContext = Parameters<WidgetPresenter["availability"]>[0];

type DiscordWidgetPresenterDeps = {
  sendComponentMessage?: typeof sendDiscordComponentMessage;
  now?: () => number;
};

function resolveDiscordChannelId(context: WidgetPresenterContext): string | undefined {
  const raw =
    context.nativeChannelId?.trim() ||
    context.currentMessagingTarget?.trim() ||
    context.currentChannelId?.trim() ||
    context.deliveryContext?.to?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    return resolveDiscordTargetChannelId(raw);
  } catch {
    return undefined;
  }
}

function resolveDiscordPresentationRoute(
  context: WidgetPresenterContext,
  runtime: DiscordActivitiesRuntime,
) {
  if (context.messageChannel !== "discord") {
    return undefined;
  }
  const cfg = runtime.currentConfig();
  const account = resolveDiscordAccount({
    cfg,
    accountId: context.accountId ?? context.deliveryContext?.accountId,
  });
  const channelId = resolveDiscordChannelId(context);
  const activityAccount = runtime.resolveAccount(account.accountId, cfg);
  if (!channelId || !activityAccount) {
    return undefined;
  }
  return { account: activityAccount, cfg, channelId };
}

/** Presents a canonical core widget document in the active Discord channel. */
export function createDiscordWidgetPresenter(
  runtime: DiscordActivitiesRuntime,
  deps: DiscordWidgetPresenterDeps = {},
): WidgetPresenter {
  return {
    target: "current_channel",
    description: "Post an Activity launch button in the current Discord channel",
    capabilities: {
      sourceKinds: ["html"],
      maxSourceBytes: DISCORD_WIDGET_HTML_MAX_BYTES,
    },
    match: (context) => resolveDiscordPresentationRoute(context, runtime) !== undefined,
    async availability(context) {
      return resolveDiscordPresentationRoute(context, runtime)
        ? { ok: true, value: { available: true } }
        : {
            ok: false,
            error: {
              code: "unavailable",
              message: "Discord Activities are unavailable for the current channel and account.",
            },
          };
    },
    async present({ context, document, title }) {
      const route = resolveDiscordPresentationRoute(context, runtime);
      if (!route) {
        return {
          ok: false,
          error: {
            code: "unavailable",
            message: "Discord Activities are unavailable for the current channel and account.",
          },
        };
      }
      if (title.length > 80) {
        return {
          ok: false,
          error: { code: "presentation_error", message: "title must be 80 characters or fewer" },
        };
      }

      // Persist before the button can be delivered so a launch never races an absent record;
      // roll the record back if the post fails so a failed send leaves no unreachable widget.
      const widgetId = await runtime.store.createWidget({
        html: document.html,
        title,
        channelId: route.channelId,
        accountId: route.account.accountId,
        createdAt: (deps.now ?? Date.now)(),
      });
      let result: Awaited<ReturnType<typeof sendDiscordComponentMessage>>;
      let deliveredResult: Awaited<ReturnType<typeof sendDiscordComponentMessage>> | undefined;
      let deliveryRecord: Promise<void> | undefined;
      let deliveryRecordError: Error | undefined;
      const recordDelivery = async (
        deliveryResult: Awaited<ReturnType<typeof sendDiscordComponentMessage>>,
      ) => {
        deliveredResult = deliveryResult;
        deliveryRecord ??= runtime.store.markWidgetDelivered(widgetId, deliveryResult.messageId);
        try {
          await deliveryRecord;
        } catch (error) {
          deliveryRecordError ??= new Error(
            "Discord widget was delivered, but its delivery state could not be saved",
            { cause: error },
          );
          throw deliveryRecordError;
        }
      };
      try {
        const components = buildDiscordPresentationComponents({
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Open widget",
                  action: { type: "web-app", widgetId },
                },
              ],
            },
          ],
        });
        if (!components) {
          throw new Error("Discord widget launch button could not be rendered");
        }
        result = await (deps.sendComponentMessage ?? sendDiscordComponentMessage)(
          `channel:${route.channelId}`,
          { ...components, text: title },
          {
            cfg: route.cfg,
            accountId: route.account.accountId,
            allowedMentions: { parse: [] },
            onDeliveryResult: recordDelivery,
          },
        );
        await recordDelivery(result);
      } catch (error) {
        if (deliveryRecordError) {
          throw deliveryRecordError;
        }
        if (!deliveredResult) {
          await runtime.store.deleteWidget(widgetId);
          throw error;
        }
        // sendDiscordComponentMessage awaits onDeliveryResult before later bookkeeping. Marker
        // failures were surfaced above, so only post-delivery bookkeeping can reach this recovery.
        result = deliveredResult;
      }
      return { ok: true, value: { kind: "message", receipt: result.receipt } };
    },
  };
}
