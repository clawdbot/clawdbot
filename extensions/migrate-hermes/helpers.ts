// Migrate Hermes helper module supports helpers behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import {
  markMigrationItemError,
  markMigrationItemSkipped,
  MIGRATION_REASON_MISSING_SOURCE_OR_TARGET,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import { appendRegularFile, pathExists } from "openclaw/plugin-sdk/security-runtime";
import {
  isRecord as sharedIsRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
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
  return content ? parseDotenv(content) : {};
}

export function parseHermesConfig(content: string | undefined): Record<string, unknown> {
  if (!content) {
    return {};
  }
  const parsed = parseYaml(content);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export const isRecord = sharedIsRecord;

export function childRecord(
  root: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const value = root?.[key];
  return isRecord(value) ? value : {};
}

export const readString = normalizeOptionalString;

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
    const body = content.trimEnd();
    if (!body) {
      return markMigrationItemSkipped(item, "source file is empty");
    }
    const importBlock = `${header}${body}\n`;
    const existing = await fs.readFile(item.target, "utf8").catch(() => "");
    if (existing.includes(importBlock)) {
      return markMigrationItemSkipped(item, "already imported from Hermes");
    }
    await fs.mkdir(path.dirname(item.target), { recursive: true });
    await appendRegularFile({
      filePath: item.target,
      content: importBlock,
      rejectSymlinkParents: true,
    });
    return { ...item, status: "migrated" };
  } catch (err) {
    return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
  }
}
