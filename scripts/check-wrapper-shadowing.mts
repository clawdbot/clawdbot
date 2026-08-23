#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
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

const violationSchema = z
  .object({
    name: z.string(),
    wrapped: z.string(),
    wrapper: z.string(),
    via: z.string().optional(),
  })
  .strict();
const baselineSchema = z.array(violationSchema);

const baselineRelativePath = "scripts/lib/wrapper-shadowing-baseline.json";
const baselineRegenCommand = "pnpm check:wrapper-shadowing:gen";
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

function resolveBaselinePath(repoRoot: string) {
  return path.join(repoRoot, ...baselineRelativePath.split("/"));
}

async function readBaseline(repoRoot: string) {
  try {
    return baselineSchema.parse(
      JSON.parse(await fs.readFile(resolveBaselinePath(repoRoot), "utf8")),
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function findNewWrapperShadowingViolations(
  current: WrapperShadowingViolation[],
  baseline: WrapperShadowingViolation[],
) {
  const baselineKeys = new Set(baseline.map(violationKey));
  return current.filter((violation) => !baselineKeys.has(violationKey(violation)));
}

export async function evaluateWrapperShadowing(repoRoot: string) {
  const baseline = await readBaseline(repoRoot);
  if (!baseline) {
    return {
      baseline: null,
      current: await collectRepositoryWrapperShadowing(repoRoot),
      regressions: [] as WrapperShadowingViolation[],
    };
  }
  const current = await collectRepositoryWrapperShadowing(repoRoot);
  return {
    baseline,
    current,
    regressions: findNewWrapperShadowingViolations(current, baseline),
  };
}

async function writeBaseline(repoRoot: string) {
  const violations = await collectRepositoryWrapperShadowing(repoRoot);
  await fs.writeFile(resolveBaselinePath(repoRoot), `${JSON.stringify(violations, null, 2)}\n`);
  return violations.length;
}

export async function main(
  repoRoot = resolveRepoRoot(import.meta.url),
  argv = process.argv.slice(2),
) {
  const updateBaseline = argv.includes("--update-debt-baseline");
  const unknownArgs = argv.filter((arg) => arg !== "--update-debt-baseline");
  if (unknownArgs.length > 0) {
    console.error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
    return 2;
  }
  if (updateBaseline) {
    const count = await writeBaseline(repoRoot);
    console.log(`Wrote ${baselineRelativePath} (${count} entries)`);
    return 0;
  }

  const result = await evaluateWrapperShadowing(repoRoot);
  if (!result.baseline) {
    console.error(
      `Missing ${baselineRelativePath}; run \`${baselineRegenCommand}\` and commit it.`,
    );
    return 1;
  }
  if (result.regressions.length === 0) {
    console.log(
      `wrapper shadowing guard passed (${result.current.length} current, ${result.baseline.length} baselined).`,
    );
    return 0;
  }

  console.error(`Found new same-name wrapper shadowing beyond ${baselineRelativePath}:`);
  for (const violation of result.regressions) {
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
