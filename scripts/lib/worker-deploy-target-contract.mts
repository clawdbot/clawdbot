import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ARTIFACT_NAME = /^WORKER_BUNDLE_[A-Z0-9_]+_PATH$/u;
const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function readWorkerDeployTargetPaths(targetRoot: string): string[] {
  const sourcePath = join(targetRoot, "src/shared/worker-bundle-hash.ts");
  const sourceStat = lstatSync(sourcePath);
  if (!sourceStat.isFile() || sourceStat.size > 64 * 1024) {
    throw new Error("Target worker artifact declarations are invalid.");
  }
  const sourceText = readFileSync(sourcePath, "utf8");
  const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest);
  const artifacts: Array<[string, string]> = [];
  for (const statement of source.statements.filter(ts.isVariableStatement)) {
    if (statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = ts.isIdentifier(declaration.name) ? declaration.name.text : "";
        if (ARTIFACT_NAME.test(name)) {
          const artifact =
            declaration.initializer && ts.isStringLiteral(declaration.initializer)
              ? declaration.initializer.text
              : null;
          if (
            !(statement.declarationList.flags & ts.NodeFlags.Const) ||
            artifact === null ||
            !SAFE_BASENAME.test(artifact) ||
            artifacts.some(([declaredName, path]) => declaredName === name || path === artifact)
          ) {
            throw new Error(`Target worker artifact declaration is invalid: ${name}.`);
          }
          artifacts.push([name, artifact]);
        }
      }
    }
  }
  if (artifacts.length < 2 || artifacts.length > 16) {
    throw new Error("Target worker artifact count must be between 2 and 16.");
  }
  return artifacts.map(([, path]) => `dist/worker/${path}`).toSorted();
}
