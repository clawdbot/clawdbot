import type { Command } from "commander";
import type {
  BrowserCreateProfileResult,
  BrowserDeleteProfileResult,
  BrowserResetProfileResult,
  BrowserStatus,
  BrowserTab,
  ProfileStatus,
} from "../browser/client.js";
import { danger, info } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { callBrowserRequest, type BrowserParentOpts } from "./browser-cli-shared.js";
import { runCommandWithRuntime } from "./cli-utils.js";

function runBrowserCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  });
}

export function registerBrowserManageCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("status")
    .description("Show browser status")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCommand(async () => {
        const status = await callBrowserRequest<BrowserStatus>(
          parent,
          {
            method: "GET",
            path: "/",
            query: parent?.browserProfile ? { profile: parent.browserProfile } : undefined,
          },
          {
            timeoutMs: 1500,
          },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(status, null, 2));
          return;
        }
        const detectedPath = status.detectedExecutablePath ?? status.executablePath;
        const detectedDisplay = detectedPath ? shortenHomePath(detectedPath) : "auto";
        defaultRuntime.log(
          [
            `profile: ${status.profile ?? "clawd"}`,
            `enabled: ${status.enabled}`,
            `running: ${status.running}`,
            `cdpPort: ${status.cdpPort}`,
            `cdpUrl: ${status.cdpUrl ?? `http://127.0.0.1:${status.cdpPort}`}`,
            `browser: ${status.chosenBrowser ?? "unknown"}`,
            `detectedBrowser: ${status.detectedBrowser ?? "unknown"}`,
            `detectedPath: ${detectedDisplay}`,
            `profileColor: ${status.color}`,
            ...(status.detectError ? [`detectError: ${status.detectError}`] : []),
          ].join("\n"),
        );
      });
    });

  browser
    .command("start")
    .description("Start the browser (no-op if already running)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/start",
            query: profile ? { profile } : undefined,
          },
          { timeoutMs: 15000 },
        );
        const status = await callBrowserRequest<BrowserStatus>(
          parent,
          {
            method: "GET",
            path: "/",
            query: profile ? { profile } : undefined,
          },
          { timeoutMs: 1500 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(status, null, 2));
          return;
        }
        const name = status.profile ?? "clawd";
        defaultRuntime.log(info(`🦞 browser [${name}] running: ${status.running}`));
      });
    });

  browser
    .command("stop")
    .description("Stop the browser (best-effort)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/stop",
            query: profile ? { profile } : undefined,
          },
          { timeoutMs: 15000 },
        );
        const status = await callBrowserRequest<BrowserStatus>(
          parent,
          {
            method: "GET",
            path: "/",
            query: profile ? { profile } : undefined,
          },
          { timeoutMs: 1500 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(status, null, 2));
          return;
        }
        const name = status.profile ?? "clawd";
        defaultRuntime.log(info(`🦞 browser [${name}] running: ${status.running}`));
      });
    });

  browser
    .command("reset-profile")
    .description("Reset browser profile (moves it to Trash)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest<BrowserResetProfileResult>(
          parent,
          {
            method: "POST",
            path: "/reset-profile",
            query: profile ? { profile } : undefined,
          },
          { timeoutMs: 20000 },
        );
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
      });
    });

  browser
    .command("tabs")
    .description("List open tabs")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest<{ running: boolean; tabs: BrowserTab[] }>(
          parent,
          {
            method: "GET",
            path: "/tabs",
            query: profile ? { profile } : undefined,
          },
          { timeoutMs: 3000 },
        );
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
      });
    });

  const tab = browser
    .command("tab")
    .description("Tab shortcuts (index-based)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest<{ ok: true; tabs: BrowserTab[] }>(
          parent,
          {
            method: "POST",
            path: "/tabs/action",
            query: profile ? { profile } : undefined,
            body: {
              action: "list",
            },
          },
          { timeoutMs: 10_000 },
        );
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
      });
    });

  tab
    .command("new")
    .description("Open a new tab (about:blank)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/tabs/action",
            query: profile ? { profile } : undefined,
            body: { action: "new" },
          },
          { timeoutMs: 10_000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("opened new tab");
      });
    });

  tab
    .command("select")
    .description("Focus tab by index (1-based)")
    .argument("<index>", "Tab index (1-based)", (v: string) => Number(v))
    .action(async (index: number, _opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      if (!Number.isFinite(index) || index < 1) {
        defaultRuntime.error(danger("index must be a positive number"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/tabs/action",
            query: profile ? { profile } : undefined,
            body: { action: "select", index: Math.floor(index) - 1 },
          },
          { timeoutMs: 10_000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`selected tab ${Math.floor(index)}`);
      });
    });

  tab
    .command("close")
    .description("Close tab by index (1-based); default: first tab")
    .argument("[index]", "Tab index (1-based)", (v: string) => Number(v))
    .action(async (index: number | undefined, _opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      const idx =
        typeof index === "number" && Number.isFinite(index) ? Math.floor(index) - 1 : undefined;
      if (typeof idx === "number" && idx < 0) {
        defaultRuntime.error(danger("index must be >= 1"));
        defaultRuntime.exit(1);
        return;
      }
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/tabs/action",
            query: profile ? { profile } : undefined,
            body: { action: "close", index: idx },
          },
          { timeoutMs: 10_000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("closed tab");
      });
    });

  browser
    .command("open")
    .description("Open a URL in a new tab")
    .argument("<url>", "URL to open")
    .action(async (url: string, _opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const tab = await callBrowserRequest<BrowserTab>(
          parent,
          {
            method: "POST",
            path: "/tabs/open",
            query: profile ? { profile } : undefined,
            body: { url },
          },
          { timeoutMs: 15000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(tab, null, 2));
          return;
        }
        defaultRuntime.log(`opened: ${tab.url}\nid: ${tab.targetId}`);
      });
    });

  browser
    .command("focus")
    .description("Focus a tab by target id (or unique prefix)")
    .argument("<targetId>", "Target id or unique prefix")
    .action(async (targetId: string, _opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/tabs/focus",
            query: profile ? { profile } : undefined,
            body: { targetId },
          },
          { timeoutMs: 5000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ ok: true }, null, 2));
          return;
        }
        defaultRuntime.log(`focused tab ${targetId}`);
      });
    });

  browser
    .command("close")
    .description("Close a tab (target id optional)")
    .argument("[targetId]", "Target id or unique prefix (optional)")
    .action(async (targetId: string | undefined, _opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        if (targetId?.trim()) {
          await callBrowserRequest(
            parent,
            {
              method: "DELETE",
              path: `/tabs/${encodeURIComponent(targetId.trim())}`,
              query: profile ? { profile } : undefined,
            },
            { timeoutMs: 5000 },
          );
        } else {
          await callBrowserRequest(
            parent,
            {
              method: "POST",
              path: "/act",
              query: profile ? { profile } : undefined,
              body: { kind: "close" },
            },
            { timeoutMs: 20000 },
          );
        }
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify({ ok: true }, null, 2));
          return;
        }
        defaultRuntime.log("closed tab");
      });
    });

  // Profile management commands
  browser
    .command("profiles")
    .description("List all browser profiles")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest<{ profiles: ProfileStatus[] }>(
          parent,
          {
            method: "GET",
            path: "/profiles",
          },
          { timeoutMs: 3000 },
        );
        const profiles = result.profiles ?? [];
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
      });
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
        await runBrowserCommand(async () => {
          const result = await callBrowserRequest<BrowserCreateProfileResult>(
            parent,
            {
              method: "POST",
              path: "/profiles/create",
              body: {
                name: opts.name,
                color: opts.color,
                cdpUrl: opts.cdpUrl,
                driver: opts.driver === "extension" ? "extension" : undefined,
              },
            },
            { timeoutMs: 10_000 },
          );
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
        });
      },
    );

  browser
    .command("delete-profile")
    .description("Delete a browser profile")
    .requiredOption("--name <name>", "Profile name to delete")
    .action(async (opts: { name: string }, cmd) => {
      const parent = parentOpts(cmd);
      await runBrowserCommand(async () => {
        const result = await callBrowserRequest<BrowserDeleteProfileResult>(
          parent,
          {
            method: "DELETE",
            path: `/profiles/${encodeURIComponent(opts.name)}`,
          },
          { timeoutMs: 20_000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        const msg = result.deleted
          ? `🦞 Deleted profile "${result.profile}" (user data removed)`
          : `🦞 Deleted profile "${result.profile}" (no user data found)`;
        defaultRuntime.log(info(msg));
      });
    });
}
