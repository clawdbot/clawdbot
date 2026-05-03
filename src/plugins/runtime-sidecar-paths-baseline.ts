import fs from "node:fs";
import path from "node:path";
import { listBundledPluginMetadata } from "./bundled-plugin-metadata.js";

const NON_PACKAGED_RUNTIME_SIDECAR_PLUGIN_DIRS = new Set(["qa-channel", "qa-lab", "qa-matrix"]);

function buildBundledDistArtifactPath(dirName: string, artifact: string): string {
  return ["dist", "extensions", dirName, artifact].join("/");
}

function collectRootPackageExcludedRuntimeSidecarPluginDirs(rootDir: string): Set<string> {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return new Set();
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    files?: unknown;
  };
  if (!Array.isArray(packageJson.files)) {
    return new Set();
  }
  const excluded = new Set<string>();
  for (const entry of packageJson.files) {
    if (typeof entry !== "string") {
      continue;
    }
    // The root package intentionally excludes externalized official plugin
    // runtime trees. Do not put their runtime sidecars in the root package
    // baseline: packaged installs must load those files from the plugin's own
    // npm package-local dist directory instead.
    const match = /^!dist\/extensions\/([^/]+)\/\*\*$/u.exec(entry);
    if (match?.[1]) {
      excluded.add(match[1]);
    }
  }
  return excluded;
}

export function collectBundledRuntimeSidecarPaths(params?: {
  rootDir?: string;
}): readonly string[] {
  const rootDir = params?.rootDir ?? process.cwd();
  const excludedRuntimeSidecarPluginDirs = new Set([
    ...NON_PACKAGED_RUNTIME_SIDECAR_PLUGIN_DIRS,
    ...collectRootPackageExcludedRuntimeSidecarPluginDirs(rootDir),
  ]);
  return listBundledPluginMetadata({
    rootDir,
    includeChannelConfigs: false,
  })
    .filter((entry) => !excludedRuntimeSidecarPluginDirs.has(entry.dirName))
    .flatMap((entry) =>
      (entry.runtimeSidecarArtifacts ?? []).map((artifact) =>
        buildBundledDistArtifactPath(entry.dirName, artifact),
      ),
    )
    .toSorted((left, right) => left.localeCompare(right));
}

export async function writeBundledRuntimeSidecarPathBaseline(params: {
  repoRoot: string;
  check: boolean;
}): Promise<{ changed: boolean; jsonPath: string }> {
  const jsonPath = path.join(
    params.repoRoot,
    "scripts",
    "lib",
    "bundled-runtime-sidecar-paths.json",
  );
  const expectedJson = `${JSON.stringify(collectBundledRuntimeSidecarPaths(), null, 2)}\n`;
  const currentJson = fs.existsSync(jsonPath) ? fs.readFileSync(jsonPath, "utf8") : "";
  const changed = currentJson !== expectedJson;

  if (!params.check && changed) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, expectedJson, "utf8");
  }

  return { changed, jsonPath };
}
