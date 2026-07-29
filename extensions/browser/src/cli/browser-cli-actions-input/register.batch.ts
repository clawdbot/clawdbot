/**
 * Browser CLI batch command: runs nested act requests in one /act call.
 */
import type { Command } from "commander";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveBrowserActExecutionBudgetMs } from "../../browser/act-policy.js";
import type { BrowserActRequest } from "../../browser/client-actions.types.js";
import { BROWSER_TAB_REFERENCE_HELP, type BrowserParentOpts } from "../browser-cli-shared.js";
import { danger, defaultRuntime } from "../core-api.js";
import {
  callBrowserAct,
  logBrowserActionResult,
  readActionsPayload,
  resolveBrowserActionContext,
} from "./shared.js";

/** Registers the Browser CLI batch command. */
export function registerBrowserBatchCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("batch")
    .description("Run a batch of browser actions in one call (default: stop on first error)")
    .option("--actions <json>", "JSON array of act requests")
    .option("--actions-file <path>", "Read JSON array from a file (- for stdin)")
    .option("--continue", "Continue through all actions instead of stopping on first error")
    .option("--target-id <id>", BROWSER_TAB_REFERENCE_HELP)
    .action(async (opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      if (!opts.actions && !opts.actionsFile) {
        defaultRuntime.error(danger("Provide --actions, --actions-file, or --actions-file -"));
        defaultRuntime.exit(1);
        return;
      }
      let actions: unknown[];
      let result: { results?: Array<{ ok: boolean; error?: string }> };
      try {
        const payload = await readActionsPayload({
          actions: opts.actions,
          actionsFile: opts.actionsFile,
        });
        if (!payload.trim()) {
          throw new Error("actions are required");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch (cause) {
          throw new Error("actions must be valid JSON", { cause });
        }
        if (!Array.isArray(parsed)) {
          throw new Error("actions must be a JSON array");
        }
        if (!parsed.length) {
          throw new Error("actions must contain at least one entry");
        }
        actions = parsed;
        const targetId = normalizeOptionalString(opts.targetId);
        const body: Record<string, unknown> = {
          kind: "batch",
          actions,
          ...(targetId ? { targetId } : {}),
          ...(opts.continue ? { stopOnError: false } : {}),
        };
        const request = body as unknown as BrowserActRequest;
        result = await callBrowserAct<{
          results?: Array<{ ok: boolean; error?: string }>;
        }>({
          parent,
          profile,
          body,
          timeoutMs: resolveBrowserActExecutionBudgetMs(request),
        });
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
        return;
      }
      const failures = (result.results ?? []).flatMap((entry, index) =>
        entry.ok ? [] : [`action ${index + 1}: ${entry.error ?? "failed"}`],
      );
      // /act represents recoverable child errors in a successful response.
      // Surface them as a command failure so text-mode scripts do not report a false success.
      if (failures.length) {
        if (parent?.json) {
          defaultRuntime.writeJson(result);
        } else {
          defaultRuntime.error(danger(`batch failed: ${failures.join("; ")}`));
        }
        defaultRuntime.exit(1);
        return;
      }
      logBrowserActionResult(parent, result, `batch ran ${actions.length} action(s)`);
    });
}
