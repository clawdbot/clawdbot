/**
 * Browser CLI navigation and viewport commands.
 */
import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  parseBrowserViewportDimension,
  runBrowserResizeWithOutput,
} from "../browser-cli-resize.js";
import {
  BROWSER_TAB_REFERENCE_HELP,
  callBrowserRequest,
  type BrowserParentOpts,
} from "../browser-cli-shared.js";
import { danger, defaultRuntime } from "../core-api.js";
import { resolveBrowserActionContext } from "./shared.js";

/** Registers Browser navigate and resize commands. */
export function registerBrowserNavigationCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("navigate")
    .description("Navigate the current tab to a URL")
    .argument("<url>", "URL to navigate to")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (url: string, opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        const result = await callBrowserRequest<{ url?: string }>(parent, {
          method: "POST",
          path: "/navigate",
          query: profile ? { profile } : undefined,
          body: {
            url,
            targetId: normalizeOptionalString(opts.targetId),
          },
        });
        if (parent?.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        defaultRuntime.log(`navigated to ${result.url ?? url}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("resize")
    .description("Resize the viewport")
    .argument("<width>", "Viewport width")
    .argument("<height>", "Viewport height")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (width: string, height: string, opts, cmd) => {
      const normalizedWidth = parseBrowserViewportDimension(width, "width");
      const normalizedHeight = parseBrowserViewportDimension(height, "height");
      if (normalizedWidth === undefined || normalizedHeight === undefined) {
        return;
      }
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        await runBrowserResizeWithOutput({
          parent,
          profile,
          width: normalizedWidth,
          height: normalizedHeight,
          targetId: opts.targetId,
          successMessage: `resized to ${normalizedWidth}x${normalizedHeight}`,
        });
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
