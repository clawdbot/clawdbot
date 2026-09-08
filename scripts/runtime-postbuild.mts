// Generates postbuild runtime artifacts: plugin metadata, SDK aliases, stable
// runtime aliases, static assets, and compatibility chunks for live upgrades.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import { verifyBuiltPluginControlPlaneModules } from "./check-built-plugin-control-plane-modules.mts";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mts";
import { copyHookMetadata, listHookMetadataOutputs } from "./copy-hook-metadata.ts";
import { assertRealOutputRoot } from "./lib/output-root-guard.mjs";
import { escapeRegExp } from "./lib/regexp.mjs";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  copyStaticExtensionAssets,
  copyStaticExtensionAssetsToRuntimeOverlay,
} from "./lib/static-extension-assets.mts";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mts";
import { writeBuildInfo } from "./write-build-info.ts";
import { writeOfficialChannelCatalog } from "./write-official-channel-catalog.mts";

type RuntimePostBuildParams = {
  rootDir?: string;
  repoRoot?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fs?: typeof fs;
  timings?: boolean | "verbose";
  warn?: (message: string) => void;
};
type RuntimeFsParams = Pick<RuntimePostBuildParams, "rootDir" | "fs">;
type LegacyCliExitCompatChunk = { dest: string; contents: string };
type LegacyRuntimeAlias = {
  legacyFileName: string;
  aliasFileName: string;
  sourceIncludes?: readonly string[];
};

const LEGACY_UPDATE_NODE_RUNNER_COMPAT_CHUNK = [
  'import path from "node:path";',
  "export function resolveNodeRunner() {",
  "  const base = path.basename(process.execPath).trim().toLowerCase();",
  '  return base === "node" || base === "node.exe" ? process.execPath : "node";',
  "}",
  "",
].join("\n");

