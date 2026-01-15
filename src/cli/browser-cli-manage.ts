import type { Command } from "commander";
import type { BrowserTab } from "../browser/client.js";
import {
  browserCloseTab,
  browserCreateProfile,
  browserDeleteProfile,
  browserFocusTab,
  browserOpenTab,
  browserProfiles,
  browserResetProfile,
  browserStart,
  browserStatus,
  browserStop,
  browserTabAction,
  browserTabs,
  resolveBrowserControlUrl,
} from "../browser/client.js";
import { browserAct } from "../browser/client-actions-core.js";
import { danger, info } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";

export function registerBrowserManageCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("status")
    .description("Show browser status")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const status = await browserStatus(baseUrl, {
          profile: parent?.browserProfile,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(status, null, 2));
          return;
        }
        defaultRuntime.log(
          [
            `profile: ${status.profile ?? "clawd"}`,
            `enabled: ${status.enabled}`,
            `running: ${status.running}`,
            `controlUrl: ${status.controlUrl}`,
            `cdpPort: ${status.cdpPort}`,
            `cdpUrl: ${status.cdpUrl ?? `http://127.0.0.1:${status.cdpPort}`}`,
            `browser: ${status.chosenBrowser ?? "unknown"}`,
            `profileColor: ${status.color}`,
          ].join("\n"),
        );
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("start")
    .description("Start the browser (no-op if already running)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      try {
        await browserStart(baseUrl, { profile });
        const status = await browserStatus(baseUrl, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(status, null, 2));
          return;
        }
        const name = status.profile ?? "clawd";
        defaultRuntime.log(info(`🦞 browser [${name}] running: ${status.running}`));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("stop")
    .description("Stop the browser (best-effort)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      try {
        await browserStop(baseUrl, { profile });
        const status = await browserStatus(baseUrl, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(status, null, 2));
          return;
        }
        const name = status.profile ?? "clawd";
        defaultRuntime.log(info(`🦞 browser [${name}] running: ${status.running}`));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("reset-profile")
    .description("Reset browser profile (moves it to Trash)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      try {
        const result = await browserResetProfile(baseUrl, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        if (!result.moved) {
          defaultRuntime.log(info(`🦞 browser profile already missing.`));
          return;
        }
        const dest = result.to ?? result.from;
        defaultRuntime.log(info(`🦞 browser profile moved to Trash (${dest})`));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("tabs")
    .description("List open tabs")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      try {
        const tabs = await browserTabs(baseUrl, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ tabs }, null, 2));
          return;
        }
        if (tabs.length === 0) {
          defaultRuntime.log("No tabs (browser closed or no targets).");
          return;
        }
        defaultRuntime.log(
          tabs
            .map(
              (t, i) => `${i + 1}. ${t.title || "(untitled)"}\n   ${t.url}\n   id: ${t.targetId}`,
            )
            .join("\n"),
        );
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  const tab = browser
    .command("tab")
    .description("Tab shortcuts (index-based)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      try {
        const result = (await browserTabAction(baseUrl, {
          action: "list",
          profile,
        })) as { ok: true; tabs: BrowserTab[] };
        const tabs = result.tabs ?? [];
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ tabs }, null, 2));
          return;
        }
        if (tabs.length === 0) {
          defaultRuntime.log("No tabs (browser closed or no targets).");
          return;
        }
        defaultRuntime.log(
          tabs
            .map(
              (t, i) => `${i + 1}. ${t.title || "(untitled)"}\n   ${t.url}\n   id: ${t.targetId}`,
            )
            .join("\n"),
        );
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  tab
    .command("new")
    .description("Open a new tab (about:blank)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      try {
        const result = await browserTabAction(baseUrl, {
          action: "new",
          profile,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("opened new tab");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  tab
    .command("select")
    .description("Focus tab by index (1-based)")
    .argument("<index>", "Tab index (1-based)", (v: string) => Number(v))
    .action(async (index: number, _opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      if (!Number.isFinite(index) || index < 1) {
        defaultRuntime.error(danger("index must be a positive number"));
        defaultRuntime.exit(1);
        return;
      }
      try {
        const result = await browserTabAction(baseUrl, {
          action: "select",
          index: Math.floor(index) - 1,
          profile,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`selected tab ${Math.floor(index)}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  tab
    .command("close")
    .description("Close tab by index (1-based); default: first tab")
    .argument("[index]", "Tab index (1-based)", (v: string) => Number(v))
    .action(async (index: number | undefined, _opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      const idx =
        typeof index === "number" && Number.isFinite(index) ? Math.floor(index) - 1 : undefined;
      if (typeof idx === "number" && idx < 0) {
        defaultRuntime.error(danger("index must be >= 1"));
        defaultRuntime.exit(1);
        return;
      }
      try {
        const result = await browserTabAction(baseUrl, {
          action: "close",
          index: idx,
          profile,
        });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("closed tab");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("open")
    .description("Open a URL in a new tab")
    .argument("<url>", "URL to open")
    .action(async (url: string, _opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      try {
        const tab = await browserOpenTab(baseUrl, url, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(tab, null, 2));
          return;
        }
        defaultRuntime.log(`opened: ${tab.url}\nid: ${tab.targetId}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("focus")
    .description("Focus a tab by target id (or unique prefix)")
    .argument("<targetId>", "Target id or unique prefix")
    .action(async (targetId: string, _opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      try {
        await browserFocusTab(baseUrl, targetId, { profile });
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ ok: true }, null, 2));
          return;
        }
        defaultRuntime.log(`focused tab ${targetId}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("close")
    .description("Close a tab (target id optional)")
    .argument("[targetId]", "Target id or unique prefix (optional)")
    .action(async (targetId: string | undefined, _opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      const profile = parent?.browserProfile;
      try {
        if (targetId?.trim()) {
          await browserCloseTab(baseUrl, targetId.trim(), { profile });
        } else {
          await browserAct(baseUrl, { kind: "close" }, { profile });
        }
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ ok: true }, null, 2));
          return;
        }
        defaultRuntime.log("closed tab");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  // Profile management commands
  browser
    .command("profiles")
    .description("List all browser profiles")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const profiles = await browserProfiles(baseUrl);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ profiles }, null, 2));
          return;
        }
        if (profiles.length === 0) {
          defaultRuntime.log("No profiles configured.");
          return;
        }
        defaultRuntime.log(
          profiles
            .map((p) => {
              const status = p.running ? "running" : "stopped";
              const tabs = p.running ? ` (${p.tabCount} tabs)` : "";
              const def = p.isDefault ? " [default]" : "";
              const loc = p.isRemote ? `cdpUrl: ${p.cdpUrl}` : `port: ${p.cdpPort}`;
              const remote = p.isRemote ? " [remote]" : "";
              return `${p.name}: ${status}${tabs}${def}${remote}\n  ${loc}, color: ${p.color}`;
            })
            .join("\n"),
        );
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("create-profile")
    .description("Create a new browser profile")
    .requiredOption("--name <name>", "Profile name (lowercase, numbers, hyphens)")
    .option("--color <hex>", "Profile color (hex format, e.g. #0066CC)")
    .option("--cdp-url <url>", "CDP URL for remote Chrome (http/https)")
    .option("--driver <driver>", "Profile driver (clawd|extension). Default: clawd")
    .action(
      async (opts: { name: string; color?: string; cdpUrl?: string; driver?: string }, cmd) => {
        const parent = parentOpts(cmd);
        const baseUrl = resolveBrowserControlUrl(parent?.url);
        try {
          const result = await browserCreateProfile(baseUrl, {
            name: opts.name,
            color: opts.color,
            cdpUrl: opts.cdpUrl,
            driver: opts.driver === "extension" ? "extension" : undefined,
          });
          if (parent?.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const loc = result.isRemote ? `  cdpUrl: ${result.cdpUrl}` : `  port: ${result.cdpPort}`;
          defaultRuntime.log(
            info(
              `🦞 Created profile "${result.profile}"\n${loc}\n  color: ${result.color}${
                opts.driver === "extension" ? "\n  driver: extension" : ""
              }`,
            ),
          );
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      },
    );

  browser
    .command("delete-profile")
    .description("Delete a browser profile")
    .requiredOption("--name <name>", "Profile name to delete")
    .action(async (opts: { name: string }, cmd) => {
      const parent = parentOpts(cmd);
      const baseUrl = resolveBrowserControlUrl(parent?.url);
      try {
        const result = await browserDeleteProfile(baseUrl, opts.name);
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        const msg = result.deleted
          ? `🦞 Deleted profile "${result.profile}" (user data removed)`
          : `🦞 Deleted profile "${result.profile}" (no user data found)`;
        defaultRuntime.log(info(msg));
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
