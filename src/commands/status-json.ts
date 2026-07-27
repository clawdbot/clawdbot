// Thin `openclaw status --json` wrapper.
// Command wiring lives here; scan/payload behavior lives in the shared JSON command runner.

import type { RuntimeEnv } from "../runtime.js";
import { runStatusJsonCommand } from "./status-json-command.ts";
import { scanStatusJsonFast } from "./status.scan.fast-json.js";

/** Runs status JSON with the standard fast scan and all-mode security audit behavior. */
export async function statusJsonCommand(
  opts: {
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  await runStatusJsonCommand({
    opts,
    runtime,
    scanStatusJsonFast,
    // `--all` is the opt-in path for heavier security audit fields in JSON output.
    includeSecurityAudit: opts.all === true,
    suppressHealthErrors: true,
  });
}
