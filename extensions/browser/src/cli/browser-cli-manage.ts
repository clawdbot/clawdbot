import type { Command } from "commander";
import { runCommandWithRuntime } from "../core-api.js";
import { callBrowserRequest, type BrowserParentOpts } from "./browser-cli-shared.js";
import {
  danger,
  defaultRuntime,
  info,
  redactCdpUrl,
  shortenHomePath,
  type BrowserCreateProfileResult,
  type BrowserDeleteProfileResult,
  type BrowserResetProfileResult,
  type BrowserStatus,
  type BrowserTab,
  type BrowserTransport,
  type ProfileStatus,
} from "./core-api.js";

const BROWSER_MANAGE_REQUEST_TIMEOUT_MS = 45_000;

type BrowserDoctorCheck = {
  name: string;
  ok: boolean;
  detail?: string;
};

function resolveProfileQuery(
  profile?: string,
  extra?: Record<string, string | number | boolean | undefined>,
) {
  const query: Record<string, string | number | boolean | undefined> = {};
  if (profile) {
    query.profile = profile;
  }
  if (extra) {
    Object.assign(query, extra);
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

function printJsonResult(parent: BrowserParentOpts, payload: unknown): boolean {
  if (!parent?.json) {
    return false;
  }
  defaultRuntime.writeJson(payload);
  return true;
}

async function callTabAction(
  parent: BrowserParentOpts,
  profile: string | undefined,
  body:
    | { action: "new"; label?: string }
    | { action: "select" | "close"; index?: number }
    | { action: "label"; targetId: string; label: string },
) {
  return callBrowserRequest(
    parent,
    {
      method: "POST",
      path: "/tabs/action",
      query: resolveProfileQuery(profile),
      body,
    },
    { timeoutMs: BROWSER_MANAGE_REQUEST_TIMEOUT_MS },
  );
}

async function fetchBrowserStatus(
  parent: BrowserParentOpts,
  profile?: string,
): Promise<BrowserStatus> {
  return await callBrowserRequest<BrowserStatus>(
    parent,
    {
      method: "GET",
      path: "/",
      query: resolveProfileQuery(profile),
    },
    {
      timeoutMs: BROWSER_MANAGE_REQUEST_TIMEOUT_MS,
    },
  );
}

async function runBrowserToggle(
  parent: BrowserParentOpts,
  params: {
    profile?: string;
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
  },
) {
  await callBrowserRequest(parent, {
    method: "POST",
    path: params.path,
    query: resolveProfileQuery(params.profile, params.query),
  });
  const status = await fetchBrowserStatus(parent, params.profile);
  if (printJsonResult(parent, status)) {
    return;
  }
  const name = status.profile ?? "openclaw";
  const headlessLabel = params.path === "/start" && status.headless ? " (headless)" : "";
  defaultRuntime.log(info(`🦞 browser [${name}] running: ${status.running}${headlessLabel}`));
}

function runBrowserCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  });
}

function logBrowserTabs(tabs: BrowserTab[], json?: boolean) {
  if (json) {
    defaultRuntime.writeJson({ tabs });
    return;
  }
  if (tabs.length === 0) {
    defaultRuntime.log("No tabs (browser closed or no targets).");
    return;
  }
  defaultRuntime.log(
    tabs
      .map((t, i) => {
        const alias = [t.tabId, t.label ? `label:${t.label}` : undefined].filter(Boolean).join(" ");
        return `${i + 1}. ${t.title || "(untitled)"}${alias ? ` [${alias}]` : ""}\n   ${t.url}\n   id: ${t.targetId}`;
      })
      .join("\n"),
  );
}

function formatDoctorLine(check: BrowserDoctorCheck): string {
  return `${check.ok ? "OK" : "FAIL"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`;
}

