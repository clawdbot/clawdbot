// Voice Call helper module supports utils behavior.
import os from "node:os";
import path from "node:path";

// Small path helpers shared by voice-call setup and runtime flows.

/** Resolve user input paths, including "~" against the current OS home. */
export function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}
