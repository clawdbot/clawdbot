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
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
const LEGACY_PLUGIN_INSTALL_RUNTIME_MARKERS = [
  "scanPackageInstallSource",
  "scanFileInstallSource",
  "scanInstalledPackageDependencyTree",
  "scanBundleInstallSource",
];
const PLUGIN_INSTALL_RUNTIME_ALIAS = {
  aliasFileName: "install.runtime.js",
  sourceIncludes: LEGACY_PLUGIN_INSTALL_RUNTIME_MARKERS,
};
const LEGACY_PLUGIN_INSTALL_RUNTIME_COMPAT_ALIASES = [
  // Published releases from v2026.3.22 onward. Older updaters could
  // overlay package dist instead of swapping it, leaving old install chunks
  // that still import these hashed plugin install runtime files.
  "install.runtime-D7SL02B2.js",
  "install.runtime-Deq6Beal.js",
  "install.runtime-Eoq8y3HE.js",
  "install.runtime-DDmlaKdG.js",
  "install.runtime-ADTafpVD.js",
  "install.runtime-v8X-j3Tm.js",
  "install.runtime-BLcZ-44g.js",
  "install.runtime-vS4aFJvO.js",
  "install.runtime-Dm_c092A.js",
  "install.runtime-D_7OUvuY.js",
  "install.runtime-BLEE0OIk.js",
  "install.runtime-3LpjZbr8.js",
  "install.runtime-BrsB9OnV.js",
  "install.runtime-BEOb-kNW.js",
  "install.runtime-Cx_xphd1.js",
  "install.runtime-B-MtEMSR.js",
  "install.runtime-C-Y4HAqX.js",
  "install.runtime-j1SedTZh.js",
  "install.runtime-4zsL_8wt.js",
  "install.runtime-BhCKlLSJ.js",
  "install.runtime-tGJ0KhMF.js",
  "install.runtime-DtmATpak.js",
  "install.runtime-BzZ38ePb.js",
  "install.runtime-DwQr7nEE.js",
  "install.runtime-CEIURnUz.js",
  "install.runtime-D3EPlM0r.js",
  "install.runtime-DIlN5H3O.js",
  "install.runtime-DjcOwVH_.js",
  "install.runtime-B13jZink.js",
  "install.runtime-O8MXNrwm.js",
  "install.runtime-Bkf_VMnk.js",
  "install.runtime-QOfEzAcZ.js",
  "install.runtime-BRVACueI.js",
  "install.runtime-DX8jy7tN.js",
  "install.runtime-BdfsTamp.js",
  "install.runtime-B6OA2_P8.js",
  "install.runtime-D9cTH-C0.js",
  "install.runtime-OCJULXQo.js",
  "install.runtime-9ZXBhZSk.js",
  "install.runtime-DlL3C3t_.js",
  "install.runtime-TU-jP-TN.js",
  "install.runtime-a2FlfOSp.js",
  "install.runtime-BwuRABU1.js",
  "install.runtime-B3mZL_R2.js",
  "install.runtime-CWUzypNQ.js",
  "install.runtime-D6FSd9v2.js",
  "install.runtime-DQ-ui3nL.js",
  "install.runtime-CNHwKOIb.js",
  "install.runtime-Dzuj9tSw.js",
  "install.runtime-BuF-YAfQ.js",
  "install.runtime-Xom5hOHq.js",
  "install.runtime-tnhNR9WW.js",
].map((legacyFileName) => ({
  legacyFileName,
  aliasFileName: PLUGIN_INSTALL_RUNTIME_ALIAS.aliasFileName,
  sourceIncludes: LEGACY_PLUGIN_INSTALL_RUNTIME_MARKERS,
}));
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

  const resolveAliasCandidate = (aliasFileName, candidates) => {
    if (candidates.length === 1) {
      return candidates[0];
    }
    if (aliasFileName === PLUGIN_INSTALL_RUNTIME_ALIAS.aliasFileName) {
      return resolveRootRuntimeCandidateByMarkers({
        distDir,
        fsImpl,
        aliasFileName,
        sourceIncludes: PLUGIN_INSTALL_RUNTIME_ALIAS.sourceIncludes,
      });
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
    const candidate = resolveAliasCandidate(aliasFileName, candidates);
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
    if (candidates.length === 1) {
      runtimeAliasFiles.set(candidates[0], aliasFileName);
      continue;
    }
    if (aliasFileName === PLUGIN_INSTALL_RUNTIME_ALIAS.aliasFileName) {
      const candidate = resolveRootRuntimeCandidateByMarkers({
        distDir,
        fsImpl,
        aliasFileName,
        sourceIncludes: PLUGIN_INSTALL_RUNTIME_ALIAS.sourceIncludes,
      });
      if (candidate) {
        runtimeAliasFiles.set(candidate, aliasFileName);
      }
    }
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

function resolveRootRuntimeCandidateByMarkers(params) {
  if (!params.sourceIncludes?.length) {
    return null;
  }
  const match = params.aliasFileName.match(ROOT_STABLE_RUNTIME_ALIAS_PATTERN);
  if (!match) {
    return null;
  }
  const aliasBaseFileName = params.aliasFileName.replace(/\.js$/u, "");
  const hashedPattern = new RegExp(`^${escapeRegExp(aliasBaseFileName)}-[A-Za-z0-9_-]+\\.js$`, "u");
  let entries = [];
  try {
    entries = params.fsImpl.readdirSync(params.distDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !hashedPattern.test(entry.name)) {
      continue;
    }
    const candidatePath = path.join(params.distDir, entry.name);
    let source;
    try {
      source = params.fsImpl.readFileSync(candidatePath, "utf8");
    } catch {
      continue;
    }
    if (params.sourceIncludes.every((marker) => source.includes(marker))) {
      candidates.push(entry.name);
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function resolveLegacyRootRuntimeCompatTarget(params) {
  if (
    params.aliasFileName &&
    params.fsImpl.existsSync(path.join(params.distDir, params.aliasFileName))
  ) {
    return params.aliasFileName;
  }
  const match = params.legacyFileName.match(ROOT_RUNTIME_ALIAS_PATTERN);
  if (!match?.groups?.base) {
    return null;
  }
  return resolveRootRuntimeCandidateByMarkers({
    distDir: params.distDir,
    fsImpl: params.fsImpl,
    aliasFileName: `${match.groups.base}.js`,
    sourceIncludes: params.sourceIncludes,
  });
}

export function writeLegacyRootRuntimeCompatAliases(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  for (const entry of [
    ...LEGACY_ROOT_RUNTIME_COMPAT_ALIASES.map(([legacyFileName, aliasFileName]) => ({
      legacyFileName,
      aliasFileName,
    })),
    ...LEGACY_PLUGIN_INSTALL_RUNTIME_COMPAT_ALIASES,
  ]) {
    const { legacyFileName } = entry;
    const legacyPath = path.join(distDir, legacyFileName);
    if (fsImpl.existsSync(legacyPath)) {
      continue;
    }
    const targetFileName = resolveLegacyRootRuntimeCompatTarget({
      distDir,
      fsImpl,
      legacyFileName,
      aliasFileName: entry.aliasFileName,
      sourceIncludes: entry.sourceIncludes,
    });
    if (!targetFileName) {
      continue;
    }
    writeTextFileIfChanged(legacyPath, `export * from "./${targetFileName}";\n`);
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
