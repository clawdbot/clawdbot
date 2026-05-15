import path from "node:path";
import { tryReadJsonSync } from "../infra/json-files.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { validatePluginId } from "./install-paths.js";

export const LEGACY_NPM_DECLARATION_FILE = "openclaw.extension.json";

export type LegacyNpmPluginDeclaration = {
  pluginId: string;
  npmSpec: string;
  source: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readLegacyNpmPluginDeclaration(
  pluginDir: string,
): LegacyNpmPluginDeclaration | null {
  const source = path.join(pluginDir, LEGACY_NPM_DECLARATION_FILE);
  const parsed = tryReadJsonSync(source);
  if (!isRecord(parsed) || parsed.type !== "npm") {
    return null;
  }
  const pluginId = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const npmSpec = typeof parsed.npmSpec === "string" ? parsed.npmSpec.trim() : "";
  if (!pluginId || validatePluginId(pluginId) || !parseRegistryNpmSpec(npmSpec)) {
    return null;
  }
  return { pluginId, npmSpec, source };
}
