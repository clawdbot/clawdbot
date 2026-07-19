#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const RELEASE_TOOLING_PATTERNS = [
  /^\.github\/workflows\/(?:full-release-validation|openclaw-release|openclaw-cross-os|openclaw-npm|plugin-(?:clawhub|npm)|package-acceptance)/u,
  /^scripts\/(?:full-release|openclaw-release|release-|verify-clawhub|plugin-(?:clawhub|npm)|lib\/cross-os-release-checks)/u,
  /^test\/scripts\/(?:full-release|openclaw-release|release-|verify-clawhub|plugin-(?:clawhub|npm))/u,
  /^docs\/reference\/(?:RELEASING|full-release-validation)\.md$/u,
];

function matchesAny(path, patterns) {
  return patterns.some((pattern) => pattern.test(path));
}

export function classifyReleaseEvidenceImpact(paths) {
  const changedPaths = [...new Set(paths.filter(Boolean))].toSorted((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (changedPaths.length === 1 && changedPaths[0] === "CHANGELOG.md") {
    return {
      schemaVersion: 1,
      changeClass: "changelog-only",
      changedPaths,
      reusableEvidencePolicy: "changelog-only-release-v1",
      diagnosticRerunGroups: [],
      finalPublishRequiresFullValidation: false,
    };
  }
  if (
    changedPaths.length > 0 &&
    changedPaths.every((path) => matchesAny(path, RELEASE_TOOLING_PATTERNS))
  ) {
    return {
      schemaVersion: 1,
      changeClass: "release-tooling",
      changedPaths,
      reusableEvidencePolicy: "same-code-sha-tooling-retry-v1",
      diagnosticRerunGroups: ["release-checks"],
      finalPublishRequiresFullValidation: true,
    };
  }
  if (changedPaths.length > 0 && changedPaths.every((path) => path.startsWith("extensions/"))) {
    return {
      schemaVersion: 1,
      changeClass: "plugin-product",
      changedPaths,
      reusableEvidencePolicy: "none",
      diagnosticRerunGroups: ["plugin-prerelease", "package"],
      finalPublishRequiresFullValidation: true,
    };
  }
  return {
    schemaVersion: 1,
    changeClass: changedPaths.length === 0 ? "no-change" : "product",
    changedPaths,
    reusableEvidencePolicy: changedPaths.length === 0 ? "exact-sha-v1" : "none",
    diagnosticRerunGroups: changedPaths.length === 0 ? [] : ["all"],
    finalPublishRequiresFullValidation: changedPaths.length > 0,
  };
}

function parseArgs(argv) {
  const result = { base: "", head: "HEAD" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--base") {
      result.base = argv[++index] ?? "";
    } else if (flag === "--head") {
      result.head = argv[++index] ?? "";
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!result.base) {
    throw new Error("--base is required");
  }
  return result;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = execFileSync("git", ["diff", "--name-only", `${options.base}..${options.head}`], {
    encoding: "utf8",
  });
  process.stdout.write(
    `${JSON.stringify(classifyReleaseEvidenceImpact(output.split("\n")), null, 2)}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
