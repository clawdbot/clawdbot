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
const ROOT_STABLE_RUNTIME_ALIAS_PATTERN = /^.+\.(?:runtime|contract)\.js$/u;
const ROOT_RUNTIME_IMPORT_SPECIFIER_PATTERN =
  /(["'])\.\/([^"']+\.(?:runtime|contract)-[A-Za-z0-9_-]+\.js)\1/gu;
const LEGACY_ROOT_RUNTIME_COMPAT_ALIASES = [
  // v2026.4.29 dispatch lazy chunks. Package updates used to replace the
  // dist tree before the live gateway had restarted, so an already-loaded old
  // dispatch chunk could still resolve these names after the swap.
  ["abort.runtime-DX6vo4yJ.js", "abort.runtime.js"],
  ["get-reply-from-config.runtime-uABrvCZ-.js", "get-reply-from-config.runtime.js"],
  ["reply-media-paths.runtime-C5UnVaLF.js", "reply-media-paths.runtime.js"],
  ["route-reply.runtime-D4PGzijU.js", "route-reply.runtime.js"],
  ["runtime-plugins.runtime-fLHuT7Vs.js", "runtime-plugins.runtime.js"],
  ["tts.runtime-66taD50M.js", "tts.runtime.js"],
  // v2026.5.2-beta.1 dispatch lazy chunks.
  ["abort.runtime-CKviLU0L.js", "abort.runtime.js"],
  ["get-reply-from-config.runtime-BzFAggVK.js", "get-reply-from-config.runtime.js"],
  ["reply-media-paths.runtime-ZpULeITb.js", "reply-media-paths.runtime.js"],
  ["route-reply.runtime-uzaOjbd1.js", "route-reply.runtime.js"],
  ["runtime-plugins.runtime-CNAfmQRG.js", "runtime-plugins.runtime.js"],
  ["tts.runtime-D-THXDsp.js", "tts.runtime.js"],
  // v2026.5.2 -> v2026.5.3-beta.3 gateway shutdown chunks. The running
  // gateway may resolve these only after an npm package tree replacement.
  ["server-close-DsVPJDIx.js", "server-close.runtime.js"],
  ["server-close-DvAvfgr8.js", "server-close.runtime.js"],
  // v2026.5.3 beta reply-dispatch lazy chunks.
  ["provider-dispatcher-6EQEtc-t.js", "provider-dispatcher.runtime.js"],
  ["provider-dispatcher-BpL2E92x.js", "provider-dispatcher.runtime.js"],
  ["provider-dispatcher-JG96SkLX.js", "provider-dispatcher.runtime.js"],
];
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

  const candidatesByAlias = new Map();
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(ROOT_RUNTIME_ALIAS_PATTERN);
    if (!match?.groups?.base) {
      continue;
    }
    const aliasFileName = `${match.groups.base}.js`;
    const candidates = candidatesByAlias.get(aliasFileName) ?? [];
    candidates.push(entry.name);
    candidatesByAlias.set(aliasFileName, candidates);
  }

  const resolveAliasCandidate = (candidates) => {
    if (candidates.length === 1) {
      return candidates[0];
    }
    const candidateSet = new Set(candidates);
    const wrappers = candidates.filter((candidate) => {
      const filePath = path.join(distDir, candidate);
      let source;
      try {
        source = fsImpl.readFileSync(filePath, "utf8");
      } catch {
        return false;
      }
      return candidates.some(
        (target) =>
          target !== candidate &&
          candidateSet.has(target) &&
          source.includes(`"./${target}"`) &&
          !source.includes("\n//#region "),
      );
    });
    return wrappers.length === 1 ? wrappers[0] : null;
  };

  for (const [aliasFileName, candidates] of candidatesByAlias) {
    const aliasPath = path.join(distDir, aliasFileName);
    const candidate = resolveAliasCandidate(candidates);
    if (!candidate) {
      fsImpl.rmSync?.(aliasPath, { force: true });
      continue;
    }
    writeTextFileIfChanged(aliasPath, `export * from "./${candidate}";\n`);
  }
}

export function rewriteRootRuntimeImportsToStableAliases(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  let entries = [];
  try {
    entries = fsImpl.readdirSync(distDir, { withFileTypes: true });
  } catch {
    return;
  }

  const candidatesByAlias = new Map();
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) {
      continue;
    }
    const match = entry.name.match(ROOT_RUNTIME_ALIAS_PATTERN);
    if (match?.groups?.base) {
      const aliasFileName = `${match.groups.base}.js`;
      const candidates = candidatesByAlias.get(aliasFileName) ?? [];
      candidates.push(entry.name);
      candidatesByAlias.set(aliasFileName, candidates);
    }
  }
  const runtimeAliasFiles = new Map();
  for (const [aliasFileName, candidates] of candidatesByAlias) {
    if (candidates.length !== 1) {
      continue;
    }
    runtimeAliasFiles.set(candidates[0], aliasFileName);
  }
  if (runtimeAliasFiles.size === 0) {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }
    if (ROOT_STABLE_RUNTIME_ALIAS_PATTERN.test(entry.name)) {
      continue;
    }
    const filePath = path.join(distDir, entry.name);
    let source;
    try {
      source = fsImpl.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const rewritten = source.replace(
      ROOT_RUNTIME_IMPORT_SPECIFIER_PATTERN,
      (specifier, quote, fileName) => {
        const aliasFileName = runtimeAliasFiles.get(fileName);
        return aliasFileName ? `${quote}./${aliasFileName}${quote}` : specifier;
      },
    );
    if (rewritten !== source) {
      writeTextFileIfChanged(filePath, rewritten);
    }
  }
}

export function writeLegacyRootRuntimeCompatAliases(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  for (const [legacyFileName, aliasFileName] of LEGACY_ROOT_RUNTIME_COMPAT_ALIASES) {
    const legacyPath = path.join(distDir, legacyFileName);
    if (fsImpl.existsSync(legacyPath)) {
      continue;
    }
    if (!fsImpl.existsSync(path.join(distDir, aliasFileName))) {
      continue;
    }
    writeTextFileIfChanged(legacyPath, `export * from "./${aliasFileName}";\n`);
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
  runPhase("stable root runtime imports", () => rewriteRootRuntimeImportsToStableAliases(params));
  runPhase("stable root runtime aliases", () => writeStableRootRuntimeAliases(params));
  runPhase("legacy root runtime compat aliases", () => writeLegacyRootRuntimeCompatAliases(params));
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
