// Generates postbuild runtime artifacts: plugin metadata, SDK aliases, stable
// runtime aliases, static assets, and compatibility chunks for live upgrades.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mjs";
import { escapeRegExp } from "./lib/regexp.mjs";
import {
  copyStaticExtensionAssets,
  copyStaticExtensionAssetsToRuntimeOverlay,
  listStaticExtensionAssetOutputs,
} from "./lib/static-extension-assets.mjs";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mjs";
import { writeOfficialChannelCatalog } from "./write-official-channel-catalog.mjs";

/** @internal Shared repository-script contract. */
export { listStaticExtensionAssetOutputs };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_RUNTIME_ALIAS_PATTERN = /^(?<base>.+\.(?:runtime|contract))-[A-Za-z0-9_-]+\.js$/u;
const ROOT_STABLE_RUNTIME_ALIAS_PATTERN = /^.+\.(?:runtime|contract)\.js$/u;
const ROOT_RUNTIME_IMPORT_SPECIFIER_PATTERN =
  /(["'])\.\/([^"']+\.(?:runtime|contract)-[A-Za-z0-9_-]+\.js)\1/gu;
const OFFICIAL_CHANNEL_CATALOG_OUTPUT = "dist/channel-catalog.json";
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
  // v2026.5.12-beta.8 gateway shutdown hook chunks.
  ["hook-runner-global-B8rMIo8I.js", "plugins/hook-runner-global.js"],
  // v2026.5.3 beta reply-dispatch lazy chunks.
  ["provider-dispatcher-6EQEtc-t.js", "provider-dispatcher.runtime.js"],
  ["provider-dispatcher-BpL2E92x.js", "provider-dispatcher.runtime.js"],
  ["provider-dispatcher-JG96SkLX.js", "provider-dispatcher.runtime.js"],
  // v2026.5.4 tool/control-plane lazy chunks. These predate the stable
  // nested dist entries, but live gateways may still import them after update.
  ["manager-DzRWrKSA.js", "acp/control-plane/manager.js"],
  ["runtime-CeGN4XUC.js", "web-fetch/runtime.js"],
  // v2026.5.22 and v2026.6.8 text-transform runtimes. The stable alias remains
  // for old chunks, but new chunks keep hashed imports because the alias export
  // set expanded in v2026.6.8 and may already be cached in a live gateway.
  ["text-transforms.runtime-D9-SpAmI.js", "text-transforms.runtime.js"],
  ["text-transforms.runtime-sEqsN4pN.js", "text-transforms.runtime.js"],
];
const ROOT_RUNTIME_STABLE_IMPORT_SKIP_ALIASES = new Set(["text-transforms.runtime.js"]);
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
/** Compatibility chunks kept for live gateways loading old CLI exit modules. */
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

/**
 * Lists generated official channel catalog outputs.
 */
function listOfficialChannelCatalogOutputs() {
  return [OFFICIAL_CHANNEL_CATALOG_OUTPUT];
}

function collectStableRootRuntimeAliasCandidates(params) {
  const distDir = params.distDir;
  const fsImpl = params.fs;
  let entries;
  try {
    entries = fsImpl.readdirSync(distDir, { withFileTypes: true });
  } catch {
    return new Map();
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
  return candidatesByAlias;
}

function resolveStableRootRuntimeAliasCandidate(params) {
  const { aliasFileName, candidates, distDir, fsImpl } = params;
  const candidatesWithSources = candidates.map((candidate) => {
    const filePath = path.join(distDir, candidate);
    let source = "";
    try {
      source = fsImpl.readFileSync(filePath, "utf8");
    } catch {
      // Keep unreadable candidates visible to the ambiguous-candidate logic.
    }
    return { candidate, source };
  });
  const implementationCandidates = candidatesWithSources.filter(
    ({ source }) => !isRuntimeAliasSource(source, aliasFileName),
  );
  const candidateNames = implementationCandidates.map(({ candidate }) => candidate);
  if (candidateNames.length === 1) {
    return candidateNames[0];
  }
  if (aliasFileName === PLUGIN_INSTALL_RUNTIME_ALIAS.aliasFileName) {
    return resolveRootRuntimeCandidateByMarkers({
      distDir,
      fsImpl,
      aliasFileName,
      sourceIncludes: PLUGIN_INSTALL_RUNTIME_ALIAS.sourceIncludes,
    });
  }
  const candidateSet = new Set(candidateNames);
  const wrappers = implementationCandidates
    .map(({ candidate, source }) => ({ candidate, source }))
    .filter(({ candidate, source }) => {
      return candidates.some(
        (target) =>
          target !== candidate &&
          candidateSet.has(target) &&
          source.includes(`"./${target}"`) &&
          !source.includes("\n//#region "),
      );
    });
  return wrappers.length === 1 ? wrappers[0].candidate : null;
}

/**
 * Lists stable aliases for hashed root runtime/contract chunks.
 */
function listStableRootRuntimeAliasOutputs(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  return [...collectStableRootRuntimeAliasCandidates({ distDir, fs: fsImpl })]
    .filter(([aliasFileName, candidates]) =>
      resolveStableRootRuntimeAliasCandidate({
        distDir,
        fsImpl,
        aliasFileName,
        candidates,
      }),
    )
    .map(([aliasFileName]) => `dist/${aliasFileName}`)
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Lists compatibility chunk outputs required for old CLI exit paths.
 */
function listLegacyCliExitCompatOutputs(params = {}) {
  const chunks = params.chunks ?? LEGACY_CLI_EXIT_COMPAT_CHUNKS;
  return chunks
    .map(({ dest }) => dest.replace(/\\/g, "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Lists legacy hashed runtime aliases that may be needed during live upgrades.
 */
function listLegacyRootRuntimeCompatOutputs(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  return [
    ...LEGACY_ROOT_RUNTIME_COMPAT_ALIASES.map(([legacyFileName, aliasFileName]) => ({
      legacyFileName,
      aliasFileName,
    })),
    ...LEGACY_PLUGIN_INSTALL_RUNTIME_COMPAT_ALIASES,
  ]
    .filter((entry) =>
      resolveLegacyRootRuntimeCompatTarget({
        distDir,
        fsImpl,
        legacyFileName: entry.legacyFileName,
        aliasFileName: entry.aliasFileName,
        sourceIncludes: entry.sourceIncludes,
      }),
    )
    .map(({ legacyFileName }) => `dist/${legacyFileName}`)
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Lists all core runtime postbuild outputs expected after a build.
 */
export function listCoreRuntimePostBuildOutputs(params = {}) {
  return [
    ...listOfficialChannelCatalogOutputs(),
    ...listStableRootRuntimeAliasOutputs(params),
    ...listLegacyRootRuntimeCompatOutputs(params),
    ...listLegacyCliExitCompatOutputs(params),
  ].toSorted((left, right) => left.localeCompare(right));
}

const RUNTIME_CHUNK_DEFAULT_EXPORT_PATTERN =
  /(^|\n)\s*export\b\s*(?:default\b|\{[^}]*(?:\bas\s+default\b|\bdefault\b\s*(?=[,}]))[^}]*\})/u;

function formatRuntimeAliasSource(targetFileName, forwardDefault = false) {
  const specifier = JSON.stringify(`./${targetFileName}`);
  const starSource = `export * from ${specifier};\n`;
  return forwardDefault ? `${starSource}export { default } from ${specifier};\n` : starSource;
}

function isRuntimeAliasSource(source, targetFileName) {
  const normalizedSource = source.trim();
  return (
    normalizedSource === formatRuntimeAliasSource(targetFileName).trim() ||
    normalizedSource === formatRuntimeAliasSource(targetFileName, true).trim()
  );
}

/**
 * Builds alias module source for a runtime chunk target. `export * from`
 * never re-exports `default`, so when the target chunk has a default export
 * the alias must forward it explicitly — otherwise lazy `import()` consumers
 * that destructure `default` receive `undefined` (e.g. the post-compaction
 * count reconcile failed this way with "TypeError: reconcile is not a
 * function" on every compaction).
 */
function buildRuntimeAliasSource(params) {
  const { distDir, fsImpl, targetFileName } = params;
  let targetSource;
  try {
    targetSource = fsImpl.readFileSync(path.join(distDir, targetFileName), "utf8");
  } catch {
    return formatRuntimeAliasSource(targetFileName);
  }
  return formatRuntimeAliasSource(
    targetFileName,
    RUNTIME_CHUNK_DEFAULT_EXPORT_PATTERN.test(targetSource),
  );
}

/**
 * Writes stable aliases for current hashed runtime chunks.
 * @internal Directly tested script implementation detail.
 */
export function writeStableRootRuntimeAliases(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  const candidatesByAlias = collectStableRootRuntimeAliasCandidates({ distDir, fs: fsImpl });

  for (const [aliasFileName, candidates] of candidatesByAlias) {
    const aliasPath = path.join(distDir, aliasFileName);
    const candidate = resolveStableRootRuntimeAliasCandidate({
      distDir,
      fsImpl,
      aliasFileName,
      candidates,
    });
    if (!candidate) {
      fsImpl.rmSync?.(aliasPath, { force: true });
      continue;
    }
    writeTextFileIfChanged(
      aliasPath,
      buildRuntimeAliasSource({ distDir, fsImpl, targetFileName: candidate }),
    );
  }
}

/**
 * Rewrites hashed runtime imports to stable aliases so live updates survive swaps.
 * @internal Directly tested script implementation detail.
 */
export function rewriteRootRuntimeImportsToStableAliases(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  let entries;
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
    const candidate = resolveStableRootRuntimeAliasCandidate({
      distDir,
      fsImpl,
      aliasFileName,
      candidates,
    });
    if (candidate) {
      if (ROOT_RUNTIME_STABLE_IMPORT_SKIP_ALIASES.has(aliasFileName)) {
        continue;
      }
      runtimeAliasFiles.set(candidate, aliasFileName);
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
  let entries;
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

/**
 * Writes compatibility aliases for shipped hashed runtime chunk names.
 * @internal Directly tested script implementation detail.
 */
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
    writeTextFileIfChanged(
      legacyPath,
      buildRuntimeAliasSource({ distDir, fsImpl, targetFileName }),
    );
  }
}

/**
 * Writes small compatibility chunks for old CLI exit imports.
 * @internal Directly tested script implementation detail.
 */
export function writeLegacyCliExitCompatChunks(params = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const chunks = params.chunks ?? LEGACY_CLI_EXIT_COMPAT_CHUNKS;
  for (const { dest, contents } of chunks) {
    writeTextFileIfChanged(path.join(rootDir, dest), contents);
  }
}

function shouldCopyStaticExtensionAssets(params) {
  const env = params.env ?? process.env;
  return env.OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS !== "0";
}

/**
 * Runs every runtime postbuild phase after the main dist build.
 */
export function runRuntimePostBuild(params = {}) {
  const timingsSetting = params.timings ?? process.env.OPENCLAW_RUNTIME_POSTBUILD_TIMINGS;
  const timingsEnabled = timingsSetting !== "0" && timingsSetting !== false;
  // Per-phase lines are debug detail; default output is one summary line so a
  // routine rebuild does not print nine near-identical timing rows.
  const perPhaseEnabled = timingsSetting === "verbose" || timingsSetting === true;
  const phaseTimings = [];
  const runPhase = (label, action) => {
    const startedAt = performance.now();
    try {
      return action();
    } finally {
      const durationMs = Math.round(performance.now() - startedAt);
      phaseTimings.push({ label, durationMs });
      if (perPhaseEnabled) {
        console.error(`runtime-postbuild: ${label} completed in ${durationMs}ms`);
      }
    }
  };
  const logSummary = () => {
    if (!timingsEnabled || perPhaseEnabled || phaseTimings.length === 0) {
      return;
    }
    const totalMs = phaseTimings.reduce((sum, phase) => sum + phase.durationMs, 0);
    const slowest = phaseTimings.reduce((max, phase) =>
      phase.durationMs > max.durationMs ? phase : max,
    );
    console.error(
      `runtime-postbuild: ${phaseTimings.length} phases completed in ${totalMs}ms (slowest: ${slowest.label} ${slowest.durationMs}ms)`,
    );
  };
  runPhase("bundled plugin metadata", () => copyBundledPluginMetadata(params));
  runPhase("official channel catalog", () => writeOfficialChannelCatalog(params));
  runPhase("bundled plugin runtime overlay", () => stageBundledPluginRuntime(params));
  runPhase("static extension assets", () => {
    if (!shouldCopyStaticExtensionAssets(params)) {
      return;
    }
    const staticAssetParams = {
      rootDir: ROOT,
      ...params,
    };
    copyStaticExtensionAssets(staticAssetParams);
    copyStaticExtensionAssetsToRuntimeOverlay(staticAssetParams);
  });
  runPhase("stable root runtime imports", () => rewriteRootRuntimeImportsToStableAliases(params));
  runPhase("stable root runtime aliases", () => writeStableRootRuntimeAliases(params));
  runPhase("legacy root runtime compat aliases", () => writeLegacyRootRuntimeCompatAliases(params));
  runPhase("legacy CLI exit compat chunks", () => writeLegacyCliExitCompatChunks(params));
  logSummary();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRuntimePostBuild();
}
