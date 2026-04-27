import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  markMigrationItemError,
  MIGRATION_REASON_MISSING_SOURCE_OR_TARGET,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import { parse as parseYaml } from "yaml";

export function resolveHomePath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

export function sanitizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

export async function readText(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
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
    await fs.appendFile(item.target, `${header}${content.trimEnd()}\n`, "utf8");
    return { ...item, status: "migrated" };
  } catch (err) {
    return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
  }
}
