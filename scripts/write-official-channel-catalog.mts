// Builds the generated official channel catalog from publishable channel plugins.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import officialExternalChannelSeed from "./lib/official-external-channel-seed.json" with { type: "json" };
import { collectExcludedPackagedExtensionDirs } from "./lib/packaged-extension-dirs.mts";
import { isRecord, trimString } from "./lib/record-shared.mjs";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";

type CatalogParams = { repoRoot?: string; cwd?: string };
type CatalogInstall = Partial<
  Record<"clawhubSpec" | "npmSpec" | "localPath" | "minHostVersion" | "expectedIntegrity", string>
> & {
  defaultChoice?: "clawhub" | "npm" | "local";
  allowInvalidConfigRecovery?: boolean;
};
type CatalogEntry = Partial<Record<"version" | "description" | "source" | "kind", string>> & {
  name: string;
  openclaw: {
    plugin?: Record<string, unknown>;
    catalog?: Record<string, unknown>;
    contracts?: Record<string, string[] | undefined>;
    channel: Record<string, unknown>;
    channelHostConfig?: Record<string, unknown>;
    channelConfigs?: Record<string, { schema?: unknown; label?: string }>;
    providerEndpoints?: Array<Record<string, unknown>>;
    install: CatalogInstall;
  };
};
type CatalogOwnerEntry = { entry: CatalogEntry; owner: string };
type RepositoryPackageJson = { dirName: string; packageJson: unknown; pluginManifest?: unknown };
type ChannelDocsSource = "official" | "external" | "bundled" | "built-in";
type ChannelDocsEntry = { id: string; docsPath: string; source: ChannelDocsSource };
type CompleteChannelDocsEntry = ChannelDocsEntry & { label: string; summary: string };

/** Generated official channel catalog committed for source and packaged runtime consumers. */
export const OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH =
  "scripts/lib/official-external-channel-catalog.json";
export const OFFICIAL_CHANNEL_DOCS_INDEX_RELATIVE_PATH = "docs/channels/index.md";
const OFFICIAL_CHANNEL_DOCS_NAV_RELATIVE_PATH = "docs/docs.json";

/**
 * Generated official channel catalog path in dist.
 * @internal Directly tested script implementation detail.
 */
export const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = "dist/channel-catalog.json";

const OFFICIAL_CHANNEL_DOCS_START_MARKER = "<!-- BEGIN GENERATED: official channel catalog -->";
const OFFICIAL_CHANNEL_DOCS_END_MARKER = "<!-- END GENERATED: official channel catalog -->";
const WEBCHAT_DOCS_ENTRY = {
  id: "webchat",
  docsPath: "/web/webchat",
  source: "built-in",
} satisfies ChannelDocsEntry;

function readRepositoryPackageJsons(repoRoot: string) {
  const extensionsRoot = path.join(repoRoot, "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return [];
  }

  const packageJsons: RepositoryPackageJson[] = [];
  const extensionDirectories = fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .toSorted((left, right) => left.name.localeCompare(right.name));
  for (const dirent of extensionDirectories) {
    const packageJsonPath = path.join(extensionsRoot, dirent.name, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }
    try {
      const pluginManifestPath = path.join(extensionsRoot, dirent.name, "openclaw.plugin.json");
      packageJsons.push({
        dirName: dirent.name,
        packageJson: JSON.parse(fs.readFileSync(packageJsonPath, "utf8")),
        pluginManifest: fs.existsSync(pluginManifestPath)
          ? JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"))
          : undefined,
      });
    } catch {
      // Invalid package metadata must not prevent unrelated channels from being generated.
    }
  }
  return packageJsons;
}

function readExcludedPackagedExtensionDirs(repoRoot: string) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return new Set();
  }
  const rootPackageJson: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const files = isRecord(rootPackageJson) ? rootPackageJson.files : undefined;
  return collectExcludedPackagedExtensionDirs({ files: Array.isArray(files) ? files : undefined });
}

