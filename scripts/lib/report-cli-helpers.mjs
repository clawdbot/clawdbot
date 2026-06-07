// Parses report CLI output arguments and writes optional artifacts.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Parses shared `--root`, `--json`, and `--markdown` flags for report scripts.
 */
function readReportOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`Expected ${optionName} <value>.`);
  }
  return value;
}

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
      options.rootDir = readReportOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.jsonPath = readReportOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--markdown") {
      options.markdownPath = readReportOptionValue(argv, index, arg);
      index += 1;
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