async function runBrowserDoctor(parent: BrowserParentOpts, profile?: string, deep?: boolean) {
  const checks: BrowserDoctorCheck[] = [];
  let status: BrowserStatus | null = null;

  try {
    status = await fetchBrowserStatus(parent, profile);
    checks.push({
      name: "gateway",
      ok: true,
      detail: "browser control endpoint reachable",
    });
  } catch (err) {
    checks.push({
      name: "gateway",
      ok: false,
      detail: String(err),
    });
    return { ok: false, checks };
  }

  checks.push({
    name: "plugin",
    ok: status.enabled,
    detail: status.enabled ? "enabled" : "disabled in config",
  });
  checks.push({
    name: "profile",
    ok: true,
    detail: `${status.profile ?? "openclaw"} (${usesChromeMcpTransport(status) ? "chrome-mcp" : (status.transport ?? "cdp")})`,
  });
  checks.push({
    name: "browser",
    ok: status.running,
    detail: status.running
      ? `running${status.cdpReady === false ? ", CDP not ready" : ""}`
      : "not running; run `openclaw browser start`",
  });

  try {
    const profiles = await callBrowserRequest<{ profiles: ProfileStatus[] }>(
      parent,
      { method: "GET", path: "/profiles" },
      { timeoutMs: BROWSER_MANAGE_REQUEST_TIMEOUT_MS },
    );
    checks.push({
      name: "profiles",
      ok: true,
      detail: `${profiles.profiles?.length ?? 0} configured`,
    });
  } catch (err) {
    checks.push({
      name: "profiles",
      ok: false,
      detail: String(err),
    });
  }

  if (status.running) {
    try {
      const result = await callBrowserRequest<{ running: boolean; tabs: BrowserTab[] }>(
        parent,
        {
          method: "GET",
          path: "/tabs",
          query: resolveProfileQuery(profile),
        },
        { timeoutMs: BROWSER_MANAGE_REQUEST_TIMEOUT_MS },
      );
      const tabs = result.tabs ?? [];
      checks.push({
        name: "tabs",
        ok: true,
        detail: `${tabs.length} visible${tabs.length > 0 && tabs[0]?.suggestedTargetId ? `, use target ${tabs[0].suggestedTargetId}` : ""}`,
      });
    } catch (err) {
      checks.push({
        name: "tabs",
        ok: false,
        detail: String(err),
      });
    }
  }

  if (deep && status.running) {
    try {
      const result = await callBrowserRequest<
        | { ok: true; format: "aria"; nodes?: unknown[] }
        | { ok: true; format: "ai"; snapshot?: string }
      >(
        parent,
        {
          method: "GET",
          path: "/snapshot",
          query: resolveProfileQuery(profile, { format: "aria", limit: 25 }),
        },
        { timeoutMs: 10_000 },
      );
      const count =
        result.format === "aria"
          ? Array.isArray(result.nodes)
            ? result.nodes.length
            : 0
          : typeof result.snapshot === "string"
            ? result.snapshot.split("\n").length
            : 0;
      checks.push({
        name: "live-snapshot",
        ok: count > 0,
        detail: count > 0 ? `${count} nodes/lines` : "snapshot returned no content",
      });
    } catch (err) {
      checks.push({
        name: "live-snapshot",
        ok: false,
        detail: String(err),
      });
    }
  }

  return { ok: checks.every((check) => check.ok), checks, status };
}

function usesChromeMcpTransport(params: {
  transport?: BrowserTransport;
  driver?: "openclaw" | "existing-session";
}): boolean {
  return params.transport === "chrome-mcp" || params.driver === "existing-session";
}

