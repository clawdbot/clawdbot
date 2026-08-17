#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {
  collectModuleExportNames,
  isExcludedExportCollisionSource,
  resolveExportModulePath,
  type ModuleExports,
  type SourceModule,
} from "./check-export-name-collisions.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  collectTypeScriptFilesFromRoots,
  resolveSourceRoots,
  runAsScript,
} from "./lib/ts-guard-utils.mts";

export type WrapperShadowingViolation = {
  name: string;
  wrapped: string;
  wrapper: string;
  via?: string;
};

const failurePrefix = "check-wrapper-shadowing";

function normalizeRelativePath(filePath: string) {
  return filePath.replaceAll(path.sep, "/");
}

export function isExcludedWrapperShadowingSource(filePath: string) {
  const normalized = normalizeRelativePath(filePath);
  const segments = normalized.split("/");
  return (
    isExcludedExportCollisionSource(normalized) ||
    segments.some((segment) =>
      ["__mocks__", "__tests__", "test-helpers", "test-support"].includes(segment),
    ) ||
    /-test-(?:helpers|support)\.[cm]?[jt]s$/u.test(normalized)
  );
}

function compareViolations(left: WrapperShadowingViolation, right: WrapperShadowingViolation) {
  return `${left.name}\0${left.wrapper}\0${left.wrapped}\0${left.via ?? ""}`.localeCompare(
    `${right.name}\0${right.wrapper}\0${right.wrapped}\0${right.via ?? ""}`,
  );
}

function violationKey(violation: WrapperShadowingViolation) {
  return `${violation.name}\0${violation.wrapper}\0${violation.wrapped}\0${violation.via ?? ""}`;
}

function resolveSourceModulePath(
  sourcePath: string,
  specifier: string,
  modulesByPath: ReadonlyMap<string, ModuleExports>,
) {
  const pluginSdkPrefix = specifier.startsWith("openclaw/plugin-sdk/")
    ? "openclaw/plugin-sdk/"
    : specifier.startsWith("@openclaw/plugin-sdk/")
      ? "@openclaw/plugin-sdk/"
      : null;
  if (!pluginSdkPrefix) {
    return resolveExportModulePath(sourcePath, specifier, modulesByPath);
  }
  return resolveExportModulePath(
    "src/plugin-sdk/importer.ts",
    `./${specifier.slice(pluginSdkPrefix.length)}`,
    modulesByPath,
  );
}

function resolveWrappedDefinition(
  wrapperPath: string,
  exportName: string,
  moduleSpecifier: string,
  modulesByPath: ReadonlyMap<string, ModuleExports>,
) {
  const importedPath = resolveSourceModulePath(wrapperPath, moduleSpecifier, modulesByPath);
  if (!importedPath) {
    return null;
  }
  const importedModule = modulesByPath.get(importedPath);
  if (!importedModule) {
    return null;
  }
  if (importedModule.valueDefinitions.has(exportName)) {
    return { wrapped: importedPath };
  }

  for (const reExport of importedModule.namedReExports) {
    if (reExport.exportedName !== exportName || reExport.importedName !== exportName) {
      continue;
    }
    const wrapped = resolveSourceModulePath(importedPath, reExport.moduleSpecifier, modulesByPath);
    if (wrapped && modulesByPath.get(wrapped)?.valueDefinitions.has(exportName)) {
      return { via: importedPath, wrapped };
    }
  }
  for (const reExportSpecifier of importedModule.starExportSpecifiers) {
    const wrapped = resolveSourceModulePath(importedPath, reExportSpecifier, modulesByPath);
    if (wrapped && modulesByPath.get(wrapped)?.valueDefinitions.has(exportName)) {
      return { via: importedPath, wrapped };
    }
  }
  return null;
}

/** Finds exported wrappers that shadow the same imported source symbol. */
export function findWrapperShadowingViolations(modules: SourceModule[]) {
  const modulesByPath = new Map<string, ModuleExports>();
  for (const sourceModule of modules.toSorted((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const modulePath = normalizeRelativePath(sourceModule.path);
    modulesByPath.set(modulePath, collectModuleExportNames(sourceModule.content, modulePath));
  }

  const violations = new Map<string, WrapperShadowingViolation>();
  for (const [wrapperPath, moduleExports] of modulesByPath) {
    for (const [name, definition] of moduleExports.valueDefinitions) {
      for (const reference of definition.importedReferences) {
        if (reference.importedName !== name) {
          continue;
        }
        const wrappedDefinition = resolveWrappedDefinition(
          wrapperPath,
          name,
          reference.moduleSpecifier,
          modulesByPath,
        );
        if (!wrappedDefinition || wrappedDefinition.wrapped === wrapperPath) {
          continue;
        }
        const violation: WrapperShadowingViolation = {
          name,
          wrapped: wrappedDefinition.wrapped,
          wrapper: wrapperPath,
          ...(wrappedDefinition.via ? { via: wrappedDefinition.via } : {}),
        };
        violations.set(violationKey(violation), violation);
      }
    }
  }
  return [...violations.values()].toSorted(compareViolations);
}

export async function collectRepositoryWrapperShadowing(repoRoot: string) {
  const collectedFiles = await collectTypeScriptFilesFromRoots(
    resolveSourceRoots(repoRoot, ["src"]),
    {
      fileExtensions: [".ts", ".mts", ".js", ".mjs"],
      includeTests: true,
      skipDirectories: ["test", "__fixtures__"],
    },
  );
  const files = collectedFiles.filter((filePath) => !isExcludedWrapperShadowingSource(filePath));
  const modules = await Promise.all(
    files.map(async (filePath) => ({
      content: await fs.readFile(filePath, "utf8"),
      path: normalizeRelativePath(path.relative(repoRoot, filePath)),
    })),
  );
  return findWrapperShadowingViolations(modules);
}

export async function main(
  repoRoot = resolveRepoRoot(import.meta.url),
  argv = process.argv.slice(2),
) {
  if (argv.length > 0) {
    console.error(`Unknown argument(s): ${argv.join(", ")}`);
    return 2;
  }

  const violations = await collectRepositoryWrapperShadowing(repoRoot);
  if (violations.length === 0) {
    console.log("wrapper shadowing guard passed.");
    return 0;
  }

  console.error("Found same-name wrapper shadowing:");
  for (const violation of violations) {
    console.error(`- ${JSON.stringify(violation)}`);
  }
  console.error(
    "Keep the canonical name on the behavior-complete outer function; rename wrapped implementations with a distinguishing suffix, or use a pure re-export when no behavior is added.",
  );
  return 1;
}

runAsScript(import.meta.url, async () => {
  let exitCode = 1;
  try {
    exitCode = await main();
  } catch (error) {
    console.error(error);
  }
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    console.error(`[${failurePrefix}] FAILED (exit ${exitCode})`);
  }
});
