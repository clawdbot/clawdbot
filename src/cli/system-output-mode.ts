import { getMachineOutputCommandPath } from "./machine-output-argv.js";

const DEFAULT_JSON_PATHS = new Set([
  "heartbeat disable",
  "heartbeat enable",
  "heartbeat last",
  "presence",
]);

/** System query/control commands emit JSON even when `--json` is omitted. */
export function isSystemMachineOutput(argv: readonly string[]): boolean {
  return DEFAULT_JSON_PATHS.has(getMachineOutputCommandPath(argv, 3).slice(1).join(" "));
}
