/** Resolves the exact root and entry selected by the plugin runtime loader. */
import fs from "node:fs";
import path from "node:path";
import { resolveRealpathOrAbsolute } from "../infra/boundary-path.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { resolvePreferredBuiltRuntimeArtifact } from "./plugin-runtime-artifact-selection.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry, requireActivePluginRegistry } from "./runtime.js";

type PluginRuntimeArtifactEntryKind = "runtime" | "setup";

export function clearPluginRuntimeArtifactResolutionMemo(): void {
  getActivePluginRegistry()?.pluginRuntimeArtifacts.clear();
}

/** Canonical packaged runtime replaces staging-only dist-runtime artifacts. */
export function resolveCanonicalDistRuntimeSource(source: string): string {
  const marker = `${path.sep}dist-runtime${path.sep}extensions${path.sep}`;
  const index = source.indexOf(marker);
  if (index === -1) {
    return source;
  }
  const candidate = `${source.slice(0, index)}${path.sep}dist${path.sep}extensions${path.sep}${source.slice(index + marker.length)}`;
  return fs.existsSync(candidate) ? candidate : source;
}

/** Applies both loader selection phases in their runtime order. */
export function resolvePluginRuntimeArtifact(params: {
  pluginId: string;
  entryKind: PluginRuntimeArtifactEntryKind;
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  preferBuiltPluginArtifacts: boolean;
  packageManifest?: OpenClawPackageManifest;
  registry?: PluginRegistry;
}): { source: string; rootDir: string } {
  const rootDir = resolveCanonicalDistRuntimeSource(resolveRealpathOrAbsolute(params.rootDir));
  const source = resolveCanonicalDistRuntimeSource(resolveRealpathOrAbsolute(params.source));
  const memoKey = JSON.stringify([params.pluginId, rootDir, params.entryKind]);
  const targetRegistry = params.registry ?? requireActivePluginRegistry();
  const cached = targetRegistry.pluginRuntimeArtifacts.get(memoKey);
  if (cached) {
    targetRegistry.pluginRuntimeArtifacts.set(memoKey, cached);
    return { ...cached };
  }

  const preferred = resolvePreferredBuiltRuntimeArtifact({ ...params, source, rootDir });
  const resolved = {
    source: resolveCanonicalDistRuntimeSource(preferred.source),
    rootDir: resolveCanonicalDistRuntimeSource(preferred.rootDir),
  };
  targetRegistry.pluginRuntimeArtifacts.set(memoKey, resolved);
  return { ...resolved };
}