function toCatalogInstall(value: unknown, packageName: string): CatalogInstall | null {
  const install = isRecord(value) ? value : {};
  const clawhubSpec = trimString(install.clawhubSpec);
  const npmSpec = trimString(install.npmSpec) || packageName;
  if (!clawhubSpec && !npmSpec) {
    return null;
  }
  const rawDefaultChoice = trimString(install.defaultChoice);
  const defaultChoice =
    rawDefaultChoice === "clawhub" || rawDefaultChoice === "npm" || rawDefaultChoice === "local"
      ? rawDefaultChoice
      : undefined;
  const minHostVersion = trimString(install.minHostVersion);
  const expectedIntegrity = trimString(install.expectedIntegrity);
  return {
    ...(clawhubSpec ? { clawhubSpec } : {}),
    ...(npmSpec ? { npmSpec } : {}),
    ...(defaultChoice ? { defaultChoice } : {}),
    ...(minHostVersion ? { minHostVersion } : {}),
    ...(expectedIntegrity ? { expectedIntegrity } : {}),
    ...(install.allowInvalidConfigRecovery === true ? { allowInvalidConfigRecovery: true } : {}),
  };
}

function toCatalogContracts(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const contracts: Record<string, string[] | undefined> = {};
  for (const [name, members] of Object.entries(value)) {
    if (
      members === undefined ||
      (Array.isArray(members) && members.every((item) => typeof item === "string"))
    ) {
      contracts[name] = members;
    }
  }
  return contracts;
}

function toCatalogChannelConfigs(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const channelConfigs: Record<string, { schema?: unknown }> = {};
  for (const [channelId, config] of Object.entries(value)) {
    if (isRecord(config)) {
      channelConfigs[channelId] = config;
    }
  }
  return channelConfigs;
}

function toCatalogProviderEndpoints(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : null;
}

function toCatalogManifestFields(value: unknown) {
  const manifest = isRecord(value) ? value : {};
  const catalog = isRecord(manifest.catalog) ? manifest.catalog : null;
  const contracts = toCatalogContracts(manifest.contracts);
  const channelConfigs = toCatalogChannelConfigs(manifest.channelConfigs);
  const providerEndpoints = toCatalogProviderEndpoints(manifest.providerEndpoints);
  return {
    ...(catalog ? { catalog } : {}),
    ...(contracts ? { contracts } : {}),
    ...(channelConfigs ? { channelConfigs } : {}),
    ...(providerEndpoints ? { providerEndpoints } : {}),
  };
}

