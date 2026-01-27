import type { Command } from "commander";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { callBrowserRequest, type BrowserParentOpts } from "../browser-cli-shared.js";
import { resolveBrowserActionContext } from "./shared.js";
import { shortenHomePath } from "../../utils.js";

export function registerBrowserFilesAndDownloadsCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("upload")
    .description("Arm file upload for the next file chooser")
    .argument("<paths...>", "File paths to upload")
    .option("--ref <ref>", "Ref id from snapshot to click after arming")
    .option("--input-ref <ref>", "Ref id for <input type=file> to set directly")
    .option("--element <selector>", "CSS selector for <input type=file>")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the next file chooser (default: 120000)",
      (v: string) => Number(v),
    )
    .action(async (paths: string[], opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined;
        const result = await callBrowserRequest<{ download: { path: string } }>(
          parent,
          {
            method: "POST",
            path: "/hooks/file-chooser",
            query: profile ? { profile } : undefined,
            body: {
              paths,
              ref: opts.ref?.trim() || undefined,
              inputRef: opts.inputRef?.trim() || undefined,
              element: opts.element?.trim() || undefined,
              targetId: opts.targetId?.trim() || undefined,
              timeoutMs,
            },
          },
          { timeoutMs: timeoutMs ?? 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`upload armed for ${paths.length} file(s)`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("waitfordownload")
    .description("Wait for the next download (and save it)")
    .argument("[path]", "Save path (default: /tmp/moltbot/downloads/...)")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the next download (default: 120000)",
      (v: string) => Number(v),
    )
    .action(async (outPath: string | undefined, opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined;
        const result = await callBrowserRequest<{ download: { path: string } }>(
          parent,
          {
            method: "POST",
            path: "/wait/download",
            query: profile ? { profile } : undefined,
            body: {
              path: outPath?.trim() || undefined,
              targetId: opts.targetId?.trim() || undefined,
              timeoutMs,
            },
          },
          { timeoutMs: timeoutMs ?? 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`downloaded: ${shortenHomePath(result.download.path)}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("download")
    .description("Click a ref and save the resulting download")
    .argument("<ref>", "Ref id from snapshot to click")
    .argument("<path>", "Save path")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the download to start (default: 120000)",
      (v: string) => Number(v),
    )
    .action(async (ref: string, outPath: string, opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      try {
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined;
        const result = await callBrowserRequest<{ download: { path: string } }>(
          parent,
          {
            method: "POST",
            path: "/download",
            query: profile ? { profile } : undefined,
            body: {
              ref,
              path: outPath,
              targetId: opts.targetId?.trim() || undefined,
              timeoutMs,
            },
          },
          { timeoutMs: timeoutMs ?? 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`downloaded: ${shortenHomePath(result.download.path)}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("dialog")
    .description("Arm the next modal dialog (alert/confirm/prompt)")
    .option("--accept", "Accept the dialog", false)
    .option("--dismiss", "Dismiss the dialog", false)
    .option("--prompt <text>", "Prompt response text")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option(
      "--timeout-ms <ms>",
      "How long to wait for the next dialog (default: 120000)",
      (v: string) => Number(v),
    )
    .action(async (opts, cmd) => {
      const { parent, profile } = resolveBrowserActionContext(cmd, parentOpts);
      const accept = opts.accept ? true : opts.dismiss ? false : undefined;
      if (accept === undefined) {
        defaultRuntime.error(danger("Specify --accept or --dismiss"));
        defaultRuntime.exit(1);
        return;
      }
      try {
        const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : undefined;
        const result = await callBrowserRequest(
          parent,
          {
            method: "POST",
            path: "/hooks/dialog",
            query: profile ? { profile } : undefined,
            body: {
              accept,
              promptText: opts.prompt?.trim() || undefined,
              targetId: opts.targetId?.trim() || undefined,
              timeoutMs,
            },
          },
          { timeoutMs: timeoutMs ?? 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log("dialog armed");
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
