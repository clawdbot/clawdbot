#!/usr/bin/env node

// Finds hidden local runtime sidecar loaders missing tsdown entries.
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  collectTypeScriptFilesFromRoots,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
const defaultSourceRoots = [path.join(repoRoot, "src"), path.join(repoRoot, "extensions")];
const localRuntimeSpecifierPattern = /^\.{1,2}\/.*\.runtime\.(?:js|ts)$/;

export type RuntimeSidecarLoaderViolation = {
  line: number;
  specifier: string;
  sourcePath: string;
  reason: string;
};
type LocatedRuntimeSidecarLoaderViolation = RuntimeSidecarLoaderViolation & { path: string };

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizeRelativePath(value: string): string {
  return path.posix.normalize(toPosixPath(value).replace(/^\.\//, ""));
}

function unwrapInitializer(expression: ts.Expression): ts.Expression {
  let current = unwrapExpression(expression);
  while (ts.isSatisfiesExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return current;
}

function readStringLiteral(node: ts.Expression): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function readArrayStrings(node: ts.Expression): string[] | null {
  const expression = unwrapInitializer(node);
  if (!ts.isArrayLiteralExpression(expression)) {
    return null;
  }
  const values: string[] = [];
  for (const element of expression.elements) {
    const value = readStringLiteral(unwrapInitializer(element));
    if (value === null) {
      return null;
    }
    values.push(value);
  }
  return values;
}

function isCreateRequireCall(node: ts.Node, createRequireNames: Set<string>): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    createRequireNames.has(node.expression.text)
  );
}

function isLocalRuntimeSpecifier(specifier: string): boolean {
  return localRuntimeSpecifierPattern.test(specifier);
}

function resolveRuntimeSpecifierSource(importerPath: string, specifier: string): string {
  const importerDir = path.posix.dirname(normalizeRelativePath(importerPath));
  const resolved = path.posix.normalize(path.posix.join(importerDir, specifier));
  return resolved.replace(/\.js$/, ".ts");
}

function readObjectEntrySources(entry: unknown): string[] {
  if (!entry || Array.isArray(entry) || typeof entry !== "object") {
    return [];
  }
  return Object.values(entry).filter((value): value is string => typeof value === "string");
}

/**
 * Collects explicit source entry files from tsdown configuration.
 */
export function collectTsdownEntrySources(config: unknown): Set<string> {
  const configs = Array.isArray(config) ? config : [config];
  return new Set(
    configs
      .flatMap((entry) =>
        readObjectEntrySources(
          entry && typeof entry === "object" && "entry" in entry ? entry.entry : undefined,
        ),
      )
      .map(normalizeRelativePath),
  );
}

/**
 * Finds local runtime require loaders not represented as explicit tsdown entries.
 */
export function findRuntimeSidecarLoaderViolations(
  content: string,
  importerPath: string,
  explicitEntrySources: Set<string>,
): RuntimeSidecarLoaderViolation[] {
  const sourceFile = ts.createSourceFile(importerPath, content, ts.ScriptTarget.Latest, true);
  const createRequireNames = new Set<string>();
  const requireNames = new Set<string>();
  const stringConstants = new Map<string, string>();
  const stringArrays = new Map<string, string[]>();
  const forOfRuntimeValues: Array<Map<string, string[]>> = [];
  const violations: RuntimeSidecarLoaderViolation[] = [];
  const seen = new Set<string>();

  const currentForOfValueMap = (): Map<string, string[]> => {
    const merged = new Map<string, string[]>();
    for (const scope of forOfRuntimeValues) {
      for (const [name, values] of scope) {
        merged.set(name, values);
      }
    }
    return merged;
  };

  const addSpecifier = (specifier: string, node: ts.Node): void => {
    if (!isLocalRuntimeSpecifier(specifier)) {
      return;
    }
    const sourcePath = resolveRuntimeSpecifierSource(importerPath, specifier);
    if (explicitEntrySources.has(sourcePath)) {
      return;
    }
    const key = `${sourcePath}:${toLine(sourceFile, node)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    violations.push({
      line: toLine(sourceFile, node),
      specifier,
      sourcePath,
      reason:
        `hidden local runtime loader "${specifier}" resolves to ${sourcePath}, ` +
        "but that source is not an explicit tsdown entry",
    });
  };

  const readRequireArgumentSpecifiers = (node: ts.CallExpression): string[] => {
    const arg = node.arguments[0];
    if (!arg) {
      return [];
    }
    const unwrapped = unwrapInitializer(arg);
    const literal = readStringLiteral(unwrapped);
    if (literal !== null) {
      return [literal];
    }
    if (ts.isIdentifier(unwrapped)) {
      const loopValues = currentForOfValueMap().get(unwrapped.text);
      if (loopValues) {
        return loopValues;
      }
      const constant = stringConstants.get(unwrapped.text);
      if (constant !== undefined) {
        return [constant];
      }
    }
    return [];
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === "node:module") {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (
              element.propertyName?.text === "createRequire" ||
              element.name.text === "createRequire"
            ) {
              createRequireNames.add(element.name.text);
            }
          }
        }
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapInitializer(node.initializer);
      const literal = readStringLiteral(initializer);
      if (literal !== null) {
        stringConstants.set(node.name.text, literal);
      }
      const arrayValues = readArrayStrings(initializer);
      if (arrayValues) {
        stringArrays.set(node.name.text, arrayValues);
      }
      if (isCreateRequireCall(initializer, createRequireNames)) {
        requireNames.add(node.name.text);
      }
    }

    if (ts.isForOfStatement(node)) {
      const initializer = node.initializer;
      const expression = unwrapInitializer(node.expression);
      if (
        ts.isVariableDeclarationList(initializer) &&
        initializer.declarations.length === 1 &&
        initializer.declarations[0] &&
        ts.isIdentifier(initializer.declarations[0].name) &&
        ts.isIdentifier(expression)
      ) {
        const values = stringArrays.get(expression.text);
        if (values) {
          forOfRuntimeValues.push(new Map([[initializer.declarations[0].name.text, values]]));
          ts.forEachChild(node.statement, visit);
          forOfRuntimeValues.pop();
          return;
        }
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      requireNames.has(node.expression.text)
    ) {
      for (const specifier of readRequireArgumentSpecifiers(node)) {
        addSpecifier(specifier, node);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/**
 * Collects runtime sidecar loader violations across configured roots.
 */
async function collectRuntimeSidecarLoaderViolations(params: {
  repoRoot: string;
  sourceRoots: string[];
  explicitEntrySources: Set<string>;
}): Promise<LocatedRuntimeSidecarLoaderViolation[]> {
  const files = await collectTypeScriptFilesFromRoots(params.sourceRoots, {
    extraTestSuffixes: [".test-support.ts", ".test-helpers.ts"],
  });
  const violations: LocatedRuntimeSidecarLoaderViolation[] = [];
  for (const filePath of files) {
    if (filePath.endsWith(".d.ts")) {
      continue;
    }
    const relativePath = normalizeRelativePath(path.relative(params.repoRoot, filePath));
    const content = await fs.readFile(filePath, "utf8");
    for (const violation of findRuntimeSidecarLoaderViolations(
      content,
      relativePath,
      params.explicitEntrySources,
    )) {
      violations.push({ path: relativePath, ...violation });
    }
  }
  return violations;
}

async function main() {
  const { default: tsdownConfig } = await import("../tsdown.config.ts");
  const violations = await collectRuntimeSidecarLoaderViolations({
    repoRoot,
    sourceRoots: defaultSourceRoots,
    explicitEntrySources: collectTsdownEntrySources(tsdownConfig),
  });
  if (violations.length === 0) {
    console.log("runtime-sidecar-loaders: local runtime sidecar loaders look OK.");
    return;
  }
  console.error("runtime-sidecar-loaders: hidden local runtime loaders found:");
  for (const violation of violations) {
    console.error(
      `- ${violation.path}:${violation.line}: ${violation.reason}. ` +
        'Use cached import("./x.runtime.js") or add the sidecar as a stable tsdown entry.',
    );
  }
  process.exitCode = 1;
}

runAsScript(import.meta.url, main);