function buildCatalogEntry(packageJson: unknown, pluginManifest: unknown): CatalogEntry | null {
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
  const install = toCatalogInstall(manifest?.install, packageName);
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

function getCatalogChannelId(entry: CatalogEntry) {
  return trimString(entry.openclaw.channel.id) || trimString(entry.name);
}

function getCatalogChannelKey(entry: CatalogEntry) {
  return getCatalogChannelId(entry).toLowerCase();
}

function setUniqueCatalogEntry(
  entriesByChannelId: Map<string, CatalogOwnerEntry>,
  entry: CatalogEntry,
  owner: string,
) {
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

function stripSeedOnlyDocsMetadata(entry: CatalogEntry): CatalogEntry {
  const hostConfig = isRecord(entry.openclaw.channelHostConfig)
    ? entry.openclaw.channelHostConfig
    : null;
  if (!hostConfig || !("docsInventory" in hostConfig)) {
    return entry;
  }
  const runtimeHostConfig = { ...hostConfig };
  delete runtimeHostConfig.docsInventory;
  return {
    ...entry,
    openclaw: {
      ...entry.openclaw,
      channelHostConfig: runtimeHostConfig,
    },
  };
}

/**
 * Collects publishable channel catalog entries from bundled and external channels.
 * @internal Directly tested script implementation detail.
 */
export function buildOfficialChannelCatalog(params: CatalogParams = {}): {
  entries: CatalogEntry[];
} {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const seedEntriesByChannelId = new Map<string, CatalogOwnerEntry>();
  for (const entry of Array.isArray(officialExternalChannelSeed.entries)
    ? officialExternalChannelSeed.entries
    : []) {
    const defaultChoice = entry.openclaw.install.defaultChoice;
    if (defaultChoice !== "clawhub" && defaultChoice !== "npm" && defaultChoice !== "local") {
      throw new Error(`invalid install choice for official channel seed package "${entry.name}"`);
    }
    const channelConfigs = toCatalogChannelConfigs(entry.openclaw.channelConfigs);
    if (!channelConfigs) {
      throw new Error(`invalid channel configs for official channel seed package "${entry.name}"`);
    }
    const catalogEntry = {
      ...entry,
      openclaw: {
        ...entry.openclaw,
        channelConfigs,
        install: { ...entry.openclaw.install, defaultChoice },
      },
    } satisfies CatalogEntry;
    setUniqueCatalogEntry(
      seedEntriesByChannelId,
      stripSeedOnlyDocsMetadata(catalogEntry),
      `scripts/lib/official-external-channel-seed.json package "${trimString(entry.name)}"`,
    );
  }

  const repositoryEntriesByChannelId = new Map<string, CatalogOwnerEntry>();
  for (const { dirName, packageJson, pluginManifest } of readRepositoryPackageJsons(repoRoot)) {
    const entry = buildCatalogEntry(packageJson, pluginManifest);
    if (entry) {
      setUniqueCatalogEntry(
        repositoryEntriesByChannelId,
        entry,
        `extensions/${dirName}/package.json`,
      );
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

function serializeOfficialChannelCatalog(catalog: { entries: readonly CatalogEntry[] }): string {
  return [
    "{",
    '  "entries": [',
    ...catalog.entries.map(
      (entry, index) =>
        `    ${JSON.stringify(entry)}${index === catalog.entries.length - 1 ? "" : ","}`,
    ),
    "  ]",
    "}",
    "",
  ].join("\n");
}

function renderOfficialChannelCatalog(params: CatalogParams = {}) {
  return serializeOfficialChannelCatalog(buildOfficialChannelCatalog(params));
}

export function writeOfficialChannelCatalog(params: CatalogParams = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH);
  return writeTextFileIfChanged(outputPath, renderOfficialChannelCatalog({ repoRoot }));
}

export function writeOfficialChannelCatalogSource(params: CatalogParams = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH);
  return writeTextFileIfChanged(outputPath, renderOfficialChannelCatalog({ repoRoot }));
}

export function checkOfficialChannelCatalogSource(params: CatalogParams = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH);
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  return current === renderOfficialChannelCatalog({ repoRoot });
}

function toChannelDocsEntry(
  entry: {
    source?: string;
    openclaw: {
      channel: Record<string, unknown>;
      channelHostConfig?: Record<string, unknown>;
    };
  },
  sourceOverride?: ChannelDocsSource,
) {
  const channel = isRecord(entry.openclaw.channel) ? entry.openclaw.channel : null;
  const hostConfig = isRecord(entry.openclaw.channelHostConfig)
    ? entry.openclaw.channelHostConfig
    : null;
  const exposure = channel && isRecord(channel.exposure) ? channel.exposure : null;
  if (!channel || exposure?.docs === false) {
    return null;
  }
  const id = trimString(channel.id);
  if (!id) {
    return null;
  }
  const docsPath = trimString(channel.docsPath) || `/channels/${id}`;
  const source = sourceOverride ?? (trimString(hostConfig?.docsSource) || trimString(entry.source));
  return {
    id,
    docsPath,
    source:
      source === "external" || source === "bundled" || source === "built-in" ? source : "official",
  } satisfies ChannelDocsEntry;
}

function readChannelDocsFrontmatter(repoRoot: string, entry: ChannelDocsEntry) {
  const route = entry.docsPath.split(/[?#]/u, 1)[0]?.replace(/^\/+/u, "");
  if (!route) {
    throw new Error(`channel ${entry.id} has an invalid docs route: ${entry.docsPath}`);
  }
  const candidates = [
    path.join(repoRoot, "docs", `${route}.md`),
    path.join(repoRoot, "docs", `${route}.mdx`),
  ];
  const docsPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!docsPath) {
    throw new Error(`channel ${entry.id} docs route does not resolve: ${entry.docsPath}`);
  }
  const content = fs.readFileSync(docsPath, "utf8");
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!frontmatterMatch) {
    throw new Error(`${path.relative(repoRoot, docsPath)} is missing YAML frontmatter`);
  }
  const frontmatter: unknown = parseYaml(frontmatterMatch[1] ?? "");
  const label = trimString(isRecord(frontmatter) ? frontmatter.title : undefined);
  const summary = trimString(isRecord(frontmatter) ? frontmatter.summary : undefined);
  if (!label || !summary) {
    throw new Error(`${path.relative(repoRoot, docsPath)} must define title and summary`);
  }
  return { ...entry, label, summary };
}

function isInstallableChannelManifest(manifest: Record<string, unknown>) {
  const release = isRecord(manifest.release) ? manifest.release : null;
  const install = isRecord(manifest.install) ? manifest.install : null;
  return (
    release?.publishToNpm === true ||
    release?.publishToClawHub === true ||
    Boolean(trimString(install?.npmSpec) || trimString(install?.clawhubSpec))
  );
}

/**
 * Builds the public docs projection from the install catalog plus bundled channel manifests.
 * @internal Directly tested script implementation detail.
 */
export function buildOfficialChannelDocsCatalog(params: CatalogParams = {}): {
  entries: CompleteChannelDocsEntry[];
} {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const entriesByChannelId = new Map<string, ChannelDocsEntry>();
  const excludedPackagedExtensionDirs = readExcludedPackagedExtensionDirs(repoRoot);

  for (const entry of buildOfficialChannelCatalog({ repoRoot }).entries) {
    const docsEntry = toChannelDocsEntry(entry);
    if (docsEntry) {
      entriesByChannelId.set(docsEntry.id, docsEntry);
    }
  }

  for (const { dirName, packageJson } of readRepositoryPackageJsons(repoRoot)) {
    const manifest =
      isRecord(packageJson) && isRecord(packageJson.openclaw) ? packageJson.openclaw : {};
    const channel = isRecord(manifest.channel) ? manifest.channel : null;
    if (!channel) {
      continue;
    }
    const exposure = isRecord(channel.exposure) ? channel.exposure : null;
    const isCoreBundled = !excludedPackagedExtensionDirs.has(dirName);
    const isInstallable = isInstallableChannelManifest(manifest);
    if (!isCoreBundled && !isInstallable) {
      if (exposure?.docs === false) {
        continue;
      }
      throw new Error(
        `docs-visible channel ${trimString(channel.id) || dirName} is neither bundled nor installable`,
      );
    }
    const docsEntry = toChannelDocsEntry(
      { openclaw: { channel } },
      isCoreBundled ? "bundled" : "official",
    );
    if (docsEntry) {
      entriesByChannelId.set(docsEntry.id, docsEntry);
    }
  }

  entriesByChannelId.set(WEBCHAT_DOCS_ENTRY.id, WEBCHAT_DOCS_ENTRY);
  const entries = [...entriesByChannelId.values()].map((entry) =>
    readChannelDocsFrontmatter(repoRoot, entry),
  );
  entries.sort(
    (left, right) =>
      left.label.localeCompare(right.label, "en") || left.id.localeCompare(right.id, "en"),
  );
  return { entries };
}

function renderChannelDocsSummary(entry: CompleteChannelDocsEntry) {
  const summary = entry.summary.replace(/[.!?]+$/u, "");
  const normalizedSummary = summary
    ? `${summary.slice(0, 1).toUpperCase()}${summary.slice(1)}`
    : `${entry.label} messaging for OpenClaw`;
  const sourceLabel =
    entry.source === "external"
      ? "external plugin"
      : entry.source === "bundled"
        ? "bundled plugin"
        : entry.source === "built-in"
          ? "included in core"
          : "official plugin";
  return `- [${entry.label}](${entry.docsPath}) - ${normalizedSummary} (${sourceLabel}).`;
}

function renderOfficialChannelDocsBlock(params: CatalogParams = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const lines = buildOfficialChannelDocsCatalog({ repoRoot }).entries.map(renderChannelDocsSummary);
  return [
    OFFICIAL_CHANNEL_DOCS_START_MARKER,
    "<!-- Generated by `pnpm channels:catalog:gen`. Edit manifests/seed for membership and routes; edit page frontmatter for public names and summaries. -->",
    "",
    ...lines,
    "",
    OFFICIAL_CHANNEL_DOCS_END_MARKER,
  ].join("\n");
}

function replaceOfficialChannelDocsBlock(current: string, block: string) {
  const startIndex = current.indexOf(OFFICIAL_CHANNEL_DOCS_START_MARKER);
  const endIndex = current.indexOf(OFFICIAL_CHANNEL_DOCS_END_MARKER);
  const startCount = current.split(OFFICIAL_CHANNEL_DOCS_START_MARKER).length - 1;
  const endCount = current.split(OFFICIAL_CHANNEL_DOCS_END_MARKER).length - 1;
  if (
    startCount !== 1 ||
    endCount !== 1 ||
    startIndex === -1 ||
    endIndex === -1 ||
    endIndex < startIndex
  ) {
    throw new Error(
      `${OFFICIAL_CHANNEL_DOCS_INDEX_RELATIVE_PATH} must contain exactly one generated channel marker pair`,
    );
  }
  const afterEndIndex = endIndex + OFFICIAL_CHANNEL_DOCS_END_MARKER.length;
  return `${current.slice(0, startIndex)}${block}${current.slice(afterEndIndex)}`;
}

export function renderOfficialChannelDocsIndex(params: CatalogParams = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_DOCS_INDEX_RELATIVE_PATH);
  const current = fs.readFileSync(outputPath, "utf8");
  return replaceOfficialChannelDocsBlock(current, renderOfficialChannelDocsBlock({ repoRoot }));
}

export function writeOfficialChannelDocsIndex(params: CatalogParams = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_DOCS_INDEX_RELATIVE_PATH);
  return writeTextFileIfChanged(outputPath, renderOfficialChannelDocsIndex({ repoRoot }));
}

