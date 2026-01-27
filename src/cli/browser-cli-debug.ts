import type { Command } from "commander";

import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { callBrowserRequest, type BrowserParentOpts } from "./browser-cli-shared.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { shortenHomePath } from "../utils.js";

function runBrowserDebug(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (err) => {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  });
}

export function registerBrowserDebugCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("highlight")
    .description("Highlight an element by ref")
    .argument("<ref>", "Ref id from snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (ref: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserDebug(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/highlight",
            query: profile ? { profile } : undefined,
            body: {
              ref: ref.trim(),
              targetId: opts.targetId?.trim() || undefined,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`highlighted ${ref.trim()}`);
      });
    });

  browser
    .command("errors")
    .description("Get recent page errors")
    .option("--clear", "Clear stored errors after reading", false)
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserDebug(async () => {
        const result = await callBrowserRequest<{
          errors: Array<{ timestamp: string; name?: string; message: string }>;
        }>(
          parent,
          {
            method: "GET",
            path: "/errors",
            query: {
              targetId: opts.targetId?.trim() || undefined,
              clear: Boolean(opts.clear),
              profile,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        if (!result.errors.length) {
          defaultRuntime.log("No page errors.");
          return;
        }
        defaultRuntime.log(
          result.errors
            .map((e) => `${e.timestamp} ${e.name ? `${e.name}: ` : ""}${e.message}`)
            .join("\n"),
        );
      });
    });

  browser
    .command("requests")
    .description("Get recent network requests (best-effort)")
    .option("--filter <text>", "Only show URLs that contain this substring")
    .option("--clear", "Clear stored requests after reading", false)
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserDebug(async () => {
        const result = await callBrowserRequest<{
          requests: Array<{
            timestamp: string;
            method: string;
            status?: number;
            ok?: boolean;
            url: string;
            failureText?: string;
          }>;
        }>(
          parent,
          {
            method: "GET",
            path: "/requests",
            query: {
              targetId: opts.targetId?.trim() || undefined,
              filter: opts.filter?.trim() || undefined,
              clear: Boolean(opts.clear),
              profile,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        if (!result.requests.length) {
          defaultRuntime.log("No requests recorded.");
          return;
        }
        defaultRuntime.log(
          result.requests
            .map((r) => {
              const status = typeof r.status === "number" ? ` ${r.status}` : "";
              const ok = r.ok === true ? " ok" : r.ok === false ? " fail" : "";
              const fail = r.failureText ? ` (${r.failureText})` : "";
              return `${r.timestamp} ${r.method}${status}${ok} ${r.url}${fail}`;
            })
            .join("\n"),
        );
      });
    });

  const trace = browser.command("trace").description("Record a Playwright trace");

  trace
    .command("start")
    .description("Start trace recording")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--no-screenshots", "Disable screenshots")
    .option("--no-snapshots", "Disable snapshots")
    .option("--sources", "Include sources (bigger traces)", false)
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserDebug(async () => {
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/trace/start",
            query: profile ? { profile } : undefined,
            body: {
              targetId: opts.targetId?.trim() || undefined,
              screenshots: Boolean(opts.screenshots),
              snapshots: Boolean(opts.snapshots),
              sources: Boolean(opts.sources),
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("trace started");
      });
    });

  trace
    .command("stop")
    .description("Stop trace recording and write a .zip")
    .option("--out <path>", "Output path for the trace zip")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserDebug(async () => {
        const result = await callBrowserRequest<{ path: string }>(
          parent,
          {
            method: "POST",
            path: "/trace/stop",
            query: profile ? { profile } : undefined,
            body: {
              targetId: opts.targetId?.trim() || undefined,
              path: opts.out?.trim() || undefined,
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`TRACE:${shortenHomePath(result.path)}`);
      });
    });
}
