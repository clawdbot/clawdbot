// Builds the generated official channel catalog from publishable channel plugins.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import officialExternalChannelSeed from "./lib/official-external-channel-seed.json" with { type: "json" };
import { isRecord, trimString } from "./lib/record-shared.mjs";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";

/** Generated official channel catalog committed for source and packaged runtime consumers. */
export const OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH =
  "scripts/lib/official-external-channel-catalog.json";

/**
 * Generated official channel catalog path in dist.
 * @internal Directly tested script implementation detail.
 */
export const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = "dist/channel-catalog.json";

function toCatalogInstall(value, packageName) {
  const install = isRecord(value) ? value : {};
  const clawhubSpec = trimString(install.clawhubSpec);
  const npmSpec = trimString(install.npmSpec) || packageName;
  if (!clawhubSpec && !npmSpec) {
    return null;
  }
  const defaultChoice = trimString(install.defaultChoice);
  const minHostVersion = trimString(install.minHostVersion);
  const expectedIntegrity = trimString(install.expectedIntegrity);
  return {
    ...(clawhubSpec ? { clawhubSpec } : {}),
    ...(npmSpec ? { npmSpec } : {}),
    ...(defaultChoice === "clawhub" || defaultChoice === "npm" || defaultChoice === "local"
      ? { defaultChoice }
      : {}),
    ...(minHostVersion ? { minHostVersion } : {}),
    ...(expectedIntegrity ? { expectedIntegrity } : {}),
    ...(install.allowInvalidConfigRecovery === true ? { allowInvalidConfigRecovery: true } : {}),
  };
}

function toCatalogManifestFields(value) {
  const manifest = isRecord(value) ? value : {};
  const catalog = isRecord(manifest.catalog) ? manifest.catalog : null;
  const contracts = isRecord(manifest.contracts) ? manifest.contracts : null;
  const channelConfigs = isRecord(manifest.channelConfigs) ? manifest.channelConfigs : null;
  const providerEndpoints = Array.isArray(manifest.providerEndpoints)
    ? manifest.providerEndpoints
    : null;
  return {
    ...(catalog ? { catalog } : {}),
    ...(contracts ? { contracts } : {}),
    ...(channelConfigs ? { channelConfigs } : {}),
    ...(providerEndpoints ? { providerEndpoints } : {}),
  };
}

function buildCatalogEntry(packageJson, pluginManifest) {
  if (!isRecord(packageJson)) {
    return null;
  }
  const packageName = trimString(packageJson.name);
  const manifest = isRecord(packageJson.openclaw) ? packageJson.openclaw : null;
  const release = manifest && isRecord(manifest.release) ? manifest.release : null;
  const channel = manifest && isRecord(manifest.channel) ? manifest.channel : null;
  if (!packageName || !channel || release?.publishToNpm !== true) {
    return null;
  }
  const install = toCatalogInstall(manifest.install, packageName);
  if (!install) {
    return null;
  }
  const version = trimString(packageJson.version);
  const description = trimString(packageJson.description);
  return {
    name: packageName,
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
    source: "official",
    kind: "channel",
    openclaw: {
      ...toCatalogManifestFields(pluginManifest),
      channel,
      install,
    },
  };
}

function getCatalogChannelId(entry) {
  return trimString(entry?.openclaw?.channel?.id) || trimString(entry?.name);
}

function getCatalogChannelKey(entry) {
  return getCatalogChannelId(entry).toLowerCase();
}

function setUniqueCatalogEntry(entriesByChannelId, entry, owner) {
  const channelId = getCatalogChannelId(entry);
  const channelKey = getCatalogChannelKey(entry);
  if (!channelKey) {
    throw new Error(`official channel catalog entry from ${owner} is missing a channel id`);
  }
  const existing = entriesByChannelId.get(channelKey);
  if (existing) {
    throw new Error(
      `duplicate official channel id "${channelId}" from ${existing.owner} and ${owner}`,
    );
  }
  entriesByChannelId.set(channelKey, { entry, owner });
}

/**
 * Collects publishable channel catalog entries from bundled and external channels.
 * @internal Directly tested script implementation detail.
 */
export function buildOfficialChannelCatalog(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const extensionsRoot = path.join(repoRoot, "extensions");
  const seedEntriesByChannelId = new Map();
  for (const entry of Array.isArray(officialExternalChannelSeed.entries)
    ? officialExternalChannelSeed.entries
    : []) {
    setUniqueCatalogEntry(
      seedEntriesByChannelId,
      entry,
      `scripts/lib/official-external-channel-seed.json package "${trimString(entry?.name)}"`,
    );
  }

  const repositoryEntriesByChannelId = new Map();
  if (fs.existsSync(extensionsRoot)) {
    const extensionDirectories = fs
      .readdirSync(extensionsRoot, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .toSorted((left, right) => left.name.localeCompare(right.name));
    for (const dirent of extensionDirectories) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const packageJsonPath = path.join(extensionsRoot, dirent.name, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }
      let packageJson;
      let pluginManifest;
      try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        const pluginManifestPath = path.join(extensionsRoot, dirent.name, "openclaw.plugin.json");
        pluginManifest = fs.existsSync(pluginManifestPath)
          ? JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"))
          : undefined;
      } catch {
        // Ignore invalid package metadata and keep generating the rest of the catalog.
        continue;
      }
      const entry = buildCatalogEntry(packageJson, pluginManifest);
      if (entry) {
        setUniqueCatalogEntry(
          repositoryEntriesByChannelId,
          entry,
          `extensions/${dirent.name}/package.json`,
        );
      }
    }
  }

  // Repository packages deliberately replace same-id external seeds when a
  // channel moves in tree. Duplicates within either ownership class are errors.
  const entriesByChannelId = new Map(seedEntriesByChannelId);
  for (const [channelId, entry] of repositoryEntriesByChannelId) {
    entriesByChannelId.set(channelId, entry);
  }
  const entries = [...entriesByChannelId.values()].map(({ entry }) => entry);
  entries.sort((left, right) => {
    const leftId = trimString(left.openclaw?.channel?.id) || left.name;
    const rightId = trimString(right.openclaw?.channel?.id) || right.name;
    return leftId.localeCompare(rightId);
  });

  return { entries };
}

export function renderOfficialChannelCatalog(params = {}) {
  return `${JSON.stringify(buildOfficialChannelCatalog(params), null, 2)}\n`;
}

export function writeOfficialChannelCatalog(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH);
  return writeTextFileIfChanged(outputPath, renderOfficialChannelCatalog({ repoRoot }));
}

export function writeOfficialChannelCatalogSource(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH);
  return writeTextFileIfChanged(outputPath, renderOfficialChannelCatalog({ repoRoot }));
}

export function checkOfficialChannelCatalogSource(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH);
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  return current === renderOfficialChannelCatalog({ repoRoot });
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write === check) {
    console.error("usage: node scripts/write-official-channel-catalog.mjs --write|--check");
    process.exitCode = 2;
    return;
  }
  if (write) {
    writeOfficialChannelCatalogSource();
    return;
  }
  if (!checkOfficialChannelCatalogSource()) {
    console.error(
      `${OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH} is stale. Run \`pnpm channels:catalog:gen\`.`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