export function checkOfficialChannelDocsIndex(params: CatalogParams = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_DOCS_INDEX_RELATIVE_PATH);
  if (!fs.existsSync(outputPath)) {
    return false;
  }
  const current = fs.readFileSync(outputPath, "utf8");
  try {
    return current === renderOfficialChannelDocsIndex({ repoRoot });
  } catch {
    return false;
  }
}

function collectDocsNavPageCounts(node: unknown, counts: Map<string, number> = new Map()) {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectDocsNavPageCounts(item, counts);
    }
    return counts;
  }
  if (!isRecord(node)) {
    return counts;
  }
  if (Array.isArray(node.pages)) {
    for (const page of node.pages) {
      if (typeof page === "string") {
        const route = page.replace(/^\/+/u, "");
        counts.set(route, (counts.get(route) ?? 0) + 1);
      } else {
        collectDocsNavPageCounts(page, counts);
      }
    }
  }
  for (const value of Object.values(node)) {
    if (value !== node.pages) {
      collectDocsNavPageCounts(value, counts);
    }
  }
  return counts;
}

function findEnglishChannelsTab(docsConfig: unknown) {
  const navigation =
    isRecord(docsConfig) && isRecord(docsConfig.navigation) ? docsConfig.navigation : null;
  const languages = Array.isArray(navigation?.languages) ? navigation.languages : [];
  const english = languages.find(
    (language) => isRecord(language) && trimString(language.language) === "en",
  );
  const tabs = isRecord(english) && Array.isArray(english.tabs) ? english.tabs : [];
  return tabs.find((tab) => isRecord(tab) && trimString(tab.tab) === "Channels") ?? null;
}