const ROOT = resolveRepoRoot(import.meta.url);
const ROOT_RUNTIME_ALIAS_PATTERN = /^(?<base>.+\.(?:runtime|contract))-[A-Za-z0-9_-]+\.m?js$/u;
const ROOT_STABLE_RUNTIME_ALIAS_PATTERN = /^.+\.(?:runtime|contract)\.js$/u;
const ROOT_RUNTIME_IMPORT_SPECIFIER_PATTERN =
  /(["'])\.\/([^"']+\.(?:runtime|contract)-[A-Za-z0-9_-]+\.m?js)\1/gu;
const OFFICIAL_CHANNEL_CATALOG_OUTPUT = "dist/channel-catalog.json";
const EXPORT_HTML_SOURCE_DIR = "src/auto-reply/reply/export-html";
const EXPORT_HTML_OUTPUT_DIR = "dist/export-html";
const EXPORT_HTML_OUTPUTS = [
  `${EXPORT_HTML_OUTPUT_DIR}/template.css`,
  `${EXPORT_HTML_OUTPUT_DIR}/template.html`,
  `${EXPORT_HTML_OUTPUT_DIR}/template.js`,
  `${EXPORT_HTML_OUTPUT_DIR}/vendor/highlight.min.js`,
  `${EXPORT_HTML_OUTPUT_DIR}/vendor/marked.min.js`,
];
const EXPORT_HTML_VENDOR_ENTRYPOINTS = [
  {
    fileName: "marked.min.js",
    packageEntry: "marked",
    packageName: "marked",
    globalName: "marked",
    licenseFile: "LICENSE",
  },
  {
    fileName: "highlight.min.js",
    packageEntry: "highlight.js/lib/common",
    packageName: "highlight.js",
    globalName: "hljs",
    footer: "hljs = hljs.default || hljs;",
    licenseFile: "LICENSE",
  },
];
const LEGACY_ROOT_RUNTIME_COMPAT_ALIASES: Array<readonly [string, string]> = [
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
/** Compatibility chunks for old updater and CLI exit modules after package replacement. */
const LEGACY_CLI_EXIT_COMPAT_CHUNKS = [
  // v2026.8.2, the exact d413210 build, and v2026.9.1 load these after replacing dist/.
  // Remove only after the source artifacts fall outside the supported upgrade window.
  ...["shared-Y6bNiw2w.js", "shared-DTaQo6Hi.js", "shared-DFJEouXv.js"].map((fileName) => ({
    dest: `dist/${fileName}`,
    contents: LEGACY_UPDATE_NODE_RUNNER_COMPAT_CHUNK,
  })),
  ...["memory-state-CcqRgDZU.js", "memory-state-DwGdReW4.js"].map((fileName) => ({
    dest: `dist/${fileName}`,
    contents: "export function hasMemoryRuntime() {\n  return false;\n}\n",
  })),
];

/**
 * Lists generated official channel catalog outputs.
 */
function listOfficialChannelCatalogOutputs() {
  return [OFFICIAL_CHANNEL_CATALOG_OUTPUT];
}

function collectStableRootRuntimeAliasCandidates(distDir: string, fsImpl: typeof fs) {
  let entries;
  try {
    entries = fsImpl.readdirSync(distDir, { withFileTypes: true });
  } catch {
    return { entries: [], candidatesByAlias: new Map<string, string[]>() };
  }

  const candidatesByAlias = new Map<string, string[]>();
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
  // Importer rewrites retain directory order; only alias candidates are sorted.
  return { entries, candidatesByAlias };
}

function resolveStableRootRuntimeAliasCandidate(
  aliasFileName: string,
  candidates: string[],
  distDir: string,
  fsImpl: typeof fs,
) {
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
    return candidateNames[0] ?? null;
  }
  if (aliasFileName === PLUGIN_INSTALL_RUNTIME_ALIAS.aliasFileName) {
    return resolveRootRuntimeCandidateByMarkers(
      aliasFileName,
      distDir,
      fsImpl,
      PLUGIN_INSTALL_RUNTIME_ALIAS.sourceIncludes,
    );
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
  return wrappers.length === 1 ? (wrappers[0]?.candidate ?? null) : null;
}

/**
 * Lists stable aliases for hashed root runtime/contract chunks.
 */
function listStableRootRuntimeAliasOutputs(params: RuntimeFsParams = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  return [...collectStableRootRuntimeAliasCandidates(distDir, fsImpl).candidatesByAlias]
    .filter(([aliasFileName, candidates]) =>
      resolveStableRootRuntimeAliasCandidate(aliasFileName, candidates, distDir, fsImpl),
    )
    .map(([aliasFileName]) => `dist/${aliasFileName}`)
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Lists compatibility chunk outputs required for old CLI exit paths.
 */
function listLegacyCliExitCompatOutputs(params: { chunks?: LegacyCliExitCompatChunk[] } = {}) {
  const chunks = params.chunks ?? LEGACY_CLI_EXIT_COMPAT_CHUNKS;
  return chunks
    .map(({ dest }) => dest.replace(/\\/g, "/"))
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Lists legacy hashed runtime aliases that may be needed during live upgrades.
 */
function listLegacyRootRuntimeCompatOutputs(params: RuntimeFsParams = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  const aliases: LegacyRuntimeAlias[] = [
    ...LEGACY_ROOT_RUNTIME_COMPAT_ALIASES.map(([legacyFileName, aliasFileName]) => ({
      legacyFileName,
      aliasFileName,
    })),
    ...LEGACY_PLUGIN_INSTALL_RUNTIME_COMPAT_ALIASES,
  ];
  return aliases
    .filter((entry) =>
      resolveLegacyRootRuntimeCompatTarget(
        entry.legacyFileName,
        entry.aliasFileName,
        distDir,
        fsImpl,
        entry.sourceIncludes,
      ),
    )
    .map(({ legacyFileName }) => `dist/${legacyFileName}`)
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Lists all core runtime postbuild outputs expected after a build.
 */
export function listCoreRuntimePostBuildOutputs(
  params: RuntimeFsParams & { chunks?: LegacyCliExitCompatChunk[] } = {},
) {
  return [
    "dist/build-info.json",
    ...listHookMetadataOutputs(params),
    ...listOfficialChannelCatalogOutputs(),
    ...listExportHtmlTemplateOutputs(params),
    ...listStableRootRuntimeAliasOutputs(params),
    ...listLegacyRootRuntimeCompatOutputs(params),
    ...listLegacyCliExitCompatOutputs(params),
  ].toSorted((left, right) => left.localeCompare(right));
}

/** Builds deterministic browser globals from the pinned workspace packages. */
export function generateExportHtmlVendorAssets(
  params: Pick<RuntimePostBuildParams, "rootDir"> = {},
): Readonly<Record<string, string>> {
  const rootDir = path.resolve(params.rootDir ?? ROOT);
  const resolveFromRoot = createRequire(path.join(rootDir, "package.json")).resolve;
  return Object.fromEntries(
    EXPORT_HTML_VENDOR_ENTRYPOINTS.map(
      ({ fileName, packageEntry, packageName, globalName, footer, licenseFile }) => {
        const result = buildSync({
          absWorkingDir: rootDir,
          bundle: true,
          entryPoints: [packageEntry],
          footer: footer ? { js: footer } : undefined,
          format: "iife",
          globalName,
          legalComments: "inline",
          logLevel: "silent",
          minify: true,
          platform: "browser",
          target: "es2018",
          write: false,
        });
        const output = result.outputFiles?.[0];
        if (!output || result.outputFiles?.length !== 1) {
          throw new Error(`Expected one generated export-html asset for ${packageEntry}`);
        }
        const packageRoot = path.dirname(resolveFromRoot(`${packageName}/package.json`));
        const license = fs.readFileSync(path.join(packageRoot, licenseFile), "utf8").trimEnd();
        if (license.includes("*/")) {
          throw new Error(`Cannot embed ${packageName} license in a JavaScript comment`);
        }
        return [fileName, `/*!\n${license}\n*/\n${output.text}`];
      },
    ),
  );
}

function listExportHtmlTemplateOutputs(params: RuntimeFsParams = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const fsImpl = params.fs ?? fs;
  const hasSource = fsImpl.existsSync(path.join(rootDir, EXPORT_HTML_SOURCE_DIR));
  const hasBuiltAssets = fsImpl.existsSync(path.join(rootDir, EXPORT_HTML_OUTPUT_DIR));
  return hasSource || hasBuiltAssets ? [...EXPORT_HTML_OUTPUTS] : [];
}

/** Copies authored templates and generates dependency-owned browser payloads. */
export function copyExportHtmlTemplates(params: RuntimeFsParams = {}) {
  const rootDir = path.resolve(params.rootDir ?? ROOT);
  const fsImpl = params.fs ?? fs;
  const sourceDir = path.join(rootDir, EXPORT_HTML_SOURCE_DIR);
  if (!fsImpl.existsSync(sourceDir)) {
    return;
  }
  const outputDir = path.join(rootDir, EXPORT_HTML_OUTPUT_DIR);
  assertRealOutputRoot(path.join(rootDir, "dist"), { fs: fsImpl });
  fsImpl.rmSync(outputDir, { recursive: true, force: true });
  fsImpl.mkdirSync(outputDir, { recursive: true });
  for (const entry of fsImpl.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith(".test.ts")) {
      continue;
    }
    fsImpl.copyFileSync(path.join(sourceDir, entry.name), path.join(outputDir, entry.name));
  }
  const vendorDir = path.join(outputDir, "vendor");
  fsImpl.mkdirSync(vendorDir, { recursive: true });
  for (const [fileName, contents] of Object.entries(generateExportHtmlVendorAssets({ rootDir }))) {
    fsImpl.writeFileSync(path.join(vendorDir, fileName), contents);
  }
}

const RUNTIME_CHUNK_DEFAULT_EXPORT_PATTERN =
  /(^|\n)\s*export\b\s*(?:default\b|\{[^}]*(?:\bas\s+default\b|\bdefault\b\s*(?=[,}]))[^}]*\})/u;

function formatRuntimeAliasSource(targetFileName: string, forwardDefault = false) {
  const specifier = JSON.stringify(`./${targetFileName}`);
  const starSource = `export * from ${specifier};\n`;
  return forwardDefault ? `${starSource}export { default } from ${specifier};\n` : starSource;
}

function isRuntimeAliasSource(source: string, targetFileName: string) {
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
function buildRuntimeAliasSource(targetFileName: string, distDir: string, fsImpl: typeof fs) {
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
export function writeStableRootRuntimeAliases(params: RuntimeFsParams = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  // Alias rewrites delete files under dist; fail closed on a symlinked root
  // so a stale alias removal cannot land inside the link target.
  assertRealOutputRoot(distDir, { fs: fsImpl });
  const { candidatesByAlias } = collectStableRootRuntimeAliasCandidates(distDir, fsImpl);

  for (const [aliasFileName, candidates] of candidatesByAlias) {
    const aliasPath = path.join(distDir, aliasFileName);
    const candidate = resolveStableRootRuntimeAliasCandidate(
      aliasFileName,
      candidates,
      distDir,
      fsImpl,
    );
    if (!candidate) {
      fsImpl.rmSync?.(aliasPath, { force: true });
      continue;
    }
    writeTextFileIfChanged(aliasPath, buildRuntimeAliasSource(candidate, distDir, fsImpl));
  }
}

/**
 * Rewrites hashed runtime imports to stable aliases so live updates survive swaps.
 * @internal Directly tested script implementation detail.
 */
export function rewriteRootRuntimeImportsToStableAliases(params: RuntimeFsParams = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  const { entries, candidatesByAlias } = collectStableRootRuntimeAliasCandidates(distDir, fsImpl);
  const runtimeAliasFiles = new Map<string, string>();
  for (const [aliasFileName, candidates] of candidatesByAlias) {
    const candidate = resolveStableRootRuntimeAliasCandidate(
      aliasFileName,
      candidates,
      distDir,
      fsImpl,
    );
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
    if (!entry.isFile() || !/\.m?js$/u.test(entry.name)) {
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
      (specifier: string, quote: string, fileName: string) => {
        const aliasFileName = runtimeAliasFiles.get(fileName);
        return aliasFileName ? `${quote}./${aliasFileName}${quote}` : specifier;
      },
    );
    if (rewritten !== source) {
      writeTextFileIfChanged(filePath, rewritten);
    }
  }
}

function resolveRootRuntimeCandidateByMarkers(
  aliasFileName: string,
  distDir: string,
  fsImpl: typeof fs,
  sourceIncludes?: readonly string[],
) {
  if (!sourceIncludes?.length) {
    return null;
  }
  const match = aliasFileName.match(ROOT_STABLE_RUNTIME_ALIAS_PATTERN);
  if (!match) {
    return null;
  }
  const aliasBaseFileName = aliasFileName.replace(/\.js$/u, "");
  const hashedPattern = new RegExp(
    `^${escapeRegExp(aliasBaseFileName)}-[A-Za-z0-9_-]+\\.m?js$`,
    "u",
  );
  let entries;
  try {
    entries = fsImpl.readdirSync(distDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates: string[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !hashedPattern.test(entry.name)) {
      continue;
    }
    const candidatePath = path.join(distDir, entry.name);
    let source;
    try {
      source = fsImpl.readFileSync(candidatePath, "utf8");
    } catch {
      continue;
    }
    if (sourceIncludes.every((marker) => source.includes(marker))) {
      candidates.push(entry.name);
    }
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function resolveLegacyRootRuntimeCompatTarget(
  legacyFileName: string,
  aliasFileName: string,
  distDir: string,
  fsImpl: typeof fs,
  sourceIncludes?: readonly string[],
) {
  if (aliasFileName && fsImpl.existsSync(path.join(distDir, aliasFileName))) {
    return aliasFileName;
  }
  const match = legacyFileName.match(ROOT_RUNTIME_ALIAS_PATTERN);
  if (!match?.groups?.base) {
    return null;
  }
  return resolveRootRuntimeCandidateByMarkers(
    `${match.groups.base}.js`,
    distDir,
    fsImpl,
    sourceIncludes,
  );
}

/**
 * Writes compatibility aliases for shipped hashed runtime chunk names.
 * @internal Directly tested script implementation detail.
 */
export function writeLegacyRootRuntimeCompatAliases(params: RuntimeFsParams = {}) {
  const rootDir = params.rootDir ?? ROOT;
  const distDir = path.join(rootDir, "dist");
  const fsImpl = params.fs ?? fs;
  const aliases: LegacyRuntimeAlias[] = [
    ...LEGACY_ROOT_RUNTIME_COMPAT_ALIASES.map(([legacyFileName, aliasFileName]) => ({
      legacyFileName,
      aliasFileName,
    })),
    ...LEGACY_PLUGIN_INSTALL_RUNTIME_COMPAT_ALIASES,
  ];
  for (const entry of aliases) {
    const { legacyFileName } = entry;
    const legacyPath = path.join(distDir, legacyFileName);
    if (fsImpl.existsSync(legacyPath)) {
      continue;
    }
    const targetFileName = resolveLegacyRootRuntimeCompatTarget(
      legacyFileName,
      entry.aliasFileName,
      distDir,
      fsImpl,
      entry.sourceIncludes,
    );
    if (!targetFileName) {
      continue;
    }
    writeTextFileIfChanged(legacyPath, buildRuntimeAliasSource(targetFileName, distDir, fsImpl));
  }
}

/**
 * Writes small compatibility chunks for old CLI exit imports.
 * @internal Directly tested script implementation detail.
 */
export function writeLegacyCliExitCompatChunks(
  params: { rootDir?: string; chunks?: LegacyCliExitCompatChunk[] } = {},
) {
  const rootDir = params.rootDir ?? ROOT;
  const chunks = params.chunks ?? LEGACY_CLI_EXIT_COMPAT_CHUNKS;
  for (const { dest, contents } of chunks) {
    writeTextFileIfChanged(path.join(rootDir, dest), contents);
  }
}

function shouldCopyStaticExtensionAssets(params: RuntimePostBuildParams) {
  const env = params.env ?? process.env;
  return env.OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS !== "0";
}

/**
 * Runs every runtime postbuild phase after the main dist build.
 */
export function runRuntimePostBuild(params: RuntimePostBuildParams = {}) {
  const rootDir = path.resolve(params.rootDir ?? params.cwd ?? params.repoRoot ?? ROOT);
  const fsImpl = params.fs ?? fs;
  const phaseParams = { ...params, cwd: rootDir, repoRoot: rootDir, rootDir };
  // Postbuild phases share both roots. Validate the whole mutation set before
  // any phase runs so a later unsafe root cannot leave earlier output changed.
  assertRealOutputRoot(path.join(rootDir, "dist"), { fs: fsImpl });
  assertRealOutputRoot(path.join(rootDir, "dist-runtime"), { fs: fsImpl });
  const timingsSetting = params.timings ?? process.env.OPENCLAW_RUNTIME_POSTBUILD_TIMINGS;
  const timingsEnabled = timingsSetting !== "0" && timingsSetting !== false;
  // Per-phase lines are debug detail; default output is one summary line so a
  // routine rebuild does not print nine near-identical timing rows.
  const perPhaseEnabled = timingsSetting === "verbose" || timingsSetting === true;
  const phaseTimings: Array<{ label: string; durationMs: number }> = [];
  const runPhase = <T,>(label: string, action: () => T): T => {
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
  runPhase("bundled plugin metadata", () => copyBundledPluginMetadata(phaseParams));
  runPhase("bundled hook metadata", () => copyHookMetadata(phaseParams));
  runPhase("official channel catalog", () => writeOfficialChannelCatalog(phaseParams));
  runPhase("export HTML assets", () => copyExportHtmlTemplates(phaseParams));
  runPhase("bundled plugin runtime overlay", () => stageBundledPluginRuntime(phaseParams));
  runPhase("static extension assets", () => {
    if (!shouldCopyStaticExtensionAssets(phaseParams)) {
      return;
    }
    copyStaticExtensionAssets(phaseParams);
    copyStaticExtensionAssetsToRuntimeOverlay(phaseParams);
  });
  runPhase("stable root runtime imports", () =>
    rewriteRootRuntimeImportsToStableAliases(phaseParams),
  );
  runPhase("stable root runtime aliases", () => writeStableRootRuntimeAliases(phaseParams));
  runPhase("legacy root runtime compat aliases", () =>
    writeLegacyRootRuntimeCompatAliases(phaseParams),
  );
  runPhase("legacy CLI exit compat chunks", () => writeLegacyCliExitCompatChunks(phaseParams));
  runPhase("built plugin control-plane loads", () =>
    verifyBuiltPluginControlPlaneModules(phaseParams),
  );
  // Source runners launch directly after postbuild, without the full UI build's
  // final metadata step. Publish identity only after the runtime is complete.
  runPhase("build provenance", () => writeBuildInfo({ rootDir, env: params.env }));
  logSummary();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRuntimePostBuild();
}
