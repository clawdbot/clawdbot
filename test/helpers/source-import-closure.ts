import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const config = ts.readConfigFile(
  path.join(repoRoot, "tsconfig.json"),
  ts.sys.readFile.bind(ts.sys),
);
if (config.error) {
  throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
}
const { options, errors } = ts.convertCompilerOptionsFromJson(
  config.config.compilerOptions,
  repoRoot,
);
if (errors.length) {
  throw new Error(
    errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"),
  );
}

function resolveSourceModule(importer: string, specifier: string): string | undefined {
  // This guard owns repository source, including workspace package and SDK aliases.
  // Node builtins and installed external packages are terminal dependencies.
  const mapped = Object.keys(options.paths ?? {}).some((pattern) => {
    const [prefix, suffix] = pattern.split("*");
    return suffix === undefined
      ? specifier === prefix
      : specifier.startsWith(prefix!) && specifier.endsWith(suffix);
  });
  const workspacePackage =
    specifier.startsWith("@openclaw/") &&
    fs.existsSync(path.join(repoRoot, "packages", specifier.split("/")[1]!, "package.json"));
  if (
    !specifier.startsWith(".") &&
    !path.isAbsolute(specifier) &&
    !mapped &&
    !specifier.startsWith("openclaw/") &&
    !workspacePackage
  ) {
    return undefined;
  }
  const resolved = ts.resolveModuleName(specifier, importer, options, ts.sys).resolvedModule
    ?.resolvedFileName;
  if (!resolved) {
    throw new Error(
      `Unresolved source import: ${path.relative(repoRoot, importer)} -> ${specifier}`,
    );
  }
  // JSON data and declarations cannot introduce runtime imports.
  return resolved.endsWith(".json") || resolved.endsWith(".d.ts") ? undefined : resolved;
}

function staticDependencies(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const dependencies: string[] = [];
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit);
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
          ? node.moduleReference.expression
          : ts.isCallExpression(node) &&
              ts.isIdentifier(node.expression) &&
              node.expression.text === "require"
            ? node.arguments[0]
            : undefined;
    if (specifier && ts.isStringLiteralLike(specifier)) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (
          clause?.isTypeOnly ||
          (clause &&
            !clause.name &&
            clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((binding) => binding.isTypeOnly))
        ) {
          return;
        }
      } else if (ts.isExportDeclaration(node)) {
        if (
          node.isTypeOnly ||
          (node.exportClause &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((binding) => binding.isTypeOnly))
        ) {
          return;
        }
      } else if (ts.isImportEqualsDeclaration(node) && node.isTypeOnly) {
        return;
      }
      const resolved = resolveSourceModule(file, specifier.text);
      if (resolved) {
        dependencies.push(resolved);
      }
    }
  };
  visit(source);
  return dependencies;
}

export function findSourceImportBackedges(entry: string, forbidden: readonly string[]): string[] {
  const pending = [{ file: path.join(repoRoot, entry), parents: [] as string[] }];
  const visited = new Set<string>();
  const violations: string[] = [];
  for (const { file, parents } of pending) {
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const chain = [...parents, file];
    if (forbidden.includes(path.relative(repoRoot, file).split(path.sep).join("/"))) {
      violations.push(chain.map((part) => path.relative(repoRoot, part)).join(" -> "));
      continue;
    }
    for (const dependency of staticDependencies(file)) {
      pending.push({ file: dependency, parents: chain });
    }
  }
  return violations;
}
