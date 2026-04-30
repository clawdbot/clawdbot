import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mjs";
import { copyPluginSdkRootAlias } from "./copy-plugin-sdk-root-alias.mjs";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";
import { stageBundledPluginRuntimeDeps } from "./stage-bundled-plugin-runtime-deps.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mjs";
import { writeOfficialChannelCatalog } from "./write-official-channel-catalog.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_RUNTIME_ALIAS_PATTERN = /^(?<base>.+\.(?:runtime|contract))-[A-Za-z0-9_-]+\.js$/u;
export const LEGACY_CLI_EXIT_COMPAT_CHUNKS = [
  {
    dest: "dist/memory-state-CcqRgDZU.js",
    contents: "export function hasMemoryRuntime() {\n  return false;\n}\n",
  },
];

/**
 * Copy static (non-transpiled) runtime assets that are referenced by their
 * source-relative path inside bundled extension code.
 *
 * Each entry: { src: repo-root-relative source, dest: dist-relative dest }
 */
export const STATIC_EXTENSION_ASSETS = [
  // acpx MCP proxy — co-deployed alongside the acpx index bundle so that
  // `path.resolve(dirname(import.meta.url), "mcp-proxy.mjs")` resolves correctly
  // at runtime from the built ACPX extension directory.
  {
    src: "extensions/acpx/src/runtime-internals/mcp-proxy.mjs",
    dest: "dist/extensions/acpx/mcp-proxy.mjs",
  },
  {
    src: "extensions/acpx/src/runtime-internals/error-format.mjs",
    dest: "dist/extensions/acpx/error-format.mjs",
  },
  {
    src: "extensions/acpx/src/runtime-internals/mcp-command-line.mjs",
    dest: "dist/extensions/acpx/mcp-command-line.mjs",
  },
  // diffs viewer runtime bundle — co-deployed inside the plugin package so the
  // built bundle can resolve `./assets/viewer-runtime.js` from dist.
  {
    src: "extensions/diffs/assets/viewer-runtime.js",
    dest: "dist/extensions/diffs/assets/viewer-runtime.js",
  },
];

export function listStaticExtensionAssetOutputs(params = {}) {
  const assets = params.assets ?? STATIC_EXTENSION_ASSETS;
  return assets
    .map(({ dest }) => dest.replace(/\\/g, "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

export function copyStaticExtensionAssets(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const assets = params.assets ?? STATIC_EXTENSION_ASSETS;
  const fsImpl = params.fs ?? fs;
  const warn = params.warn ?? console.warn;
  for (const { src, dest } of assets) {
    const srcPath = path.join(rootDir, src);
    const destPath = path.join(rootDir, dest);
    if (fsImpl.existsSync(srcPath)) {
      fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
      fsImpl.copyFileSync(srcPath, destPath);
    } else {
      warn(`[runtime-postbuild] static asset not found, skipping: ${src}`);
    }
  }
}

export function writeStableRootRuntimeAliases(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  let entries = [];
  try {
    entries = fsImpl.readdirSync(distDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(ROOT_RUNTIME_ALIAS_PATTERN);
    if (!match?.groups?.base) {
      continue;
    }
    const aliasPath = path.join(distDir, `${match.groups.base}.js`);
    writeTextFileIfChanged(aliasPath, `export * from "./${entry.name}";\n`);
  }
}

export function writeLegacyCliExitCompatChunks(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const chunks = params.chunks ?? LEGACY_CLI_EXIT_COMPAT_CHUNKS;
  for (const { dest, contents } of chunks) {
    writeTextFileIfChanged(path.join(rootDir, dest), contents);
  }
}

export function runRuntimePostBuild(params = {}) {
  const timingsEnabled = params.timings ?? process.env.OPENCLAW_RUNTIME_POSTBUILD_TIMINGS !== "0";
  const runPhase = (label, action) => {
    const startedAt = performance.now();
    try {
      return action();
    } finally {
      if (timingsEnabled) {
        const durationMs = Math.round(performance.now() - startedAt);
        console.error(`runtime-postbuild: ${label} completed in ${durationMs}ms`);
      }
    }
  };
  runPhase("plugin SDK root alias", () => copyPluginSdkRootAlias(params));
  runPhase("bundled plugin metadata", () => copyBundledPluginMetadata(params));
  runPhase("official channel catalog", () => writeOfficialChannelCatalog(params));
  runPhase("bundled plugin runtime deps", () => stageBundledPluginRuntimeDeps(params));
  runPhase("bundled plugin runtime overlay", () => stageBundledPluginRuntime(params));
  runPhase("stable root runtime aliases", () => writeStableRootRuntimeAliases(params));
  runPhase("legacy CLI exit compat chunks", () => writeLegacyCliExitCompatChunks(params));
  runPhase("static extension assets", () => copyStaticExtensionAssets(params));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRuntimePostBuild();
}
