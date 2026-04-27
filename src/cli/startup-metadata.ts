import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STARTUP_METADATA_FILE = "cli-startup-metadata.json";

function resolveStartupMetadataPathCandidates(moduleUrl: string): string[] {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return [
    path.resolve(moduleDir, STARTUP_METADATA_FILE),
    path.resolve(moduleDir, "..", STARTUP_METADATA_FILE),
  ];
}

export function readCliStartupMetadata(moduleUrl: string): Record<string, unknown> | null {
  for (const metadataPath of resolveStartupMetadataPathCandidates(moduleUrl)) {
    try {
      return JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    } catch {
      // Try the next bundled/source layout before falling back to dynamic startup work.
    }
  }
  return null;
}

export const __testing = {
  resolveStartupMetadataPathCandidates,
};
