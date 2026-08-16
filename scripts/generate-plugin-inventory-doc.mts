#!/usr/bin/env node
// Generates the plugin inventory documentation page.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { PluginManifest as RuntimePluginManifest } from "../src/plugins/manifest-types.js";
import type { PackageManifest as RuntimePackageManifest } from "../src/plugins/package-manifest.js";
import { collectExcludedPackagedExtensionDirs } from "./lib/packaged-extension-dirs.mts";
import {
  assertPluginInventoryCoverage,
  resolvePluginSurface,
} from "./lib/plugin-inventory-doc.mts";

const DOC_PATH = "docs/plugins/plugin-inventory.md";
const REFERENCE_INDEX_PATH = "docs/plugins/reference.md";
const REFERENCE_DIR = "docs/plugins/reference";
const ROOT = process.cwd();
const EXTENSIONS_DIR = path.join(ROOT, "extensions");

const PROVIDER_DOC_ALIASES = new Map([
  ["amazon-bedrock", "/providers/bedrock"],
  ["amazon-bedrock-mantle", "/providers/bedrock-mantle"],
  ["kimi", "/providers/moonshot"],
  ["perplexity", "/providers/perplexity-provider"],
]);
const PLUGIN_DOC_ALIASES = new Map([
  ["acpx", "/tools/acp-agents-setup"],
  ["brave", "/tools/brave-search"],
  ["browser", "/tools/browser"],
  ["codex", "/plugins/codex-harness"],
  ["document-extract", "/tools/pdf"],
  ["duckduckgo", "/tools/duckduckgo-search"],
  ["exa", "/tools/exa-search"],
  ["firecrawl", "/tools/firecrawl"],
  ["parallel", "/tools/parallel-search"],
  ["perplexity", "/tools/perplexity-search"],
  ["policy", "/cli/policy"],
  ["tavily", "/tools/tavily"],
  ["tokenjuice", "/tools/tokenjuice"],
]);
const SKIPPED_REFERENCE_PAGE_IDS = new Set(["parallel"]);
const MANUAL_SECTION_START = "<!-- openclaw-plugin-reference:manual-start -->";
const MANUAL_SECTION_END = "<!-- openclaw-plugin-reference:manual-end -->";
// Generated link labels are user-visible product names and translation source.
const RELATED_DOC_PRODUCT_IDS = new Set([
  "chutes",
  "discord",
  "fireworks",
  "googlechat",
  "imessage",
  "line",
  "matrix",
  "meta",
  "msteams",
  "raft",
  "runway",
  "signal",
  "slack",
  "synthetic",
  "telegram",
  "tokenjuice",
  "whatsapp",
]);

type PluginManifest = Partial<RuntimePluginManifest>;
type PluginPackageJson = Partial<RuntimePackageManifest> & {
  openclaw?: RuntimePackageManifest["openclaw"] & {
    release?: Partial<Record<"publishToClawHub" | "publishToNpm", boolean>>;
  };
};
type DocLink = { label: string; href: string };
type PluginStatus = "core" | "external" | "source";
type PluginSourceEntry = {
  dirName: string;
  id: string;
  manifest: PluginManifest;
  packageJson: PluginPackageJson;
};

function createPluginRecord(entry: PluginSourceEntry, excludedDirs: Set<string>) {
  const { id, manifest, packageJson } = entry;
  const status = resolveStatus(entry, excludedDirs);
  return {
    description: resolveDescription(entry),
    docs: resolveDocs(entry),
    id,
    installRoute: resolveInstallRoute(packageJson, status),
    name: humanizeId(id),
    packageName: packageJson.name ?? (status === "core" ? "openclaw" : "-"),
    status,
    surface: resolvePluginSurface(manifest),
  };
}

type PluginRecord = ReturnType<typeof createPluginRecord>;

function readJsonPath(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function fileExists(relativePath: string) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function normalizeDocPath(value: unknown) {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return null;
  }
  return value.replace(/\.mdx?$/u, "");
}

