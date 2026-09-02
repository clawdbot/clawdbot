// UI style fixtures load expected UI style files for tests.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function resolveStylePath(path: string): string {
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
