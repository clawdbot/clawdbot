/**
 * Browser CLI observation commands for console, PDF, and response bodies.
 */
import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  BROWSER_TAB_REFERENCE_HELP,
  callBrowserRequest,
  parseBrowserPositiveIntegerOption,
  printBrowserJsonResult,
  runBrowserCliCommand as runBrowserObserve,
  type BrowserParentOpts,
} from "./browser-cli-shared.js";
import { defaultRuntime, shortenHomePath } from "./core-api.js";

const BROWSER_CONSOLE_LEVELS = ["error", "warn", "info"] as const;

function parseBrowserConsoleLevel(value: string): (typeof BROWSER_CONSOLE_LEVELS)[number] {
  const level = BROWSER_CONSOLE_LEVELS.find((candidate) => candidate === value);
  if (!level) {
    throw new Error(
      `--level must be ${BROWSER_CONSOLE_LEVELS.slice(0, -1).join(", ")}, or ${BROWSER_CONSOLE_LEVELS.at(-1)}.`,
    );
  }
  return level;
}

/** Registers Browser commands that observe current page state without direct input. */
export function registerBrowserActionObserveCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("console")
    .description("Get recent console messages")
    .option(
      "--level <level>",
      `Filter by level (${BROWSER_CONSOLE_LEVELS.join(", ")})`,
      parseBrowserConsoleLevel,
    )
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserObserve(async () => {
        const result = await callBrowserRequest<{ messages: unknown[] }>(
          parent,
          {
            method: "GET",
            path: "/console",
            query: {
              level: normalizeOptionalString(opts.level),
              targetId: normalizeOptionalString(opts.targetId),
              profile,
            },
          },
          { timeoutMs: 20000 },
        );
        if (printBrowserJsonResult(parent, result)) {
          return;
        }
        defaultRuntime.writeJson(result.messages);
      });
    });

  browser
    .command("pdf")
    .description("Save page as PDF")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserObserve(async () => {
        const result = await callBrowserRequest<{ path: string }>(
          parent,
          {
            method: "POST",
            path: "/pdf",
            query: profile ? { profile } : undefined,
            body: { targetId: normalizeOptionalString(opts.targetId) },
          },
          { timeoutMs: 20000 },
        );
        if (printBrowserJsonResult(parent, result)) {
          return;
        }
        defaultRuntime.log(`PDF: ${shortenHomePath(result.path)}`);
      });
    });

  browser
    .command("responsebody")
    .description("Wait for a network response and return its body")
    .argument("<url>", "URL (exact, substring, or glob like **/api)")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the response (default: 20000)",
      (v: string) => parseBrowserPositiveIntegerOption(v, "--timeout-ms"),
    )
    .option("--max-chars <n>", "Max body chars to return (default: 200000)", (v: string) =>
      parseBrowserPositiveIntegerOption(v, "--max-chars"),
    )
    .action(async (url: string, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      await runBrowserObserve(async () => {
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined;
        const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : undefined;
        const result = await callBrowserRequest<{ response: { body: string } }>(
          parent,
          {
            method: "POST",
            path: "/response/body",
            query: profile ? { profile } : undefined,
            body: {
              url,
              targetId: normalizeOptionalString(opts.targetId),
              timeoutMs,
              maxChars,
            },
          },
          { timeoutMs: timeoutMs ?? 20000 },
        );
        if (printBrowserJsonResult(parent, result)) {
          return;
        }
        defaultRuntime.log(result.response.body);
      });
    });
}
