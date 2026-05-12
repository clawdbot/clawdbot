import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "../app-server/config.js";
import type { v2 } from "../app-server/protocol.js";
import { requestCodexAppServerJson } from "../app-server/request.js";
import {
  exists,
  isDirectory,
  readJsonObject,
  resolveHomePath,
  resolveUserHomeDir,
} from "./helpers.js";

const SKILL_FILENAME = "SKILL.md";
const MAX_SCAN_DEPTH = 6;
const MAX_DISCOVERED_DIRS = 2000;

export type CodexSkillSource = {
  name: string;
  source: string;
  sourceLabel: string;
};

export type CodexPluginSource = {
  name: string;
  source: string;
  sourceKind: "app-server" | "cache";
  migratable: boolean;
  manifestPath?: string;
  marketplaceName?: typeof CODEX_PLUGINS_MARKETPLACE_NAME;
  pluginName?: string;
  installed?: boolean;
  enabled?: boolean;
  message?: string;
};

type CodexArchiveSource = {
  id: string;
  path: string;
  relativePath: string;
  message?: string;
};

type CodexSource = {
  root: string;
  confidence: "low" | "medium" | "high";
  codexHome: string;
  codexSkillsDir?: string;
  personalAgentsSkillsDir?: string;
  configPath?: string;
  hooksPath?: string;
  skills: CodexSkillSource[];
  plugins: CodexPluginSource[];
  pluginDiscoveryError?: string;
  archivePaths: CodexArchiveSource[];
};

function defaultCodexHome(): string {
  return resolveHomePath(process.env.CODEX_HOME?.trim() || "~/.codex");
}

function personalAgentsSkillsDir(): string {
  return path.join(resolveUserHomeDir(), ".agents", "skills");
}

