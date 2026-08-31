// Shared TypeScript AST and source-file helpers for guard scripts.
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type ts from "typescript";

const require = createRequire(import.meta.url);
let tsCache: typeof ts | undefined;

function getTypeScript() {
  tsCache ??= require("typescript") as typeof ts;
  return tsCache;
}

const baseTestSuffixes = [".test.ts", ".test-utils.ts", ".test-harness.ts", ".e2e-harness.ts"];

type CollectTypeScriptFilesOptions = {
  extraTestSuffixes?: string[];
  fileExtensions?: string[];
  ignoreMissing?: boolean;
  includeTests?: boolean;
  skipDirectories?: string[];
  skipNodeModules?: boolean;
};

type CollectFileViolationsParams<Violation extends object> = {
  extraTestSuffixes?: string[];
  findViolations: (content: string, filePath: string) => Iterable<Violation>;
  includeTests?: boolean;
  repoRoot: string;
  skipFile?: (filePath: string) => boolean;
  sourceRoots: string[];
};

/**
 * Converts repo-relative source roots into absolute paths.
 */
export function resolveSourceRoots(repoRoot: string, relativeRoots: string[]) {
  return relativeRoots.map((root) => path.join(repoRoot, ...root.split("/").filter(Boolean)));
}

export function isTestLikeTypeScriptFile(filePath: string, extraTestSuffixes: string[] = []) {
  return [...baseTestSuffixes, ...extraTestSuffixes].some((suffix) => filePath.endsWith(suffix));
}

/**
 * Recursively collects TypeScript files under a file or directory target.
 */
export async function collectTypeScriptFiles(
  targetPath: string,
  options: CollectTypeScriptFilesOptions = {},
): Promise<string[]> {
  const fileExtensions = options.fileExtensions ?? [".ts"];
  const includeTests = options.includeTests ?? false;
  const extraTestSuffixes = options.extraTestSuffixes ?? [];
  const skipNodeModules = options.skipNodeModules ?? true;
  const skipDirectories = options.skipDirectories ?? [];
  const ignoreMissing = options.ignoreMissing ?? false;
  const isSourceFile = (filePath: string) =>
    fileExtensions.some((extension) => filePath.endsWith(extension));

  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch (error) {
    if (
      ignoreMissing &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  if (stat.isFile()) {
    if (!isSourceFile(targetPath)) {
      return [];
    }
    if (!includeTests && isTestLikeTypeScriptFile(targetPath, extraTestSuffixes)) {
      return [];
    }
    return [targetPath];
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      if (
        (skipNodeModules && entry.name === "node_modules") ||
        skipDirectories.includes(entry.name)
      ) {
        continue;
      }
      out.push(...(await collectTypeScriptFiles(entryPath, options)));
      continue;
    }
    if (!entry.isFile() || !isSourceFile(entryPath)) {
      continue;
    }
    if (!includeTests && isTestLikeTypeScriptFile(entryPath, extraTestSuffixes)) {
      continue;
    }
    out.push(entryPath);
  }
  return out;
}

/**
 * Collects TypeScript files from multiple roots, ignoring missing roots by default.
 */
export async function collectTypeScriptFilesFromRoots(
  sourceRoots: string[],
  options: Omit<CollectTypeScriptFilesOptions, "ignoreMissing"> = {},
) {
  return (
    await Promise.all(
      sourceRoots.map(
        async (root) =>
          await collectTypeScriptFiles(root, {
            ignoreMissing: true,
            ...options,
          }),
      ),
    )
  ).flat();
}

/**
 * Runs a guard's violation scanner across collected TypeScript source files.
 */
export async function collectFileViolations<Violation extends object>(
  params: CollectFileViolationsParams<Violation>,
) {
  const files = await collectTypeScriptFilesFromRoots(params.sourceRoots, {
    includeTests: params.includeTests,
    extraTestSuffixes: params.extraTestSuffixes,
  });

  const violations: Array<Violation & { path: string }> = [];
  for (const filePath of files) {
    if (params.skipFile?.(filePath)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    const fileViolations = params.findViolations(content, filePath);
    for (const violation of fileViolations) {
      violations.push({
        path: path.relative(params.repoRoot, filePath),
        ...violation,
      });
    }
  }
  return violations;
}

/**
 * Returns the one-based source line for a TypeScript AST node.
 */
export function toLine(sourceFile: ts.SourceFile, node: ts.Node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Extracts text from identifier, string, or numeric property names.
 */
export function getPropertyNameText(name: ts.PropertyName) {
  const ts = getTypeScript();
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

/**
 * Removes harmless expression wrappers before AST shape checks.
 */
export function unwrapExpression(expression: ts.Expression) {
  const ts = getTypeScript();
  let current = expression;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Collects one-based line numbers for call expressions selected by a callback.
 */
export function collectCallExpressionLines(
  tsImpl: typeof ts,
  sourceFile: ts.SourceFile,
  resolveLineNode: (call: ts.CallExpression) => ts.Node | null | undefined,
) {
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (tsImpl.isCallExpression(node)) {
      const lineNode = resolveLineNode(node);
      if (lineNode) {
        lines.push(toLine(sourceFile, lineNode));
      }
    }
    tsImpl.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

function isDirectExecution(importMetaUrl: string) {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return path.resolve(entry) === fileURLToPath(importMetaUrl);
}

/**
 * Runs a script main function only when the module is the direct entrypoint.
 */
export function runAsScript(importMetaUrl: string, main: () => Promise<unknown>) {
  if (!isDirectExecution(importMetaUrl)) {
    return;
  }
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
