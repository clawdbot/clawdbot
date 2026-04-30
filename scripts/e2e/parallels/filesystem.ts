import { writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export async function cleanupPath(filePath: string): Promise<void> {
  await rm(filePath, { force: true, recursive: true }).catch(() => undefined);
}

export function cleanupPathSync(filePath: string): void {
  rmSync(filePath, { force: true, recursive: true });
}

export function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o755 });
}