function docLink({ label, href }: DocLink) {
  return `[${label}](${href})`;
}

function relatedDocLabel(value: string) {
  return RELATED_DOC_PRODUCT_IDS.has(value) ? humanizeId(value) : value;
}

function pluginReferencePath(id: string) {
  return `/plugins/reference/${id}`;
}

function hasGeneratedReferencePage(record: PluginRecord) {
  if (!SKIPPED_REFERENCE_PAGE_IDS.has(record.id)) {
    return true;
  }
  if (PLUGIN_DOC_ALIASES.has(record.id)) {
    return false;
  }
  throw new Error(`skipped plugin reference page ${record.id} needs a plugin doc alias`);
}

function pluginInventoryHref(record: PluginRecord) {
  if (hasGeneratedReferencePage(record)) {
    return pluginReferencePath(record.id);
  }
  return PLUGIN_DOC_ALIASES.get(record.id) ?? null;
}

function pluginReferenceLabel(record: PluginRecord) {
  const label = escapeInventoryText(record.id);
  const href = pluginInventoryHref(record);
  return href ? docLink({ href, label }) : label;
}

function humanizeId(value: string) {
  if (value === "teams-meetings") {
    return "Microsoft Teams meetings";
  }
  if (value === "zoom-meetings") {
    return "Zoom meetings";
  }
  const names = new Map([
    ["acpx", "ACPx"],
    ["ai", "AI"],
    ["api", "API"],
    ["aws", "AWS"],
    ["azure", "Azure"],
    ["byteplus", "BytePlus"],
    ["clawrouter", "ClawRouter"],
    ["codex", "Codex"],
    ["cli", "CLI"],
    ["comfy", "ComfyUI"],
    ["dashscope", "DashScope"],
    ["deepgram", "Deepgram"],
    ["deepinfra", "DeepInfra"],
    ["deepseek", "DeepSeek"],
    ["duckduckgo", "DuckDuckGo"],
    ["exa", "Exa"],
    ["fal", "fal"],
    ["feishu", "Feishu"],
    ["github", "GitHub"],
    ["googlechat", "Google Chat"],
    ["gpt", "GPT"],
    ["groq", "Groq"],
    ["huggingface", "Hugging Face"],
    ["imessage", "iMessage"],
    ["irc", "IRC"],
    ["kimi", "Kimi"],
    ["line", "LINE"],
    ["litellm", "LiteLLM"],
    ["llm", "LLM"],
    ["llmtr", "LLMTR"],
    ["lmstudio", "LM Studio"],
    ["longcat", "LongCat"],
    ["mdns", "mDNS"],
    ["minimax", "MiniMax"],
    ["modelstudio", "Model Studio"],
    ["msteams", "Microsoft Teams"],
    ["nextcloud", "Nextcloud"],
    ["nvidia", "NVIDIA"],
    ["openai", "OpenAI"],
    ["opencode", "OpenCode"],
    ["openrouter", "OpenRouter"],
    ["otel", "OpenTelemetry"],
    ["pixverse", "PixVerse"],
    ["qa", "QA"],
    ["qqbot", "QQ Bot"],
    ["qwen", "Qwen"],
    ["qwencloud", "Qwen Cloud"],
    ["raft", "Raft"],
    ["searxng", "SearXNG"],
    ["sglang", "SGLang"],
    ["stepfun", "StepFun"],
    ["tokenhub", "TokenHub"],
    ["tts", "TTS"],
    ["twitch", "Twitch"],
    ["ui", "UI"],
    ["vllm", "vLLM"],
    ["whatsapp", "WhatsApp"],
    ["xai", "xAI"],
    ["zai", "Z.AI"],
    ["zalouser", "Zalo Personal"],
  ]);
  return value
    .split("-")
    .map((part) => names.get(part) ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function displayList(values: unknown[]) {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(humanizeId)
    .join(", ");
}

function normalizePackageDescription(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim().replace(/\s+/gu, " ").replace(/\.$/u, "");
}

function resolveDescription({ manifest, packageJson }: PluginSourceEntry) {
  const manifestDescription = normalizePackageDescription(manifest.description);
  if (manifestDescription) {
    return `${manifestDescription}.`;
  }

  const channels = Array.isArray(manifest.channels) ? manifest.channels : [];
  if (channels.length > 0) {
    const channelLabel = displayList(channels);
    const channelNoun = channelLabel.toLowerCase().includes("channel") ? "" : " channel";
    return `Adds the ${channelLabel}${channelNoun} surface for sending and receiving OpenClaw messages.`;
  }

  const providers = Array.isArray(manifest.providers) ? manifest.providers : [];
  if (providers.length > 0) {
    return `Adds ${displayList(providers)} model provider support to OpenClaw.`;
  }

  const contracts = Object.keys(manifest.contracts ?? {}).toSorted((left, right) =>
    left.localeCompare(right),
  );
  const contractDescriptions: Record<string, string> = {
    agentToolResultMiddleware: "Adds agent tool-result middleware.",
    documentExtractors: "Adds document extraction for local attachments.",
    imageGenerationProviders: "Adds image generation provider support.",
    mediaUnderstandingProviders: "Adds media understanding provider support.",
    embeddingProviders: "Adds embedding provider support, including memory search.",
    migrationProviders: "Adds migration import support.",
    musicGenerationProviders: "Adds music generation provider support.",
    realtimeTranscriptionProviders: "Adds realtime transcription provider support.",
    realtimeVoiceProviders: "Adds realtime voice provider support.",
    speechProviders: "Adds text-to-speech provider support.",
    tools: "Adds agent-callable tools.",
    videoGenerationProviders: "Adds video generation provider support.",
    webContentExtractors: "Adds readable web content extraction.",
    webFetchProviders: "Adds web fetch provider support.",
    webSearchProviders: "Adds web search provider support.",
    workerProviders: "Adds cloud worker provider support.",
  };
  const describedContracts = contracts
    .map((contract) => contractDescriptions[contract])
    .filter((value) => typeof value === "string");
  if (describedContracts.length > 0) {
    return describedContracts.join(" ");
  }

  const packageDescription = normalizePackageDescription(packageJson.description);
  return packageDescription ? `${packageDescription}.` : "Provides an OpenClaw plugin.";
}

function pushUniqueDocLink(values: DocLink[], value: DocLink | null) {
  if (
    value &&
    !values.some((existing) => existing.label === value.label && existing.href === value.href)
  ) {
    values.push(value);
  }
}

function resolveDocs({ dirName, manifest, packageJson }: PluginSourceEntry) {
  const links: DocLink[] = [];
  const manifestId = typeof manifest.id === "string" ? manifest.id : dirName;
  const pluginAlias = PLUGIN_DOC_ALIASES.get(manifestId) ?? PLUGIN_DOC_ALIASES.get(dirName);
  if (pluginAlias) {
    const pluginAliasLabel = relatedDocLabel(manifestId);
    pushUniqueDocLink(links, { href: pluginAlias, label: pluginAliasLabel });
  }

  const channelDoc = normalizeDocPath(packageJson.openclaw?.channel?.docsPath);
  if (channelDoc) {
    pushUniqueDocLink(links, {
      href: channelDoc,
      label: relatedDocLabel(channelDoc.replace(/^\/channels\//u, "")),
    });
  }

  for (const channel of manifest.channels ?? []) {
    if (typeof channel !== "string") {
      continue;
    }
    const relativePath = `docs/channels/${channel}.md`;
    if (fileExists(relativePath)) {
      pushUniqueDocLink(links, { href: `/channels/${channel}`, label: relatedDocLabel(channel) });
    }
  }

  for (const provider of manifest.providers ?? []) {
    if (typeof provider !== "string") {
      continue;
    }
    const alias = PROVIDER_DOC_ALIASES.get(provider);
    if (alias) {
      pushUniqueDocLink(links, { href: alias, label: relatedDocLabel(provider) });
      continue;
    }
    const relativePath = `docs/providers/${provider}.md`;
    if (fileExists(relativePath)) {
      pushUniqueDocLink(links, {
        href: `/providers/${provider}`,
        label: relatedDocLabel(provider),
      });
    }
  }

  for (const candidate of [manifest.id, dirName, ...(manifest.legacyPluginIds ?? [])]) {
    if (typeof candidate !== "string") {
      continue;
    }
    if (fileExists(`docs/channels/${candidate}.md`)) {
      pushUniqueDocLink(links, {
        href: `/channels/${candidate}`,
        label: relatedDocLabel(candidate),
      });
    }
    if (fileExists(`docs/providers/${candidate}.md`)) {
      pushUniqueDocLink(links, {
        href: `/providers/${candidate}`,
        label: relatedDocLabel(candidate),
      });
    }
    if (fileExists(`docs/plugins/${candidate}.md`)) {
      pushUniqueDocLink(links, {
        href: `/plugins/${candidate}`,
        label: relatedDocLabel(candidate),
      });
    }
  }

  return links;
}

function resolveInstallRoute(packageJson: PluginPackageJson, status: PluginStatus): string {
  if (status === "source") {
    return "source checkout only";
  }
  if (status === "core") {
    // Explicit bundle ownership describes the current install surface; release flags may stage future publication.
    if (packageJson.openclaw?.build?.bundledDist === true) {
      return "included in OpenClaw";
    }
    const release = packageJson.openclaw?.release;
    if (release?.publishToClawHub === true || release?.publishToNpm === true) {
      return `included in OpenClaw; ${resolveInstallRoute(packageJson, "external")}`;
    }
    return "included in OpenClaw";
  }
  const install = packageJson.openclaw?.install;
  const release = packageJson.openclaw?.release;
  const clawhubSpec =
    typeof install?.clawhubSpec === "string" ? `: \`${install.clawhubSpec}\`` : "";
  const npmSpec =
    typeof install?.npmSpec === "string" && install.npmSpec !== packageJson.name
      ? `: \`${install.npmSpec}\``
      : "";
  if (release?.publishToClawHub === true && release?.publishToNpm === true) {
    if (install?.defaultChoice === "clawhub") {
      return clawhubSpec ? `ClawHub${clawhubSpec}; npm${npmSpec}` : `ClawHub + npm${npmSpec}`;
    }
    return clawhubSpec ? `npm${npmSpec}; ClawHub${clawhubSpec}` : `npm${npmSpec}; ClawHub`;
  }
  if (release?.publishToClawHub === true) {
    return `ClawHub${clawhubSpec || npmSpec}`;
  }
  if (release?.publishToNpm === true || typeof install?.npmSpec === "string") {
    return `npm${npmSpec}`;
  }
  return "installable plugin";
}

function resolveStatus(
  { dirName, packageJson }: PluginSourceEntry,
  excludedDirs: Set<string>,
): PluginStatus {
  const release = packageJson.openclaw?.release;
  const hasInstallSpec =
    typeof packageJson.openclaw?.install?.clawhubSpec === "string" ||
    typeof packageJson.openclaw?.install?.npmSpec === "string";
  if (!excludedDirs.has(dirName)) {
    return "core";
  }
  if (release?.publishToClawHub === true || release?.publishToNpm === true || hasInstallSpec) {
    return "external";
  }
  return "source";
}

function escapeInventoryText(value: unknown) {
  return String(value).replaceAll("\n", " ").trim();
}

function renderInventoryList(records: PluginRecord[]) {
  if (records.length === 0) {
    return "_None._";
  }

  return records
    .map(
      (record) =>
        `- **${pluginReferenceLabel(record)}** (\`${escapeInventoryText(record.packageName)}\`) - ${escapeInventoryText(record.installRoute)}. ${escapeInventoryText(record.description)}`,
    )
    .join("\n\n");
}

function renderRelatedDocs(record: PluginRecord) {
  if (record.docs.length === 0) {
    return "";
  }
  return `## Related docs

${record.docs.map((link) => `- ${docLink(link)}`).join("\n")}`;
}

function extractManualReferenceSections(content: string) {
  const markerStart = content.indexOf(MANUAL_SECTION_START);
  if (markerStart !== -1) {
    const contentStart = markerStart + MANUAL_SECTION_START.length;
    const markerEnd = content.indexOf(MANUAL_SECTION_END, contentStart);
    if (markerEnd !== -1) {
      return content.slice(contentStart, markerEnd).trim();
    }
  }

  const surfaceMatch = /\n## Surface\n\n[^\n]*(?:\n|$)/u.exec(content);
  if (!surfaceMatch?.index) {
    return "";
  }
  const manualStart = surfaceMatch.index + surfaceMatch[0].length;
  const relatedDocsStart = content.indexOf("\n## Related docs\n", manualStart);
  const manualEnd = relatedDocsStart === -1 ? content.length : relatedDocsStart;
  return content.slice(manualStart, manualEnd).trim();
}

function readManualReferenceSections(relativePath: string) {
  const fullPath = path.join(ROOT, relativePath);
  if (!fs.existsSync(fullPath)) {
    return "";
  }
  return extractManualReferenceSections(fs.readFileSync(fullPath, "utf8"));
}

function renderManualReferenceSections(manualSections: string) {
  if (!manualSections) {
    return "";
  }
  return `${MANUAL_SECTION_START}

${manualSections}

${MANUAL_SECTION_END}`;
}

function renderReferencePage(record: PluginRecord, manualSections = "") {
  const relatedDocs = renderRelatedDocs(record);
  const manualBlock = renderManualReferenceSections(manualSections);
  return `---
summary: "${record.description.replaceAll('"', '\\"')}"
read_when:
  - You are installing, configuring, or auditing the ${record.id} plugin
title: "${record.name} plugin"
---

# ${record.name} plugin

${record.description}

## Distribution

- Package: \`${record.packageName}\`
- Install route: ${record.installRoute}

## Surface

${record.surface}${manualBlock ? `\n\n${manualBlock}` : ""}${relatedDocs ? `\n\n${relatedDocs}` : ""}
`;
}

function renderReferenceIndex(records: PluginRecord[]) {
  const referenceCount = records.filter(hasGeneratedReferencePage).length;
  return `---
summary: "Generated index of OpenClaw plugin reference pages"
read_when:
  - You need a reference page for a specific OpenClaw plugin
  - You are auditing plugin docs coverage
title: "Plugin reference"
---

# Plugin reference

This page is generated from top-level \`extensions/*/openclaw.plugin.json\`
manifests. Package metadata enriches entries when \`package.json\` is present.
Regenerate it with:

\`\`\`bash
pnpm plugins:inventory:gen
\`\`\`

Use [Plugin inventory](/plugins/plugin-inventory) to browse all ${referenceCount}
generated plugin reference pages by distribution, package, and description.
`;
}

function collectPluginSourceEntries(): PluginSourceEntry[] {
  const entries: PluginSourceEntry[] = [];
  for (const dirName of fs
    .readdirSync(EXTENSIONS_DIR)
    .toSorted((left, right) => left.localeCompare(right))) {
    const packagePath = path.join(EXTENSIONS_DIR, dirName, "package.json");
    const manifestPath = path.join(EXTENSIONS_DIR, dirName, "openclaw.plugin.json");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    const packageJson = fs.existsSync(packagePath)
      ? (readJsonPath(packagePath) as PluginPackageJson)
      : {};
    const manifest = readJsonPath(manifestPath) as PluginManifest;
    const id = typeof manifest.id === "string" && manifest.id ? manifest.id : dirName;
    entries.push({ dirName, id, manifest, packageJson });
  }
  return entries;
}

function enumerateTopLevelPluginManifests() {
  return fs
    .readdirSync(EXTENSIONS_DIR)
    .toSorted((left, right) => left.localeCompare(right))
    .flatMap((dirName) => {
      const manifestPath = path.join(EXTENSIONS_DIR, dirName, "openclaw.plugin.json");
      if (!fs.existsSync(manifestPath)) {
        return [];
      }
      const manifest = readJsonPath(manifestPath) as PluginManifest;
      const id = typeof manifest.id === "string" && manifest.id ? manifest.id : dirName;
      return [{ dirName, id }];
    });
}

type ExternalPluginDocsInventorySeedEntry = {
  openclaw?: {
    channel?: NonNullable<PluginPackageJson["openclaw"]>["channel"];
    channelHostConfig?: {
      docsInventory?: {
        package?: PluginPackageJson;
        manifest?: PluginManifest;
      };
    };
  };
};

function collectExternalPluginDocsInventoryEntries(): PluginSourceEntry[] {
  const seed = readJsonPath(path.join(ROOT, "scripts/lib/official-external-channel-seed.json")) as {
    entries?: ExternalPluginDocsInventorySeedEntry[];
  };
  const entries: PluginSourceEntry[] = [];
  for (const entry of Array.isArray(seed.entries) ? seed.entries : []) {
    const inventory = entry?.openclaw?.channelHostConfig?.docsInventory;
    const packageMetadata = inventory?.package;
    const manifest = inventory?.manifest;
    if (!inventory) {
      continue;
    }
    if (
      typeof packageMetadata?.name !== "string" ||
      typeof manifest?.id !== "string" ||
      !entry?.openclaw?.channel
    ) {
      throw new Error("external plugin docs inventory metadata is incomplete");
    }
    entries.push({
      dirName: manifest.id,
      id: manifest.id,
      manifest,
      packageJson: {
        ...packageMetadata,
        openclaw: {
          ...packageMetadata.openclaw,
          channel: entry.openclaw.channel,
        },
      },
    });
  }
  return entries;
}

function collectPluginRecords() {
  const rootPackageJson = readJsonPath(path.join(ROOT, "package.json")) as { files?: unknown[] };
  const excludedDirs = collectExcludedPackagedExtensionDirs(rootPackageJson);
  const sourceEntries = collectPluginSourceEntries();
  assertPluginInventoryCoverage(sourceEntries, enumerateTopLevelPluginManifests());
  const records = sourceEntries.map((entry) => createPluginRecord(entry, excludedDirs));

  const sourceIds = new Set(sourceEntries.map((entry) => entry.id));
  for (const {
    dirName,
    id,
    manifest,
    packageJson,
  } of collectExternalPluginDocsInventoryEntries()) {
    if (sourceIds.has(id)) {
      continue;
    }
    records.push({
      description: resolveDescription({ dirName, id, manifest, packageJson }),
      docs: resolveDocs({ dirName, id, manifest, packageJson }),
      id,
      installRoute: resolveInstallRoute(packageJson, "external"),
      name: humanizeId(id),
      packageName: packageJson.name ?? "-",
      status: "external",
      surface: resolvePluginSurface(manifest),
    });
  }
  return records.toSorted((left, right) => left.id.localeCompare(right.id));
}

function writeGeneratedDocs(records: PluginRecord[]) {
  fs.mkdirSync(path.join(ROOT, REFERENCE_DIR), { recursive: true });
  for (const record of records.filter(hasGeneratedReferencePage)) {
    const relativePath = path.join(REFERENCE_DIR, `${record.id}.md`);
    const manualSections = readManualReferenceSections(relativePath);
    fs.writeFileSync(
      path.join(ROOT, relativePath),
      renderReferencePage(record, manualSections),
      "utf8",
    );
  }
  fs.writeFileSync(path.join(ROOT, REFERENCE_INDEX_PATH), renderReferenceIndex(records), "utf8");
}

function readGeneratedDocs(records: PluginRecord[]) {
  return [
    [REFERENCE_INDEX_PATH, renderReferenceIndex(records)] satisfies [string, string],
    ...records.filter(hasGeneratedReferencePage).map((record) => {
      const relativePath = path.join(REFERENCE_DIR, `${record.id}.md`);
      return [
        relativePath,
        renderReferencePage(record, readManualReferenceSections(relativePath)),
      ] satisfies [string, string];
    }),
  ];
}

function renderDocument() {
  const records = collectPluginRecords();
  const groups = {
    core: records.filter((record) => record.status === "core"),
    external: records.filter((record) => record.status === "external"),
    source: records.filter((record) => record.status === "source"),
  };

  return `---
summary: "Generated inventory of OpenClaw plugins shipped in core, published externally, or kept source-only"
read_when:
  - You are deciding whether a plugin ships in the core npm package or installs separately
  - You are updating bundled plugin package metadata or release automation
  - You need the canonical internal vs external plugin list
title: "Plugin inventory"
---

# Plugin inventory

This page is generated from top-level \`extensions/*/openclaw.plugin.json\`
manifests and the root npm package \`files\` exclusions. Optional \`package.json\`
metadata enriches package and distribution details. Regenerate it with:

\`\`\`bash
pnpm plugins:inventory:gen
\`\`\`

## Definitions

- **Core npm package:** built into the \`openclaw\` npm package and available without a separate plugin install.
- **Official external package:** OpenClaw-maintained plugin omitted from the core npm package, kept in this official inventory, and installed on demand through ClawHub and/or npm.
- **Source checkout only:** repo-local plugin omitted from published npm artifacts and not advertised as an installable package.

Source checkouts are different from npm installs: after \`pnpm install\`, bundled
plugins load from \`extensions/<id>\` so local edits and package-local workspace
dependencies are available.

## Install a plugin

Use the install route in each entry to decide whether install is needed. Plugins
that say \`included in OpenClaw\` are already present in the core package.
Official external packages need one install, then a Gateway restart.

For example, Discord is an official external package:

\`\`\`bash
openclaw plugins install @openclaw/discord
openclaw gateway restart
openclaw plugins inspect discord --runtime --json
\`\`\`

During the launch cutover, ordinary bare package specs still install from npm.
Use \`clawhub:@openclaw/discord\` or \`npm:@openclaw/discord\` when you need an
explicit source. After install, follow the plugin's setup doc, such as
[Discord](/channels/discord), to add credentials and channel config. See
[Manage plugins](/plugins/manage-plugins) for update, uninstall, and publishing
commands.

Each entry lists the package, distribution route, and description.

## Core npm package

${groups.core.length} plugins

${renderInventoryList(groups.core)}

## Official external packages

${groups.external.length} plugins

${renderInventoryList(groups.external)}

## Source checkout only

${groups.source.length} plugins

${renderInventoryList(groups.source)}
`;
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes("--write");
  const check = argv.includes("--check");
  if (write === check) {
    console.error(
      "usage: node --import tsx scripts/generate-plugin-inventory-doc.mts --write|--check",
    );
    process.exit(2);
  }

  const records = collectPluginRecords();
  const next = renderDocument();
  const docPath = path.join(ROOT, DOC_PATH);
  if (write) {
    fs.writeFileSync(docPath, next, "utf8");
    writeGeneratedDocs(records);
    return;
  }

  const current = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
  if (current !== next) {
    console.error(`${DOC_PATH} is stale. Run \`pnpm plugins:inventory:gen\`.`);
    process.exit(1);
  }
  for (const [relativePath, expected] of readGeneratedDocs(records)) {
    const fullPath = path.join(ROOT, relativePath);
    const actual = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
    if (actual !== expected) {
      console.error(`${relativePath} is stale. Run \`pnpm plugins:inventory:gen\`.`);
      process.exit(1);
    }
  }
}

main();
