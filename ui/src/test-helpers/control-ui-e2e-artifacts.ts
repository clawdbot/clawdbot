import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve as a Node path so Vite asset-URL rewriting cannot change the evidence root.
const defaultArtifactRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.artifacts/control-ui-e2e",
);

/** Allocate retained proof only when its caller actually captures a scenario. */
export function createControlUiE2eArtifactDir(scope: string, parentDir?: string): string {
  const parent = path.resolve(
    parentDir ?? (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim() || defaultArtifactRoot),
  );
  mkdirSync(parent, { recursive: true });
  // Exclusive directory ownership protects fixed capture names across retries and processes.
  const directory = mkdtempSync(path.join(parent, `${scope}-`));
  console.info(`[control-ui-e2e] retained proof: ${directory}`);
  return directory;
}
