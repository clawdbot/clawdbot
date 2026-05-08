import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function resolveStylePath(path: string): string {
  const candidates = [resolve(process.cwd(), path), resolve(process.cwd(), "..", path)];
  const cssPath = candidates.find((candidate) => existsSync(candidate));
  if (!cssPath) {
    throw new Error(`Missing style fixture ${path}; checked ${candidates.join(", ")}`);
  }
  return cssPath;
}

export function readStyleSheet(path: string): string {
  return readFileSync(resolveStylePath(path), "utf8");
}

export function readStyleSheetAsync(path: string): Promise<string> {
  return readFile(resolveStylePath(path), "utf8");
}
