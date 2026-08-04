// Parses report CLI output arguments and writes optional artifacts.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseFlagArgs, stringFlag } from "./arg-utils.mjs";

export function parseReportCliArgs(argv) {
  const options = {
    rootDir: process.cwd(),
    jsonPath: null,
    markdownPath: null,
  };
  return parseFlagArgs(
    argv,
    options,
    [
      ["--root", "rootDir"],
      ["--json", "jsonPath"],
      ["--markdown", "markdownPath"],
    ].map(([flag, key]) =>
      stringFlag(flag, key, {
        allowInline: false,
        missingValueMessage: `Expected ${flag} <value>.`,
        rejectShortOptions: true,
      }),
    ),
    {
      duplicateOptionMessage: (flag) => `${flag} was provided more than once.`,
      onUnhandledArg(arg) {
        throw new Error(`Unsupported argument: ${arg}`);
      },
    },
  );
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
