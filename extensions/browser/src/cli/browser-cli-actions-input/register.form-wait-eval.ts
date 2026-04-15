import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { BrowserParentOpts } from "../browser-cli-shared.js";
import { danger, defaultRuntime } from "../core-api.js";
import {
  callBrowserAct,
  logBrowserActionResult,
  readFields,
  resolveBrowserActionContext,
} from "./shared.js";

export function registerBrowserFormWaitEvalCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("fill")
    .description("Fill a form with JSON field descriptors")
    .option("--fields <json>", "JSON array of field objects")
    .option("--fields-file <path>", "Read JSON array from a file")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        const fields = await readFields({
          fields: opts.fields,
          fieldsFile: opts.fieldsFile,
        });
        const result = await callBrowserAct<{ result?: unknown }>({
          parent,
          profile,
          body: {
            kind: "fill",
            fields,
            targetId: normalizeOptionalString(opts.targetId),
          },
        });
        logBrowserActionResult(parent, result, `filled ${fields.length} field(s)`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("wait")
    .description("Wait for time, selector, URL, load state, or JS conditions")
    .argument("[selector]", "CSS selector to wait for (visible)")
    .option("--time <ms>", "Wait for N milliseconds", (v: string) => Number(v))
    .option("--text <value>", "Wait for text to appear")
    .option("--text-gone <value>", "Wait for text to disappear")
    .option("--url <pattern>", "Wait for URL (supports globs like **/dash)")
    .option("--load <load|domcontentloaded|networkidle>", "Wait for load state")
    .option("--fn <js>", "Wait for JS condition (passed to waitForFunction)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for each condition (default: 20000)",
      (v: string) => Number(v),
    )
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (selector: string | undefined, opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        const sel = normalizeOptionalString(selector);
        const load =
          opts.load === "load" || opts.load === "domcontentloaded" || opts.load === "networkidle"
            ? (opts.load as "load" | "domcontentloaded" | "networkidle")
            : undefined;
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined;
        const result = await callBrowserAct<{ result?: unknown }>({
          parent,
          profile,
          body: {
            kind: "wait",
            timeMs: Number.isFinite(opts.time) ? opts.time : undefined,
            text: normalizeOptionalString(opts.text),
            textGone: normalizeOptionalString(opts.textGone),
            selector: sel,
            url: normalizeOptionalString(opts.url),
            loadState: load,
            fn: normalizeOptionalString(opts.fn),
            targetId: normalizeOptionalString(opts.targetId),
            timeoutMs,
          },
          timeoutMs,
        });
        logBrowserActionResult(parent, result, "wait complete");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("evaluate")
    .description("Evaluate a function against the page or a ref")
    .option("--fn <code>", "Function source, e.g. (el) => el.textContent")
    .option("--ref <id>", "Ref from snapshot")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .action(async (opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      if (!opts.fn) {
        defaultRuntime.error(danger("Missing --fn"));
        defaultRuntime.exit(1);
        return;
      }
      try {
        const result = await callBrowserAct<{ result?: unknown }>({
          parent,
          profile,
          body: {
            kind: "evaluate",
            fn: opts.fn,
            ref: normalizeOptionalString(opts.ref),
            targetId: normalizeOptionalString(opts.targetId),
          },
        });
        if (parent?.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        defaultRuntime.writeJson(result.result ?? null);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
