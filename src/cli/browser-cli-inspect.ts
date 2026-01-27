import type { Command } from "commander";

import type { SnapshotResult } from "../browser/client.js";
import { loadConfig } from "../config/config.js";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { callBrowserRequest, type BrowserParentOpts } from "./browser-cli-shared.js";

export function registerBrowserInspectCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  browser
    .command("screenshot")
    .description("Capture a screenshot (MEDIA:<path>)")
    .argument("[targetId]", "CDP target id (or unique prefix)")
    .option("--full-page", "Capture full scrollable page", false)
    .option("--ref <ref>", "ARIA ref from ai snapshot")
    .option("--element <selector>", "CSS selector for element screenshot")
    .option("--type <png|jpeg>", "Output type (default: png)", "png")
    .action(async (targetId: string | undefined, opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      try {
        const result = await callBrowserRequest<{ path: string }>(
          parent,
          {
            method: "POST",
            path: "/screenshot",
            query: profile ? { profile } : undefined,
            body: {
              targetId: targetId?.trim() || undefined,
              fullPage: Boolean(opts.fullPage),
              ref: opts.ref?.trim() || undefined,
              element: opts.element?.trim() || undefined,
              type: opts.type === "jpeg" ? "jpeg" : "png",
            },
          },
          { timeoutMs: 20000 },
        );
        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        defaultRuntime.log(`MEDIA:${shortenHomePath(result.path)}`);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  browser
    .command("snapshot")
    .description("Capture a snapshot (default: ai; aria is the accessibility tree)")
    .option("--format <aria|ai>", "Snapshot format (default: ai)", "ai")
    .option("--target-id <id>", "CDP target id (or unique prefix)")
    .option("--limit <n>", "Max nodes (default: 500/800)", (v: string) => Number(v))
    .option("--mode <efficient>", "Snapshot preset (efficient)")
    .option("--efficient", "Use the efficient snapshot preset", false)
    .option("--interactive", "Role snapshot: interactive elements only", false)
    .option("--compact", "Role snapshot: compact output", false)
    .option("--depth <n>", "Role snapshot: max depth", (v: string) => Number(v))
    .option("--selector <sel>", "Role snapshot: scope to CSS selector")
    .option("--frame <sel>", "Role snapshot: scope to an iframe selector")
    .option("--labels", "Include viewport label overlay screenshot", false)
    .option("--out <path>", "Write snapshot to a file")
    .action(async (opts, cmd) => {
      const parent = parentOpts(cmd);
      const profile = parent?.browserProfile;
      const format = opts.format === "aria" ? "aria" : "ai";
      const configMode =
        format === "ai" && loadConfig().browser?.snapshotDefaults?.mode === "efficient"
          ? "efficient"
          : undefined;
      const mode = opts.efficient === true || opts.mode === "efficient" ? "efficient" : configMode;
      try {
        const query: Record<string, string | number | boolean | undefined> = {
          format,
          targetId: opts.targetId?.trim() || undefined,
          limit: Number.isFinite(opts.limit) ? opts.limit : undefined,
          interactive: opts.interactive ? true : undefined,
          compact: opts.compact ? true : undefined,
          depth: Number.isFinite(opts.depth) ? opts.depth : undefined,
          selector: opts.selector?.trim() || undefined,
          frame: opts.frame?.trim() || undefined,
          labels: opts.labels ? true : undefined,
          mode,
          profile,
        };
        const result = await callBrowserRequest<SnapshotResult>(
          parent,
          {
            method: "GET",
            path: "/snapshot",
            query,
          },
          { timeoutMs: 20000 },
        );

        if (opts.out) {
          const fs = await import("node:fs/promises");
          if (result.format === "ai") {
            await fs.writeFile(opts.out, result.snapshot, "utf8");
          } else {
            const payload = JSON.stringify(result, null, 2);
            await fs.writeFile(opts.out, payload, "utf8");
          }
          if (parent?.json) {
            defaultRuntime.log(
              JSON.stringify(
                {
                  ok: true,
                  out: opts.out,
                  ...(result.format === "ai" && result.imagePath
                    ? { imagePath: result.imagePath }
                    : {}),
                },
                null,
                2,
              ),
            );
          } else {
            defaultRuntime.log(shortenHomePath(opts.out));
            if (result.format === "ai" && result.imagePath) {
              defaultRuntime.log(`MEDIA:${shortenHomePath(result.imagePath)}`);
            }
          }
          return;
        }

        if (parent?.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.format === "ai") {
          defaultRuntime.log(result.snapshot);
          if (result.imagePath) {
            defaultRuntime.log(`MEDIA:${shortenHomePath(result.imagePath)}`);
          }
          return;
        }

        const nodes = "nodes" in result ? result.nodes : [];
        defaultRuntime.log(
          nodes
            .map((n) => {
              const indent = "  ".repeat(Math.min(20, n.depth));
              const name = n.name ? ` "${n.name}"` : "";
              const value = n.value ? ` = "${n.value}"` : "";
              return `${indent}- ${n.role}${name}${value}`;
            })
            .join("\n"),
        );
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}
