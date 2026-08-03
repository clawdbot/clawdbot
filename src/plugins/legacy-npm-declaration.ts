/** Reads legacy npm plugin declaration files left by early plugin installs. */
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tryReadJsonSync } from "../infra/json-files.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { validatePluginId } from "./install-paths.js";

/** Legacy declaration filename used by early npm-backed plugin installs. */
const LEGACY_NPM_DECLARATION_FILE = "openclaw.extension.json";

/** Parsed legacy npm declaration stored beside an installed plugin. */
type LegacyNpmPluginDeclaration = {
  pluginId: string;
  npmSpec: string;
  source: string;
};

/** Reads a legacy npm plugin declaration when a plugin directory still has one. */
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
