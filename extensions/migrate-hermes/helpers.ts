import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  markMigrationItemError,
  MIGRATION_REASON_MISSING_SOURCE_OR_TARGET,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import { appendRegularFile, pathExists } from "openclaw/plugin-sdk/security-runtime";
import { parse as parseYaml } from "yaml";

const HOME_SHORTHAND_RE = /^~(?=$|[\\/])/u;
const UNSAFE_NAME_CHARS_RE = /[^a-z0-9._-]+/g;
const EDGE_DASHES_RE = /^-+|-+$/g;

export function resolveHomePath(input: string): string {
  const value = input.trim();
  return value ? path.resolve(value.replace(HOME_SHORTHAND_RE, os.homedir())) : value;
}

export async function exists(filePath: string): Promise<boolean> {
  return await pathExists(filePath);
}

export async function isDirectory(dirPath: string): Promise<boolean> {
  const stat = await fs.stat(dirPath).catch(() => undefined);
  return stat?.isDirectory() === true;
}

export function sanitizeName(name: string): string {
  const normalized = name.trim().toLowerCase().replaceAll(UNSAFE_NAME_CHARS_RE, "-");
  return normalized.replaceAll(EDGE_DASHES_RE, "");
}

export async function readText(filePath: string | undefined): Promise<string | undefined> {
  return filePath ? await fs.readFile(filePath, "utf8").catch(() => undefined) : undefined;
}

export function parseEnv(content: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (!content) {
    return env;
  }
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(trimmed);
    if (!match) {
      continue;
    }
    const key = match[1];
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function parseHermesConfig(content: string | undefined): Record<string, unknown> {
  if (!content) {
    return {};
  }
  try {
    const parsed = parseYaml(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function childRecord(
  root: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const value = root?.[key];
  return isRecord(value) ? value : {};
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

export async function appendItem(item: MigrationItem): Promise<MigrationItem> {
  if (!item.source || !item.target) {
    return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
  }
  try {
    const content = await fs.readFile(item.source, "utf8");
    const header = `\n\n<!-- Imported from Hermes: ${path.basename(item.source)} -->\n\n`;
    await fs.mkdir(path.dirname(item.target), { recursive: true });
    await appendRegularFile({
      filePath: item.target,
      content: `${header}${content.trimEnd()}\n`,
      rejectSymlinkParents: true,
    });
    return { ...item, status: "migrated" };
  } catch (err) {
    return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
  }
}