async function safeReadDir(dir: string): Promise<Dirent[]> {
  return await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function discoverSkillDirs(params: {
  root: string | undefined;
  sourceLabel: string;
  excludeSystem?: boolean;
}): Promise<CodexSkillSource[]> {
  if (!params.root || !(await isDirectory(params.root))) {
    return [];
  }
  const discovered: CodexSkillSource[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (discovered.length >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) {
      return;
    }
    const name = path.basename(dir);
    if (params.excludeSystem && depth === 1 && name === ".system") {
      return;
    }
    if (await exists(path.join(dir, SKILL_FILENAME))) {
      discovered.push({ name, source: dir, sourceLabel: params.sourceLabel });
      return;
    }
    for (const entry of await safeReadDir(dir)) {
      if (!entry.isDirectory()) {
        continue;
      }
      await visit(path.join(dir, entry.name), depth + 1);
    }
  }
  await visit(params.root, 0);
  return discovered;
}

async function discoverPluginDirs(codexHome: string): Promise<CodexPluginSource[]> {
  const root = path.join(codexHome, "plugins", "cache");
  if (!(await isDirectory(root))) {
    return [];
  }
  const discovered = new Map<string, CodexPluginSource>();
  async function visit(dir: string, depth: number): Promise<void> {
    if (discovered.size >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) {
      return;
    }
    const manifestPath = path.join(dir, ".codex-plugin", "plugin.json");
    if (await exists(manifestPath)) {
      const manifest = await readJsonObject(manifestPath);
      const manifestName = typeof manifest.name === "string" ? manifest.name.trim() : "";
      const name = manifestName || path.basename(dir);
      discovered.set(dir, {
        name,
        source: dir,
        manifestPath,
        sourceKind: "cache",
        migratable: false,
        message:
          "Cached Codex plugin bundle found. Review manually unless the plugin is also installed in the source Codex app-server inventory.",
      });
      return;
    }
    for (const entry of await safeReadDir(dir)) {
      if (!entry.isDirectory()) {
        continue;
      }
      await visit(path.join(dir, entry.name), depth + 1);
    }
  }
  await visit(root, 0);
  return [...discovered.values()].toSorted((a, b) => a.source.localeCompare(b.source));
}

async function discoverInstalledCuratedPlugins(codexHome: string): Promise<{
  plugins: CodexPluginSource[];
  error?: string;
}> {
  try {
    const response = await requestCodexAppServerJson<v2.PluginListResponse>({
      method: "plugin/list",
      requestParams: { cwds: [] } satisfies v2.PluginListParams,
      timeoutMs: 60_000,
      isolated: true,
      startOptions: {
        transport: "stdio",
        command: "codex",
        commandSource: "config",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
        env: {
          CODEX_HOME: codexHome,
          HOME: path.dirname(codexHome),
        },
      },
    });
    const marketplace = response.marketplaces.find(
      (entry) => entry.name === CODEX_PLUGINS_MARKETPLACE_NAME,
    );
    if (!marketplace) {
      return {
        plugins: [],
        error: `Codex marketplace ${CODEX_PLUGINS_MARKETPLACE_NAME} was not found in source plugin inventory.`,
      };
    }
    const plugins = marketplace.plugins
      .filter((plugin) => plugin.installed)
      .map((plugin): CodexPluginSource | undefined => {
        const pluginName = pluginNameFromSummary(plugin);
        if (!pluginName) {
          return undefined;
        }
        return {
          name: plugin.name,
          pluginName,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          source: `${CODEX_PLUGINS_MARKETPLACE_NAME}/${pluginName}`,
          sourceKind: "app-server",
          migratable: true,
          installed: plugin.installed,
          enabled: plugin.enabled,
        };
      })
      .filter((plugin): plugin is CodexPluginSource => plugin !== undefined)
      .toSorted((a, b) => (a.pluginName ?? a.name).localeCompare(b.pluginName ?? b.name));
    return { plugins };
  } catch (error) {
    return {
      plugins: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function pluginNameFromSummary(summary: v2.PluginSummary): string | undefined {
  const candidates = [summary.id, summary.name];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    const withoutMarketplaceSuffix = trimmed.endsWith(`@${CODEX_PLUGINS_MARKETPLACE_NAME}`)
      ? trimmed.slice(0, -`@${CODEX_PLUGINS_MARKETPLACE_NAME}`.length)
      : trimmed;
    const pathSegment = withoutMarketplaceSuffix.split("/").at(-1)?.trim();
    const normalized = pathSegment?.toLowerCase().replaceAll(/\s+/gu, "-");
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

export async function discoverCodexSource(input?: string): Promise<CodexSource> {
  const codexHome = resolveHomePath(input?.trim() || defaultCodexHome());
  const codexSkillsDir = path.join(codexHome, "skills");
  const agentsSkillsDir = personalAgentsSkillsDir();
  const configPath = path.join(codexHome, "config.toml");
  const hooksPath = path.join(codexHome, "hooks", "hooks.json");
  const codexSkills = await discoverSkillDirs({
    root: codexSkillsDir,
    sourceLabel: "Codex CLI skill",
    excludeSystem: true,
  });
  const personalAgentSkills = await discoverSkillDirs({
    root: agentsSkillsDir,
    sourceLabel: "personal AgentSkill",
  });
  const sourcePluginDiscovery = await discoverInstalledCuratedPlugins(codexHome);
  const sourcePluginNames = new Set(
    sourcePluginDiscovery.plugins.flatMap((plugin) =>
      plugin.pluginName ? [plugin.pluginName] : [],
    ),
  );
  const cachedPlugins = (await discoverPluginDirs(codexHome)).filter((plugin) => {
    const normalizedName = sanitizePluginName(plugin.name);
    return !sourcePluginNames.has(normalizedName);
  });
  const plugins = [...sourcePluginDiscovery.plugins, ...cachedPlugins].toSorted((a, b) =>
    a.source.localeCompare(b.source),
  );
  const archivePaths: CodexArchiveSource[] = [];
  if (await exists(configPath)) {
    archivePaths.push({
      id: "archive:config.toml",
      path: configPath,
      relativePath: "config.toml",
      message: "Codex config is archived for manual review; it is not activated automatically.",
    });
  }
  if (await exists(hooksPath)) {
    archivePaths.push({
      id: "archive:hooks/hooks.json",
      path: hooksPath,
      relativePath: "hooks/hooks.json",
      message:
        "Codex native hooks are archived for manual review because they can execute commands.",
    });
  }
  const skills = [...codexSkills, ...personalAgentSkills].toSorted((a, b) =>
    a.source.localeCompare(b.source),
  );
  const high = Boolean(codexSkills.length || plugins.length || archivePaths.length);
  const medium = personalAgentSkills.length > 0;
  return {
    root: codexHome,
    confidence: high ? "high" : medium ? "medium" : "low",
    codexHome,
    ...((await isDirectory(codexSkillsDir)) ? { codexSkillsDir } : {}),
    ...((await isDirectory(agentsSkillsDir)) ? { personalAgentsSkillsDir: agentsSkillsDir } : {}),
    ...((await exists(configPath)) ? { configPath } : {}),
    ...((await exists(hooksPath)) ? { hooksPath } : {}),
    skills,
    plugins,
    ...(sourcePluginDiscovery.error ? { pluginDiscoveryError: sourcePluginDiscovery.error } : {}),
    archivePaths,
  };
}

export function hasCodexSource(source: CodexSource): boolean {
  return source.confidence !== "low";
}

function sanitizePluginName(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/gu, "-");
}
