import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mjs";
import { copyPluginSdkRootAlias } from "./copy-plugin-sdk-root-alias.mjs";
import {
  copyStaticExtensionAssets,
  listStaticExtensionAssetOutputs,
} from "./lib/static-extension-assets.mjs";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mjs";
import { writeOfficialChannelCatalog } from "./write-official-channel-catalog.mjs";

export { copyStaticExtensionAssets, listStaticExtensionAssetOutputs };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_RUNTIME_ALIAS_PATTERN = /^(?<base>.+\.(?:runtime|contract))-[A-Za-z0-9_-]+\.js$/u;
const LEGACY_CLI_EXIT_COMPAT_CHUNKS = [
  {
    dest: "dist/memory-state-CcqRgDZU.js",
    contents: "export function hasMemoryRuntime() {\n  return false;\n}\n",
  },
  {
    dest: "dist/memory-state-DwGdReW4.js",
    contents: "export function hasMemoryRuntime() {\n  return false;\n}\n",
  },
];

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
  runPhase("bundled plugin runtime overlay", () => stageBundledPluginRuntime(params));
  runPhase("stable root runtime aliases", () => writeStableRootRuntimeAliases(params));
  runPhase("legacy CLI exit compat chunks", () => writeLegacyCliExitCompatChunks(params));
  runPhase("static extension assets", () =>
    copyStaticExtensionAssets({
      rootDir: ROOT,
      ...params,
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRuntimePostBuild();
}