function formatBrowserConnectionSummary(params: {
  transport?: BrowserTransport;
  driver?: "openclaw" | "existing-session";
  isRemote?: boolean;
  cdpPort?: number | null;
  cdpUrl?: string | null;
  userDataDir?: string | null;
}): string {
  if (usesChromeMcpTransport(params)) {
    const userDataDir = params.userDataDir ? shortenHomePath(params.userDataDir) : null;
    return userDataDir
      ? `transport: chrome-mcp, userDataDir: ${userDataDir}`
      : "transport: chrome-mcp";
  }
  if (params.isRemote) {
    return `cdpUrl: ${params.cdpUrl ?? "(unset)"}`;
  }
  return `port: ${params.cdpPort ?? "(unset)"}`;
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
        const status = await fetchBrowserStatus(parent, parent?.browserProfile);
        if (printJsonResult(parent, status)) {
          return;
        }
        const detectedPath = status.detectedExecutablePath ?? status.executablePath;
        const detectedDisplay = detectedPath ? shortenHomePath(detectedPath) : "auto";
        defaultRuntime.log(
          [
            `profile: ${status.profile ?? "openclaw"}`,
            `enabled: ${status.enabled}`,
            `running: ${status.running}`,
            `transport: ${
              usesChromeMcpTransport(status) ? "chrome-mcp" : (status.transport ?? "cdp")
            }`,
            ...(!usesChromeMcpTransport(status)
              ? [
                  `cdpPort: ${status.cdpPort ?? "(unset)"}`,
                  `cdpUrl: ${redactCdpUrl(status.cdpUrl ?? `http://127.0.0.1:${status.cdpPort}`)}`,
                ]
              : status.userDataDir
                ? [`userDataDir: ${shortenHomePath(status.userDataDir)}`]
                : []),
            `browser: ${status.chosenBrowser ?? "unknown"}`,
            `detectedBrowser: ${status.detectedBrowser ?? "unknown"}`,
            `detectedPath: ${detectedDisplay}`,
            `headless: ${status.headless}${
              status.headlessSource ? ` (${status.headlessSource})` : ""
            }`,
            `profileColor: ${status.color}`,
            ...(status.detectError ? [`detectError: ${status.detectError}`] : []),
          ].join("\n"),
        );
      });
    });

  browser
    .command("doctor")
    .description("Check browser plugin readiness")
    .option("--deep", "Run a live snapshot probe")
    .action(async (opts: { deep?: boolean }, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await runBrowserDoctor(parent, profile, opts.deep === true);
        if (printJsonResult(parent, result)) {
          return;
        }
        defaultRuntime.log(result.checks.map(formatDoctorLine).join("\n"));
        if (!result.ok) {
          defaultRuntime.exit(1);
        }
      });
    });

  browser
    .command("start")
    .description("Start the browser (no-op if already running)")
    .option("--headless", "Launch a local managed browser headless for this start")
    .action(async (opts: { headless?: boolean }, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        await runBrowserToggle(parent, {
          profile,
          path: "/start",
          query: opts.headless ? { headless: true } : undefined,
        });
      });
    });

  browser
    .command("stop")
    .description("Stop the browser (best-effort)")
    .action(async (_opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        await runBrowserToggle(parent, { profile, path: "/stop" });
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
            query: resolveProfileQuery(profile),
          },
          { timeoutMs: 20000 },
        );
        if (printJsonResult(parent, result)) {
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
            query: resolveProfileQuery(profile),
          },
          { timeoutMs: BROWSER_MANAGE_REQUEST_TIMEOUT_MS },
        );
        const tabs = result.tabs ?? [];
        logBrowserTabs(tabs, parent?.json);
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
            query: resolveProfileQuery(profile),
            body: {
              action: "list",
            },
          },
          { timeoutMs: BROWSER_MANAGE_REQUEST_TIMEOUT_MS },
        );
        const tabs = result.tabs ?? [];
        logBrowserTabs(tabs, parent?.json);
      });
    });

  tab
    .command("new")
    .description("Open a new tab (about:blank)")
    .option("--label <label>", "Assign a friendly tab label")
    .action(async (opts: { label?: string }, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await callTabAction(parent, profile, { action: "new", label: opts.label });
        if (printJsonResult(parent, result)) {
          return;
        }
        const opened = (result as { tab?: BrowserTab }).tab;
        defaultRuntime.log(
          opened?.tabId
            ? `opened new tab ${opened.tabId}${opened.label ? ` (${opened.label})` : ""}`
            : "opened new tab",
        );
      });
    });

  tab
    .command("label")
    .description("Assign a friendly label to a tab")
    .argument("<targetId>", "Target id, tab id, label, or unique target id prefix")
    .argument("<label>", "Friendly label")
    .action(async (targetId: string, label: string, _opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const result = await callTabAction(parent, profile, { action: "label", targetId, label });
        if (printJsonResult(parent, result)) {
          return;
        }
        const tab = (result as { tab?: BrowserTab }).tab;
        defaultRuntime.log(`labeled tab ${tab?.tabId ?? targetId} as ${tab?.label ?? label}`);
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
        const result = await callTabAction(parent, profile, {
          action: "select",
          index: Math.floor(index) - 1,
        });
        if (printJsonResult(parent, result)) {
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
        const result = await callTabAction(parent, profile, { action: "close", index: idx });
        if (printJsonResult(parent, result)) {
          return;
        }
        defaultRuntime.log("closed tab");
      });
    });

  browser
    .command("open")
    .description("Open a URL in a new tab")
    .argument("<url>", "URL to open")
    .option("--label <label>", "Assign a friendly tab label")
    .action(async (url: string, opts: { label?: string }, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        const tab = await callBrowserRequest<BrowserTab>(
          parent,
          {
            method: "POST",
            path: "/tabs/open",
            query: resolveProfileQuery(profile),
            body: { url, ...(opts.label ? { label: opts.label } : {}) },
          },
          { timeoutMs: BROWSER_MANAGE_REQUEST_TIMEOUT_MS },
        );
        if (printJsonResult(parent, tab)) {
          return;
        }
        defaultRuntime.log(
          `opened: ${tab.url}\n${tab.tabId ? `tab: ${tab.tabId}\n` : ""}${tab.label ? `label: ${tab.label}\n` : ""}id: ${tab.targetId}`,
        );
      });
    });

  browser
    .command("focus")
    .description("Focus a tab by target id, tab id, label, or unique target id prefix")
    .argument("<targetId>", "Target id, tab id, label, or unique target id prefix")
    .action(async (targetId: string, _opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserCommand(async () => {
        await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/tabs/focus",
            query: resolveProfileQuery(profile),
            body: { targetId },
          },
          { timeoutMs: BROWSER_MANAGE_REQUEST_TIMEOUT_MS },
        );
        if (printJsonResult(parent, { ok: true })) {
          return;
        }
        defaultRuntime.log(`focused tab ${targetId}`);
      });
    });

  browser
    .command("close")
    .description("Close a tab (target id optional)")
    .argument("[targetId]", "Target id, tab id, label, or unique target id prefix (optional)")
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
              query: resolveProfileQuery(profile),
            },
            { timeoutMs: BROWSER_MANAGE_REQUEST_TIMEOUT_MS },
          );
        } else {
          await callBrowserRequest(
            parent,
            {
              method: "POST",
              path: "/act",
              query: resolveProfileQuery(profile),
              body: { kind: "close" },
            },
            { timeoutMs: BROWSER_MANAGE_REQUEST_TIMEOUT_MS },
          );
        }
        if (printJsonResult(parent, { ok: true })) {
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
          { timeoutMs: BROWSER_MANAGE_REQUEST_TIMEOUT_MS },
        );
        const profiles = result.profiles ?? [];
        if (printJsonResult(parent, { profiles })) {
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
              const loc = formatBrowserConnectionSummary(p);
              const remote = p.isRemote ? " [remote]" : "";
              const driver = p.driver !== "openclaw" ? ` [${p.driver}]` : "";
              return `${p.name}: ${status}${tabs}${def}${remote}${driver}\n  ${loc}, color: ${p.color}`;
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
    .option("--user-data-dir <path>", "User data dir for existing-session Chromium attach")
    .option("--driver <driver>", "Profile driver (openclaw|existing-session). Default: openclaw")
    .action(
      async (
        opts: {
          name: string;
          color?: string;
          cdpUrl?: string;
          userDataDir?: string;
          driver?: string;
        },
        cmd,
      ) => {
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
                userDataDir: opts.userDataDir,
                driver: opts.driver === "existing-session" ? "existing-session" : undefined,
              },
            },
            { timeoutMs: 10_000 },
          );
          if (printJsonResult(parent, result)) {
            return;
          }
          const loc = `  ${formatBrowserConnectionSummary(result)}`;
          defaultRuntime.log(
            info(
              `🦞 Created profile "${result.profile}"\n${loc}\n  color: ${result.color}${
                result.userDataDir ? `\n  userDataDir: ${shortenHomePath(result.userDataDir)}` : ""
              }${opts.driver === "existing-session" ? "\n  driver: existing-session" : ""}`,
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
        if (printJsonResult(parent, result)) {
          return;
        }
        const msg = result.deleted
          ? `🦞 Deleted profile "${result.profile}" (user data removed)`
          : `🦞 Deleted profile "${result.profile}" (no user data found)`;
        defaultRuntime.log(info(msg));
      });
    });
}
