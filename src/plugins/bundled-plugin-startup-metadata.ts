// Narrow bundled-plugin facts used before the full metadata/runtime registry is available.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tryReadJsonSync } from "../infra/json-files.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

const DOCTOR_CONTRACT_BASENAMES = ["doctor-contract-api", "contract-api"] as const;
const MODULE_EXTENSIONS = ["js", "cjs", "mjs", "ts", "cts", "mts"] as const;

type PluginStartupMetadata = {
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

/** Inspects one manifest-owned plugin root without loading its runtime or doctor contract. */
export function inspectPluginStartupMetadata(params: {
  pluginId: string;
  rootDir: string;
}): PluginStartupMetadata | undefined {
  const manifest = tryReadJsonSync(path.join(params.rootDir, "openclaw.plugin.json"));
  if (!isRecord(manifest) || manifest.id !== params.pluginId) {
    return undefined;
  }
  return { hasDoctorContract: hasDoctorContractArtifact(params.rootDir) };
}

/** Resolves one exact bundled id without scanning or materializing the full plugin catalog. */
export function inspectBundledPluginStartupMetadata(params: {
  pluginId: string;
  env: NodeJS.ProcessEnv;
}): PluginStartupMetadata | undefined {
  const bundledPluginsDir = resolveBundledPluginsDir(params.env);
  if (!bundledPluginsDir) {
    return undefined;
  }
  return inspectPluginStartupMetadata({
    pluginId: params.pluginId,
    rootDir: path.join(bundledPluginsDir, params.pluginId),
  });
}
