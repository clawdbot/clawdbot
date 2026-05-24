import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runBrowserResizeWithOutput } from "../browser-cli-resize.js";
import { callBrowserRequest, type BrowserParentOpts } from "../browser-cli-shared.js";
import { danger, defaultRuntime } from "../core-api.js";
import { requireRef, resolveBrowserActionContext } from "./shared.js";

export function registerBrowserNavigationCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  const parseRequiredNumber = (value: unknown, label: string): number | undefined => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      defaultRuntime.error(danger(`Invalid ${label}: must be a finite number`));
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
    .argument("<width>", "Viewport width", (v: string) => Number(v))
    .argument("<height>", "Viewport height", (v: string) => Number(v))
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (width: number, height: number, opts, cmd) => {
      const normalizedWidth = parseRequiredNumber(width, "width");
      const normalizedHeight = parseRequiredNumber(height, "height");
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
