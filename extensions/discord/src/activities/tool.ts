import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  assertWidgetHtmlSize,
  isCompleteHtmlDocument,
  WidgetHtmlInputError,
} from "openclaw/plugin-sdk/widget-html";
import { Type } from "typebox";
import { resolveDiscordAccount } from "../accounts.js";
import { sendDiscordComponentMessage } from "../send.components.js";
import { buildDiscordPresentationComponents } from "../shared-interactive.js";
import { resolveDiscordChannelId as resolveDiscordTargetChannelId } from "../target-parsing.js";
import type { DiscordActivitiesRuntime } from "./runtime.js";

const DISCORD_WIDGET_HTML_MAX_BYTES = 48 * 1024;

const DiscordWidgetParameters = Type.Object({
  html: Type.String({ description: "Self-contained HTML document or body fragment" }),
  title: Type.String({ minLength: 1, maxLength: 80 }),
  button_label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
});

const ShowWidgetParameters = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 80 }),
  widget_code: Type.String({ description: "Self-contained HTML document or body fragment" }),
  button_label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
});

function currentConfig(context: OpenClawPluginToolContext, runtime: DiscordActivitiesRuntime) {
  return (
    context.getRuntimeConfig?.() ??
    context.runtimeConfig ??
    context.config ??
    runtime.currentConfig()
  );
}

function resolveDiscordChannelId(context: OpenClawPluginToolContext): string | undefined {
  const raw = context.nativeChannelId?.trim() || context.deliveryContext?.to?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    return resolveDiscordTargetChannelId(raw);
  } catch {
    return undefined;
  }
}

function buildDiscordWidgetDocument(title: string, html: string): string {
  if (isCompleteHtmlDocument(html)) {
    return html;
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:dark;background:#111214;color:#dbdee1;font:14px system-ui,sans-serif}*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{padding:16px}</style></head><body>${html}</body></html>`;
}

type DiscordWidgetToolDeps = {
  runtime: DiscordActivitiesRuntime;
  sendComponentMessage?: typeof sendDiscordComponentMessage;
  now?: () => number;
};

type DiscordWidgetToolVariant = {
  name: "discord_widget" | "show_widget";
  label: string;
  description: string;
  htmlParam: "html" | "widget_code";
  parameters: typeof DiscordWidgetParameters | typeof ShowWidgetParameters;
};

const DISCORD_WIDGET_VARIANT: DiscordWidgetToolVariant = {
  name: "discord_widget",
  label: "Discord Widget",
  description:
    "Deprecated: use show_widget. Show an interactive, self-contained HTML widget to the user in Discord.",
  htmlParam: "html",
  parameters: DiscordWidgetParameters,
};

const SHOW_WIDGET_VARIANT: DiscordWidgetToolVariant = {
  name: "show_widget",
  label: "Show Widget",
  description:
    "Show an interactive, self-contained HTML widget to the user on their current surface. In Discord, posts an Activity launch button.",
  htmlParam: "widget_code",
  parameters: ShowWidgetParameters,
};

function createDiscordWidgetToolVariant(
  context: OpenClawPluginToolContext,
  deps: DiscordWidgetToolDeps,
  variant: DiscordWidgetToolVariant,
): AnyAgentTool | null {
  if (context.messageChannel !== "discord") {
    return null;
  }
  const cfg = currentConfig(context, deps.runtime);
  const account = resolveDiscordAccount({
    cfg,
    accountId: context.agentAccountId ?? context.deliveryContext?.accountId,
  });
  if (!deps.runtime.isAccountEnabled(account.accountId, cfg)) {
    return null;
  }

  return {
    label: variant.label,
    name: variant.name,
    description: variant.description,
    parameters: variant.parameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>;
      const html = readStringParam(params, variant.htmlParam, { required: true, trim: false });
      const title = readStringParam(params, "title", { required: true });
      const buttonLabel = readStringParam(params, "button_label") || "Open widget";
      if (!html.trim()) {
        throw new WidgetHtmlInputError(`${variant.htmlParam} is required`);
      }
      assertWidgetHtmlSize(html, DISCORD_WIDGET_HTML_MAX_BYTES, {
        inputName: variant.htmlParam,
      });
      if (title.length > 80) {
        throw new WidgetHtmlInputError("title must be 80 characters or fewer");
      }
      if (!buttonLabel.trim() || buttonLabel.length > 80) {
        throw new WidgetHtmlInputError("button_label must be 1 to 80 characters");
      }
      const channelId = resolveDiscordChannelId(context);
      if (!channelId) {
        throw new WidgetHtmlInputError(
          `${variant.name} requires a concrete Discord channel in the current session`,
        );
      }
      // Persist before the button can be delivered so a launch never races an absent record;
      // roll the record back if the post fails so a failed send leaves no unreachable widget.
      const widgetId = await deps.runtime.store.createWidget({
        html: buildDiscordWidgetDocument(title, html),
        title,
        channelId,
        accountId: account.accountId,
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
        deliveryRecord ??= deps.runtime.store.markWidgetDelivered(
          widgetId,
          deliveryResult.messageId,
        );
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
                  label: buttonLabel.trim(),
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
          `channel:${channelId}`,
          { ...components, text: title },
          {
            cfg: cfg as OpenClawConfig,
            accountId: account.accountId,
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
          await deps.runtime.store.deleteWidget(widgetId);
          throw error;
        }
        // sendDiscordComponentMessage awaits onDeliveryResult before later bookkeeping. Marker
        // failures were surfaced above, so only post-delivery bookkeeping can reach this recovery.
        result = deliveredResult;
      }
      return jsonResult({ widgetId, messageId: result.messageId, channelId: result.channelId });
    },
  };
}

export function createDiscordWidgetTool(
  context: OpenClawPluginToolContext,
  deps: DiscordWidgetToolDeps,
): AnyAgentTool | null {
  return createDiscordWidgetToolVariant(context, deps, DISCORD_WIDGET_VARIANT);
}

export function createDiscordShowWidgetTool(
  context: OpenClawPluginToolContext,
  deps: DiscordWidgetToolDeps,
): AnyAgentTool | null {
  return createDiscordWidgetToolVariant(context, deps, SHOW_WIDGET_VARIANT);
}
