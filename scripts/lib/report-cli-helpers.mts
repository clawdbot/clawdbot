// Parses report CLI output arguments and writes optional artifacts.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseFlagArgs, stringFlag } from "./arg-utils.mts";

type ReportCliArgs = { jsonPath: string | null; markdownPath: string | null; rootDir: string };

export const REPORT_CLI_PARSE_OPTIONS = {
  duplicateOptionMessage: (flag: string) => `${flag} was provided more than once.`,
  onUnhandledArg(arg: string) {
    throw new Error(`Unsupported argument: ${arg}`);
  },
};

export function parseReportCliArgs(argv: string[]) {
  const options: ReportCliArgs = {
    rootDir: process.cwd(),
    jsonPath: null,
    markdownPath: null,
  };
  const flagEntries = [
    ["--root", "rootDir"],
    ["--json", "jsonPath"],
    ["--markdown", "markdownPath"],
  ] satisfies Array<[string, keyof ReportCliArgs]>;
  const flagSpecs = flagEntries.map(([flag, key]) =>
    stringFlag<ReportCliArgs>(flag, key, {
      allowInline: false,
      missingValueMessage: `Expected ${flag} <value>.`,
      rejectShortOptions: true,
    }),
  );
  return parseFlagArgs(argv, options, flagSpecs, REPORT_CLI_PARSE_OPTIONS);
}

/**
 * Writes an optional report artifact, creating its parent directory first.
 */
export async function writeReportArtifact(filePath: string | null, content: string) {
  if (!filePath) {
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
