import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { parseFrontmatterBlock } from "../markdown/frontmatter.js";
import { isPathInsideWithRealpath } from "../security/scan-paths.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  mergeBundlePathLists,
  normalizeBundlePathList,
} from "./bundle-manifest.js";
import {
  hasExplicitPluginConfig,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "./config-state.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

export type ClaudeBundleCommandSpec = {
  pluginId: string;
  rawName: string;
  description: string;
  promptTemplate: string;
  sourceFilePath: string;
};

function parseFrontmatterBool(value: string | undefined, fallback: boolean): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return fallback;
  }
  if (normalized === "true" || normalized === "yes" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "no" || normalized === "0") {
    return false;
  }
  return fallback;
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return normalized.trim();
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return normalized.trim();
  }
  return normalized.slice(endIndex + 4).trim();
}

function readClaudeBundleManifest(rootDir: string): Record<string, unknown> {
  const manifestPath = path.join(rootDir, CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH);
  const opened = openBoundaryFileSync({
    absolutePath: manifestPath,
    rootPath: rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    return {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  } finally {
    fs.closeSync(opened.fd);
  }
}

function resolveClaudeCommandRootDirs(rootDir: string): string[] {
  const raw = readClaudeBundleManifest(rootDir);
  const declared = normalizeBundlePathList(raw.commands);
  const defaults = fs.existsSync(path.join(rootDir, "commands")) ? ["commands"] : [];
  return mergeBundlePathLists(defaults, declared);
}

function listMarkdownFilesRecursive(rootDir: string): string[] {
  const pending = [rootDir];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (entry.isFile() && normalizeOptionalLowercaseString(entry.name)?.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

function toDefaultCommandName(rootDir: string, filePath: string): string {
  const relativePath = path.relative(rootDir, filePath);
  const withoutExt = relativePath.replace(/\.[^.]+$/u, "");
  return withoutExt.split(path.sep).join(":");
}

function toDefaultDescription(rawName: string, promptTemplate: string): string {
  const firstLine = promptTemplate
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine || rawName;
}

function loadBundleCommandsFromRoot(params: {
  pluginId: string;
  commandRoot: string;
}): ClaudeBundleCommandSpec[] {
  const entries: ClaudeBundleCommandSpec[] = [];
  for (const filePath of listMarkdownFilesRecursive(params.commandRoot)) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatterBlock(raw);
    if (parseFrontmatterBool(frontmatter["disable-model-invocation"], false)) {
      continue;
    }
    const promptTemplate = stripFrontmatter(raw);
    if (!promptTemplate) {
      continue;
    }
    const rawName =
      normalizeOptionalString(frontmatter.name) ||
      toDefaultCommandName(params.commandRoot, filePath);
    if (!rawName) {
      continue;
    }
    const description =
      normalizeOptionalString(frontmatter.description) ||
      toDefaultDescription(rawName, promptTemplate);
    entries.push({
      pluginId: params.pluginId,
      rawName,
      description,
      promptTemplate,
      sourceFilePath: filePath,
    });
  }
  return entries;
}

export function loadEnabledClaudeBundleCommands(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): ClaudeBundleCommandSpec[] {
  if (!hasExplicitPluginConfig(params.cfg?.plugins)) {
    return [];
  }
  const registry = loadPluginManifestRegistry({
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    cache: false,
  });
  const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
  const commands: ClaudeBundleCommandSpec[] = [];

  for (const record of registry.plugins) {
    if (
      record.format !== "bundle" ||
      record.bundleFormat !== "claude" ||
      !(record.bundleCapabilities ?? []).includes("commands")
    ) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: params.cfg,
    });
    if (!activationState.activated) {
      continue;
    }
    for (const relativeRoot of resolveClaudeCommandRootDirs(record.rootDir)) {
      const commandRoot = path.resolve(record.rootDir, relativeRoot);
      if (!fs.existsSync(commandRoot)) {
        continue;
      }
      if (!isPathInsideWithRealpath(record.rootDir, commandRoot, { requireRealpath: true })) {
        continue;
      }
      commands.push(...loadBundleCommandsFromRoot({ pluginId: record.id, commandRoot }));
    }
  }

  return commands;
}
