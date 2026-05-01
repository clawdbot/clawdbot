import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(filePath: string | undefined): Promise<boolean> {
  if (!filePath) {
    return false;
  }
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || os.homedir();
}

export function resolveHomePath(value: string): string {
  if (value === "~") {
    return resolveUserHomeDir();
  }
  if (value.startsWith("~/")) {
    return path.join(resolveUserHomeDir(), value.slice(2));
  }
  return path.resolve(value);
}

export function sanitizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 64);
}

export async function readJsonObject(
  filePath: string | undefined,
): Promise<Record<string, unknown>> {
  if (!filePath) {
    return {};
  }
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
