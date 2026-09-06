// Assertion helpers for command execution tests and captured output.
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";

// macOS exposes /tmp through /private/var; normalize both spellings for assertions.
function normalizeDarwinTmpPath(filePath: string): string {
  return process.platform === "darwin" && filePath.startsWith("/private/var/")
    ? filePath.slice("/private".length)
    : filePath;
}

function canonicalizeComparableDir(dirPath: string): string {
  const normalized = normalizeDarwinTmpPath(path.resolve(dirPath));
  try {
    return normalizeDarwinTmpPath(fs.realpathSync.native(normalized));
  } catch {
    return normalized;
  }
}

/** Verifies secure npm install staging uses ignore-scripts and the expected target parent. */
export function expectSingleNpmInstallIgnoreScriptsCall(params: {
  calls: Array<[unknown, { cwd?: string } | undefined]>;
  expectedTargetDir: string;
}) {
  const npmCalls = params.calls.filter((call) => Array.isArray(call[0]) && call[0][0] === "npm");
  expect(npmCalls.length).toBe(1);
  const first = npmCalls[0];
  if (!first) {
    throw new Error("expected npm install call");
  }
  const [argv, opts] = first;
  expect(argv).toEqual(["npm", "install", "--omit=dev", "--loglevel=error", "--ignore-scripts"]);
  expect(opts?.cwd).toBeTruthy();
  const cwd = String(opts?.cwd);
  const expectedTargetDir = params.expectedTargetDir;
  expect(canonicalizeComparableDir(path.dirname(cwd))).toBe(
    canonicalizeComparableDir(path.dirname(expectedTargetDir)),
  );
  expect(path.basename(cwd)).toMatch(/^\.openclaw-install-stage-/);
}
