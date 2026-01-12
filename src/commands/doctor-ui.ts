import fs from "node:fs/promises";
import path from "node:path";
import { resolveClawdbotPackageRoot } from "../infra/clawdbot-root.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

export async function maybeRepairUiProtocolFreshness(
  _runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  const root = await resolveClawdbotPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });

  if (!root) return;

  const schemaPath = path.join(root, "src/gateway/protocol/schema.ts");
  const uiIndexPath = path.join(root, "dist/control-ui/index.html");

  try {
    const [schemaStats, uiStats] = await Promise.all([
      fs.stat(schemaPath),
      fs.stat(uiIndexPath),
    ]);

    if (schemaStats.mtime > uiStats.mtime) {
      const uiMtimeIso = uiStats.mtime.toISOString();
      // Find changes since the UI build
      const gitLog = await runCommandWithTimeout(
        [
          "git",
          "-C",
          root,
          "log",
          `--since=${uiMtimeIso}`,
          "--format=%h %s",
          "src/gateway/protocol/schema.ts",
        ],
        { timeoutMs: 5000 },
      ).catch(() => null);

      if (gitLog?.stdout.trim()) {
        note(
          `UI assets are older than the protocol schema.\nFunctional changes since last build:\n${gitLog.stdout
            .trim()
            .split("\n")
            .map((l) => `- ${l}`)
            .join("\n")}`,
          "UI Freshness",
        );

        const shouldRepair = await prompter.confirmAggressive({
          message:
            "Rebuild UI now? (Detected protocol mismatch requiring update)",
          initialValue: true,
        });

        if (shouldRepair) {
          note("Rebuilding stale UI assets... (this may take a moment)", "UI");
          // Use scripts/ui.js to build, assuming node is available as we are running in it.
          // We use the same node executable to run the script.
          const uiScriptPath = path.join(root, "scripts/ui.js");
          await runCommandWithTimeout(
            [process.execPath, uiScriptPath, "build"],
            {
              cwd: root,
              timeoutMs: 120_000,
              env: { ...process.env, FORCE_COLOR: "1" },
            },
          );
          note("UI rebuild complete.", "UI");
        }
      }
    }
  } catch (_err) {
    // If files don't exist, we can't check.
    // If git fails, we silently skip.
    // runtime.debug(`UI freshness check failed: ${String(err)}`);
  }
}
