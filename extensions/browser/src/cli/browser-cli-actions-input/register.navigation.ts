import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ACT_MAX_VIEWPORT_DIMENSION } from "../../browser/act-policy.js";
import { runBrowserResizeWithOutput } from "../browser-cli-resize.js";
import {
  callBrowserRequest,
  parseBrowserPositiveIntegerValue,
  type BrowserParentOpts,
} from "../browser-cli-shared.js";
import { danger, defaultRuntime } from "../core-api.js";
import { requireRef, resolveBrowserActionContext } from "./shared.js";

export function registerBrowserNavigationCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const parsePositiveInteger = (value: unknown, label: string): number | undefined => {
    const parsed = parseBrowserPositiveIntegerValue(value);
    if (parsed === undefined) {
      defaultRuntime.error(danger(`Invalid ${label}: must be a positive integer`));
      defaultRuntime.exit(1);
      return undefined;
    }
    if (parsed > ACT_MAX_VIEWPORT_DIMENSION) {
      defaultRuntime.error(danger(`Invalid ${label}: maximum is ${ACT_MAX_VIEWPORT_DIMENSION}`));
      defaultRuntime.exit(1);
      return undefined;
    }
    return parsed;
  };

  browser
    .command("navigate")
    .description("Navigate the current tab to a URL")
    .argument("<url>", "URL to navigate to")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (url: string, opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        const result = await callBrowserRequest<{ url?: string }>(
          parent,
          {
            method: "POST",
            path: "/navigate",
            query: profile ? { profile } : undefined,
            body: {
              url,
              targetId: normalizeOptionalString(opts.targetId),
            },
          },
          { timeoutMs: 20000 },
        );
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
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (width: string, height: string, opts, cmd) => {
      const normalizedWidth = parsePositiveInteger(width, "width");
      const normalizedHeight = parsePositiveInteger(height, "height");
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
          timeoutMs: 20000,
          successMessage: `resized to ${normalizedWidth}x${normalizedHeight}`,
        });
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  // Keep `requireRef` reachable; shared utilities are intended for other modules too.
  void requireRef;
}
