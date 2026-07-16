import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import { Type } from "typebox";
import { resolveDiscordAccount } from "../accounts.js";
import { buildDiscordActivityCustomId } from "../component-custom-id.js";
import { Button, Row } from "../internal/discord.js";
import { sendMessageDiscord } from "../send.js";
import type { DiscordActivitiesRuntime } from "./runtime.js";

const DISCORD_WIDGET_HTML_MAX_BYTES = 48 * 1024;

const DiscordWidgetParameters = Type.Object({
  html: Type.String({ description: "Self-contained HTML document or body fragment" }),
  title: Type.String({ minLength: 1, maxLength: 80 }),
  button_label: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
});

class DiscordWidgetInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

class DiscordWidgetLaunchButton extends Button {
  constructor(
    readonly customId: string,
    readonly label: string,
  ) {
    super();
  }
}

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
  const normalized = raw.replace(/^channel:/i, "");
  return /^\d+$/.test(normalized) ? normalized : undefined;
}

function buildDiscordWidgetDocument(title: string, html: string): string {
  if (/^(?:<!doctype\s+html\b|<html\b)/i.test(html.trimStart())) {
    return html;
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:dark;background:#111214;color:#dbdee1;font:14px system-ui,sans-serif}*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{padding:16px}</style></head><body>${html}</body></html>`;
}

type DiscordWidgetToolDeps = {
  runtime: DiscordActivitiesRuntime;
  sendMessage?: typeof sendMessageDiscord;
  now?: () => number;
};

export function createDiscordWidgetTool(
  context: OpenClawPluginToolContext,
  deps: DiscordWidgetToolDeps,
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
    label: "Discord Widget",
    name: "discord_widget",
    description:
      "Show an interactive HTML widget to Discord users. Posts a message with an Open widget button; the widget opens inside Discord as an Activity. HTML must be fully self-contained with inline CSS and JavaScript and no external network access.",
    parameters: DiscordWidgetParameters,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Record<string, unknown>;
      const html = readStringParam(params, "html", { required: true, trim: false });
      const title = readStringParam(params, "title", { required: true });
      const buttonLabel = readStringParam(params, "button_label") || "Open widget";
      if (!html.trim()) {
        throw new DiscordWidgetInputError("html is required");
      }
      if (Buffer.byteLength(html, "utf8") > DISCORD_WIDGET_HTML_MAX_BYTES) {
        throw new DiscordWidgetInputError(
          `html exceeds maximum size (${DISCORD_WIDGET_HTML_MAX_BYTES} bytes)`,
        );
      }
      if (title.length > 80) {
        throw new DiscordWidgetInputError("title must be 80 characters or fewer");
      }
      if (!buttonLabel.trim() || buttonLabel.length > 80) {
        throw new DiscordWidgetInputError("button_label must be 1 to 80 characters");
      }
      const channelId = resolveDiscordChannelId(context);
      if (!channelId) {
        throw new DiscordWidgetInputError(
          "discord_widget requires a concrete Discord channel in the current session",
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
      let result: Awaited<ReturnType<typeof sendMessageDiscord>>;
      try {
        result = await (deps.sendMessage ?? sendMessageDiscord)(`channel:${channelId}`, title, {
          cfg: cfg as OpenClawConfig,
          accountId: account.accountId,
          components: [
            new Row([
              new DiscordWidgetLaunchButton(
                buildDiscordActivityCustomId(widgetId),
                buttonLabel.trim(),
              ),
            ]),
          ],
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        await deps.runtime.store.deleteWidget(widgetId);
        throw error;
      }
      return jsonResult({ widgetId, messageId: result.messageId, channelId: result.channelId });
    },
  };
}
