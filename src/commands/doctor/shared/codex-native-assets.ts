import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectConfiguredAgentHarnessRuntimes } from "../../../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

export type CodexNativeAssetHit = {
  kind: "skill" | "plugin" | "config" | "hooks";
  path: string;
};

const MAX_SCAN_DEPTH = 6;
const MAX_DISCOVERED_DIRS = 2000;

function hasRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function resolveUserHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || os.homedir();
}

function resolveHomePath(value: string, env: NodeJS.ProcessEnv): string {
  if (value === "~") {
    return resolveUserHome(env);
  }
  if (value.startsWith("~/")) {
    return path.join(resolveUserHome(env), value.slice(2));
  }
  return path.resolve(value);
}

function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  return resolveHomePath(env.CODEX_HOME?.trim() || "~/.codex", env);
}

function resolvePersonalAgentSkillsDir(env: NodeJS.ProcessEnv): string {
  return path.join(resolveUserHome(env), ".agents", "skills");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function safeReadDir(dir: string): Promise<Dirent[]> {
  return await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
}

async function discoverSkillHits(root: string): Promise<CodexNativeAssetHit[]> {
  if (!(await isDirectory(root))) {
    return [];
  }
  const hits: CodexNativeAssetHit[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (hits.length >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) {
      return;
    }
    if (depth === 1 && path.basename(dir) === ".system") {
      return;
    }
    if (await exists(path.join(dir, "SKILL.md"))) {
      hits.push({ kind: "skill", path: dir });
      return;
    }
    for (const entry of await safeReadDir(dir)) {
      if (entry.isDirectory()) {
        await visit(path.join(dir, entry.name), depth + 1);
      }
    }
  }
  await visit(root, 0);
  return hits;
}

async function discoverPluginHits(root: string): Promise<CodexNativeAssetHit[]> {
  if (!(await isDirectory(root))) {
    return [];
  }
  const hits = new Map<string, CodexNativeAssetHit>();
  async function visit(dir: string, depth: number): Promise<void> {
    if (hits.size >= MAX_DISCOVERED_DIRS || depth > MAX_SCAN_DEPTH) {
      return;
    }
    if (await exists(path.join(dir, ".codex-plugin", "plugin.json"))) {
      hits.set(dir, { kind: "plugin", path: dir });
      return;
    }
    for (const entry of await safeReadDir(dir)) {
      if (entry.isDirectory()) {
        await visit(path.join(dir, entry.name), depth + 1);
      }
    }
  }
  await visit(root, 0);
  return [...hits.values()];
}

function isCodexRuntimeConfigured(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  return collectConfiguredAgentHarnessRuntimes(cfg, env).includes("codex");
}

function isCodexPluginConfigured(cfg: OpenClawConfig): boolean {
  const plugins = cfg.plugins;
  if (plugins?.enabled === false) {
    return false;
  }
  const allow = plugins?.allow;
  const allowList = Array.isArray(allow) ? allow.map((entry) => normalizeString(entry)) : undefined;
  if (allowList && !allowList.includes("codex")) {
    return false;
  }
  if (allowList?.includes("codex")) {
    return true;
  }
  return hasRecord(plugins?.entries?.codex) && plugins.entries.codex.enabled !== false;
}

function shouldScanCodexNativeAssets(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  return isCodexRuntimeConfigured(cfg, env) || isCodexPluginConfigured(cfg);
}

export async function scanCodexNativeAssets(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexNativeAssetHit[]> {
  const env = params.env ?? process.env;
  if (!shouldScanCodexNativeAssets(params.cfg, env)) {
    return [];
  }
  const codexHome = resolveCodexHome(env);
  const hits = new Map<string, CodexNativeAssetHit>();
  function record(hit: CodexNativeAssetHit): void {
    hits.set(`${hit.kind}:${hit.path}`, hit);
  }
  for (const hit of await discoverSkillHits(path.join(codexHome, "skills"))) {
    record(hit);
  }
  for (const hit of await discoverSkillHits(resolvePersonalAgentSkillsDir(env))) {
    record(hit);
  }
  for (const hit of await discoverPluginHits(path.join(codexHome, "plugins", "cache"))) {
    record(hit);
  }
  const configPath = path.join(codexHome, "config.toml");
  if (await exists(configPath)) {
    record({ kind: "config", path: configPath });
  }
  const hooksPath = path.join(codexHome, "hooks", "hooks.json");
  if (await exists(hooksPath)) {
    record({ kind: "hooks", path: hooksPath });
  }
  return [...hits.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

function countKind(
  hits: readonly CodexNativeAssetHit[],
  kind: CodexNativeAssetHit["kind"],
): number {
  return hits.filter((hit) => hit.kind === kind).length;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export async function collectCodexNativeAssetWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const env = params.env ?? process.env;
  const hits = await scanCodexNativeAssets({ cfg: params.cfg, env });
  if (hits.length === 0) {
    return [];
  }
  const counts = [
    plural(countKind(hits, "skill"), "skill"),
    plural(countKind(hits, "plugin"), "plugin"),
    plural(countKind(hits, "config"), "config file"),
    plural(countKind(hits, "hooks"), "hook file"),
  ];
  return [
    [
      "- Personal Codex CLI assets were found, but native Codex-mode OpenClaw agents use isolated per-agent Codex homes.",
      `- Sources: ${resolveCodexHome(env)} and ${resolvePersonalAgentSkillsDir(env)} (${counts.join(", ")}).`,
      "- These assets will not be loaded by the Codex app-server child unless you intentionally promote them.",
      "- Run `openclaw migrate codex --dry-run` to inventory them. Applying that migration copies skills into the current OpenClaw agent workspace; Codex plugins, hooks, and config stay manual-review only.",
    ].join("\n"),
  ];
}
