import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  markMigrationItemError,
  MIGRATION_REASON_MISSING_SOURCE_OR_TARGET,
} from "openclaw/plugin-sdk/migration";
import type { MigrationItem } from "openclaw/plugin-sdk/plugin-entry";
import { appendRegularFile, pathExists } from "openclaw/plugin-sdk/security-runtime";

export function resolveHomePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  return path.resolve(trimmed.replace(/^~(?=$|[\\/])/u, os.homedir()));
}

export async function exists(filePath: string): Promise<boolean> {
  return await pathExists(filePath);
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

export async function readJsonObject(
  filePath: string | undefined,
): Promise<Record<string, unknown>> {
  const content = await readText(filePath);
  if (!content) {
    return {};
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : {};
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

export async function appendItem(item: MigrationItem): Promise<MigrationItem> {
  if (!item.source || !item.target) {
    return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
  }
  try {
    const content = await fs.readFile(item.source, "utf8");
    const label =
      typeof item.details?.sourceLabel === "string"
        ? item.details.sourceLabel
        : path.basename(item.source);
    const header = `\n\n<!-- Imported from Claude: ${label} -->\n\n`;
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
