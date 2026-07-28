/**
 * Resolves the repository root by walking upward from the caller module.
 */
export function resolveRepoRoot(importMetaUrl: string): string;
/**
 * Converts repo-relative source roots into absolute paths.
 */
export function resolveSourceRoots(repoRoot: string, relativeRoots: string[]): string[];
/**
 * Recursively collects TypeScript files under a file or directory target.
 */
export function collectTypeScriptFiles(
  targetPath: string,
  options?: {
    extraTestSuffixes?: string[];
    ignoreMissing?: boolean;
    includeTests?: boolean;
    skipNodeModules?: boolean;
  },
): Promise<string[]>;
/**
 * Collects TypeScript files from multiple roots, ignoring missing roots by default.
 */
export function collectTypeScriptFilesFromRoots(
  sourceRoots: string[],
  options?: {
    extraTestSuffixes?: string[];
    includeTests?: boolean;
    skipNodeModules?: boolean;
  },
): Promise<string[]>;
/**
 * Runs a guard's violation scanner across collected TypeScript source files.
 */
export function collectFileViolations(params: unknown): Promise<unknown[]>;
/**
 * Returns the one-based source line for a TypeScript AST node.
 */
export function toLine(sourceFile: ts.SourceFile, node: ts.Node): number;
/**
 * Extracts text from identifier, string, or numeric property names.
 */
export function getPropertyNameText(name: ts.PropertyName): string | null;
/**
 * Removes harmless expression wrappers before AST shape checks.
 */
export function unwrapExpression(expression: ts.Expression): ts.Expression;
/**
 * Collects one-based line numbers for call expressions selected by a callback.
 */
export function collectCallExpressionLines(
  tsImpl: typeof ts,
  sourceFile: ts.SourceFile,
  resolveLineNode: (call: ts.CallExpression) => ts.Node | null | undefined,
): number[];
/**
 * Runs a script main function only when the module is the direct entrypoint.
 */
export function runAsScript(importMetaUrl: string, main: () => Promise<unknown>): void;
import type ts from "typescript";
