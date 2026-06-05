// Parses report CLI output arguments and writes optional artifacts.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Parses shared `--root`, `--json`, and `--markdown` flags for report scripts.
 */
export function parseReportCliArgs(argv) {
  const options = {
    rootDir: process.cwd(),
    jsonPath: null,
    markdownPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--root") {
      options.rootDir = argv[++index];
      continue;
    }
    if (arg === "--json") {
      options.jsonPath = argv[++index];
      continue;
    }
    if (arg === "--markdown") {
      options.markdownPath = argv[++index];
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

/**
 * Writes an optional report artifact, creating its parent directory first.
 */
export async function writeReportArtifact(filePath, content) {
  if (!filePath) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
