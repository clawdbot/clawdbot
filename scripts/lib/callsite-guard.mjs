// Shared scanner for guard scripts that reject disallowed source callsites.
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  collectTypeScriptFilesFromRoots,
  resolveRepoRoot,
  resolveSourceRoots,
} from "./ts-guard-utils.mjs";

/** Run a callsite guard over TypeScript roots and exit non-zero on violations. */
export async function runCallsiteGuard(params) {
  const repoRoot = resolveRepoRoot(params.importMetaUrl);
  const sourceRoots = resolveSourceRoots(repoRoot, params.sourceRoots);
  const files = await collectTypeScriptFilesFromRoots(sourceRoots, {
    extraTestSuffixes: params.extraTestSuffixes,
  });
  const violations = [];

  for (const filePath of files) {
    const relPath = path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
    if (params.skipRelativePath?.(relPath)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    for (const line of params.findCallLines(content, filePath)) {
      const callsite = `${relPath}:${line}`;
      if (params.allowCallsite?.(callsite)) {
        continue;
      }
      violations.push(callsite);
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error(params.header);
  const output = params.sortViolations === false ? violations : violations.toSorted();
  for (const violation of output) {
    console.error(`- ${violation}`);
  }
  if (params.footer) {
    console.error(params.footer);
  }
  process.exit(1);
}