function readDocsNavCounts(repoRoot: string) {
  const navPath = path.join(repoRoot, OFFICIAL_CHANNEL_DOCS_NAV_RELATIVE_PATH);
  const docsConfig: unknown = JSON.parse(fs.readFileSync(navPath, "utf8"));
  return {
    all: collectDocsNavPageCounts(docsConfig),
    channels: collectDocsNavPageCounts(findEnglishChannelsTab(docsConfig)),
  };
}

function buildHiddenChannelDocsRoutes(repoRoot: string) {
  const channelsById = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(officialExternalChannelSeed.entries)
    ? officialExternalChannelSeed.entries
    : []) {
    const channel = isRecord(entry?.openclaw?.channel) ? entry.openclaw.channel : null;
    const channelId = trimString(channel?.id);
    if (channelId && channel) {
      channelsById.set(channelId, channel);
    }
  }
  for (const { packageJson } of readRepositoryPackageJsons(repoRoot)) {
    const manifest =
      isRecord(packageJson) && isRecord(packageJson.openclaw) ? packageJson.openclaw : {};
    const channel = isRecord(manifest.channel) ? manifest.channel : null;
    const channelId = trimString(channel?.id);
    if (channelId && channel) {
      channelsById.set(channelId, channel);
    }
  }

  const routes = new Set<string>();
  for (const channel of channelsById.values()) {
    const exposure = isRecord(channel.exposure) ? channel.exposure : null;
    const docsPath = trimString(channel.docsPath);
    if (exposure?.docs !== false || !docsPath.startsWith("/")) {
      continue;
    }
    const route = docsPath.split("#", 1)[0]?.replace(/^\/+/u, "");
    if (route) {
      routes.add(route);
    }
  }
  return routes;
}

