import type { MessagePresentationBlock } from "openclaw/plugin-sdk/interactive-runtime";
import type { v2 } from "./app-server/protocol.js";
import { formatCodexDisplayText } from "./command-formatters.js";

export const CODEX_PLUGIN_APP_LINK_PAGE_SIZE = 5;

export function buildCodexPluginAppLinks(
  apps: readonly Pick<v2.AppSummary, "id" | "name" | "installUrl">[],
  options: { continuationCommand?: string } = {},
): MessagePresentationBlock[] {
  const blocks = apps
    .slice(0, CODEX_PLUGIN_APP_LINK_PAGE_SIZE)
    .map((app): MessagePresentationBlock => {
      const name = formatCodexDisplayText((app.name.trim() || app.id).slice(0, 80));
      const url = safeCodexAppLink(app.installUrl);
      return url
        ? {
            type: "buttons",
            buttons: [{ label: `Set up / manage ${name}`, action: { type: "url", url } }],
          }
        : {
            type: "text",
            text: `${name}: setup/manage link unavailable. In Codex CLI, run /apps and select this app to continue.`,
          };
    });
  const remaining = apps.length - CODEX_PLUGIN_APP_LINK_PAGE_SIZE;
  if (remaining > 0) {
    blocks.push({
      type: "text",
      text: `${remaining} more apps are not shown. ${options.continuationCommand ? "Choose More apps to continue." : "In Codex CLI, run /apps to review the remaining apps."}`,
    });
  }
  if (options.continuationCommand) {
    blocks.push({
      type: "buttons",
      buttons: [
        { label: "More apps", action: { type: "command", command: options.continuationCommand } },
      ],
    });
  }
  if (apps.length > 0) {
    blocks.push({
      type: "context",
      text: "Use the same ChatGPT account and workspace as Codex in your browser. Opening an app page does not confirm that it is connected or callable in this conversation. If the app is not shown, in Codex CLI run /apps and select it.",
    });
  }
  return blocks;
}

function safeCodexAppLink(value: string | null): string | undefined {
  if (!value || value.length > 2048 || /[\s\p{Cc}\p{Cf}<>]/u.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    // Match Codex's hosted app-auth destinations; never send sign-in to a
    // metadata-supplied lookalike host or rewrite a staging origin to production.
    const host = url.hostname;
    const hosted =
      host === "chatgpt.com" ||
      host === "chatgpt-staging.com" ||
      host.endsWith(".chatgpt.com") ||
      host.endsWith(".chatgpt-staging.com");
    return url.protocol === "https:" && !url.username && !url.password && hosted
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
