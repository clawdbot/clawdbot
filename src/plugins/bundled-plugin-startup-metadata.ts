// Narrow bundled-plugin facts used before the full metadata/runtime registry is available.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tryReadJsonSync } from "../infra/json-files.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

const DOCTOR_CONTRACT_BASENAMES = ["doctor-contract-api", "contract-api"] as const;
const MODULE_EXTENSIONS = ["js", "cjs", "mjs", "ts", "cts", "mts"] as const;

type BundledPluginStartupMetadata = {
  hasDoctorContract: boolean;
};

function hasDoctorContractArtifact(pluginRoot: string): boolean {
  return [pluginRoot, path.join(pluginRoot, "dist")].some((root) =>
    DOCTOR_CONTRACT_BASENAMES.some((basename) =>
      MODULE_EXTENSIONS.some((extension) =>
        fs.existsSync(path.join(root, `${basename}.${extension}`)),
      ),
    ),
  );
}

/** Resolves one exact bundled id without scanning or materializing the full plugin catalog. */
export function inspectBundledPluginStartupMetadata(params: {
  pluginId: string;
  env: NodeJS.ProcessEnv;
}): BundledPluginStartupMetadata | undefined {
  const bundledPluginsDir = resolveBundledPluginsDir(params.env);
  if (!bundledPluginsDir) {
    return undefined;
  }
  const pluginRoot = path.join(bundledPluginsDir, params.pluginId);
  const manifest = tryReadJsonSync(path.join(pluginRoot, "openclaw.plugin.json"));
  if (!isRecord(manifest) || manifest.id !== params.pluginId) {
    return undefined;
  }
  return { hasDoctorContract: hasDoctorContractArtifact(pluginRoot) };
}