export function findMissingOfficialChannelDocsNavRoutes(params: CatalogParams = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const navCounts = readDocsNavCounts(repoRoot);
  const missing = new Set<string>();
  for (const entry of buildOfficialChannelDocsCatalog({ repoRoot }).entries) {
    if (!entry.docsPath.startsWith("/")) {
      continue;
    }
    const route = entry.docsPath.split("#", 1)[0]?.replace(/^\/+/u, "");
    const counts = route?.startsWith("channels/") ? navCounts.channels : navCounts.all;
    if (route && (counts.get(route) ?? 0) === 0) {
      missing.add(route);
    }
  }
  return [...missing].toSorted((left, right) => left.localeCompare(right, "en"));
}

export function findUnexpectedOfficialChannelDocsNavRoutes(params: CatalogParams = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const navCounts = readDocsNavCounts(repoRoot).all;
  return [...buildHiddenChannelDocsRoutes(repoRoot)]
    .filter((route) => (navCounts.get(route) ?? 0) > 0)
    .toSorted((left, right) => left.localeCompare(right, "en"));
}

export function findDuplicateOfficialChannelDocsNavRoutes(params: CatalogParams = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const navCounts = readDocsNavCounts(repoRoot).all;
  const duplicateRoutes = new Set<string>();
  for (const entry of buildOfficialChannelDocsCatalog({ repoRoot }).entries) {
    const route = entry.docsPath.split("#", 1)[0]?.replace(/^\/+/u, "");
    if (route && (navCounts.get(route) ?? 0) > 1) {
      duplicateRoutes.add(route);
    }
  }
  return [...duplicateRoutes].toSorted((left, right) => left.localeCompare(right, "en"));
}

function reportOfficialChannelDocsNavIssues(params: CatalogParams = {}) {
  const issueGroups = [
    {
      label: "is missing channel routes",
      routes: findMissingOfficialChannelDocsNavRoutes(params),
    },
    {
      label: "exposes hidden channel routes",
      routes: findUnexpectedOfficialChannelDocsNavRoutes(params),
    },
    {
      label: "duplicates channel routes",
      routes: findDuplicateOfficialChannelDocsNavRoutes(params),
    },
  ];
  let failed = false;
  for (const issue of issueGroups) {
    if (issue.routes.length === 0) {
      continue;
    }
    console.error(
      `${OFFICIAL_CHANNEL_DOCS_NAV_RELATIVE_PATH} ${issue.label}: ${issue.routes.join(", ")}`,
    );
    failed = true;
  }
  return failed;
}

function main(argv: string[] = process.argv.slice(2)) {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write === check) {
    console.error("usage: node scripts/write-official-channel-catalog.mjs --write|--check");
    process.exitCode = 2;
    return;
  }
  if (write) {
    writeOfficialChannelCatalogSource();
    writeOfficialChannelDocsIndex();
    if (reportOfficialChannelDocsNavIssues()) {
      process.exitCode = 1;
    }
    return;
  }
  let failed = false;
  if (!checkOfficialChannelCatalogSource()) {
    console.error(
      `${OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH} is stale. Run \`pnpm channels:catalog:gen\`.`,
    );
    failed = true;
  }
  if (!checkOfficialChannelDocsIndex()) {
    console.error(
      `${OFFICIAL_CHANNEL_DOCS_INDEX_RELATIVE_PATH} is stale. Run \`pnpm channels:catalog:gen\`.`,
    );
    failed = true;
  }
  if (reportOfficialChannelDocsNavIssues()) {
    failed = true;
  }
  if (failed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
