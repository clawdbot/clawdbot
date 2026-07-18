#!/usr/bin/env node

// Verifies that typed script declarations expose every runtime value export.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const SCRIPT_SOURCE_RE = /^scripts\/.+\.mjs$/u;
const SCRIPT_DECLARATION_RE = /^scripts\/.+\.d\.mts$/u;
const TYPED_SOURCE_RE = /\.(?:[cm]?ts|tsx)$/u;
const SKIPPED_DIRS = new Set([".artifacts", ".git", ".worktrees", "dist", "node_modules"]);

function normalizePath(value) {
  return value.split(path.sep).join("/").replace(/^\.\//u, "");
}

function listFilesFromGit(root) {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .map(normalizePath)
      .filter(Boolean);
  } catch {
    return null;
  }
}

function listUntrackedFilesFromGit(root) {
  try {
    return execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .map(normalizePath)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listFilesFromDirectory(root, fsImpl) {
  const files = [];
  const visit = (relativeDir) => {
    const absoluteDir = path.join(root, relativeDir);
    for (const entry of fsImpl.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) {
        continue;
      }
      const relativePath = normalizePath(path.join(relativeDir, entry.name));
      if (entry.isDirectory()) {
        visit(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  visit("");
  return files;
}

function listRepositoryFiles(root, options) {
  if (options.files) {
    return [...new Set(options.files.map(normalizePath))].toSorted((left, right) =>
      left.localeCompare(right),
    );
  }
  const gitFiles = listFilesFromGit(root);
  return (gitFiles ?? listFilesFromDirectory(root, options.fsImpl))
    .filter((relativePath) => options.fsImpl.existsSync(path.join(root, relativePath)))
    .toSorted((left, right) => left.localeCompare(right));
}

function listTypedMjsImporters(root, files, fsImpl, explicitFiles) {
  if (explicitFiles) {
    return files.filter((relativePath) => TYPED_SOURCE_RE.test(relativePath));
  }
  try {
    return execFileSync(
      "git",
      [
        "grep",
        "-l",
        "-z",
        "-F",
        ".mjs",
        "--",
        ":(glob)**/*.ts",
        ":(glob)**/*.tsx",
        ":(glob)**/*.mts",
        ":(glob)**/*.cts",
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\0")
      .map(normalizePath)
      .filter(Boolean)
      .concat(
        listUntrackedFilesFromGit(root).filter((relativePath) => {
          if (!TYPED_SOURCE_RE.test(relativePath)) {
            return false;
          }
          return fsImpl.readFileSync(path.join(root, relativePath), "utf8").includes(".mjs");
        }),
      );
  } catch (error) {
    if (error?.status === 1) {
      return [];
    }
    return files.filter((relativePath) => TYPED_SOURCE_RE.test(relativePath));
  }
}

function resolveTypedScriptImports(root, files, fsImpl, explicitFiles) {
  const requiredSources = new Set();
  for (const relativePath of listTypedMjsImporters(root, files, fsImpl, explicitFiles)) {
    const importerPath = path.join(root, relativePath);
    if (!fsImpl.existsSync(importerPath)) {
      continue;
    }
    const sourceText = fsImpl.readFileSync(importerPath, "utf8");
    const imports = ts.preProcessFile(sourceText, true, true).importedFiles;
    for (const imported of imports) {
      if (!imported.fileName.startsWith(".") || !imported.fileName.endsWith(".mjs")) {
        continue;
      }
      const absoluteTarget = path.resolve(path.dirname(importerPath), imported.fileName);
      const relativeTarget = normalizePath(path.relative(root, absoluteTarget));
      if (SCRIPT_SOURCE_RE.test(relativeTarget)) {
        requiredSources.add(relativeTarget);
      }
    }
  }
  return requiredSources;
}

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) === true;
}

function collectBindingNames(name, names) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      collectBindingNames(element.name, names);
    }
  }
}

function collectLocalBindings(sourceFile, filePath) {
  const bindings = new Map();
  const setValueBinding = (name) => {
    bindings.set(name, { kind: "value", origins: new Set([createBindingOrigin(filePath, name)]) });
  };
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      const names = new Set();
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
      for (const name of names) {
        setValueBinding(name);
      }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name
    ) {
      setValueBinding(statement.name.getText(sourceFile));
      continue;
    }
    if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      statement.name
    ) {
      if (!bindings.has(statement.name.text)) {
        bindings.set(statement.name.text, { kind: "type" });
      }
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    const specifier = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null;
    if (!specifier) {
      continue;
    }
    const clause = statement.importClause;
    if (clause.name) {
      bindings.set(clause.name.text, {
        kind: clause.isTypeOnly ? "type" : "import",
        importedName: "default",
        specifier,
      });
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings.set(clause.namedBindings.name.text, {
        kind: clause.isTypeOnly ? "type" : "namespace-import",
        specifier,
      });
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, {
          kind: clause.isTypeOnly || element.isTypeOnly ? "type" : "import",
          importedName: element.propertyName?.text ?? element.name.text,
          specifier,
        });
      }
    }
  }
  return bindings;
}

function resolveReexport(importerPath, specifier, fsImpl) {
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
    return null;
  }
  const base = path.resolve(path.dirname(importerPath), specifier);
  const declarationCandidates = [];
  if (specifier.endsWith(".mjs")) {
    declarationCandidates.push(`${base.slice(0, -".mjs".length)}.d.mts`);
  } else if (specifier.endsWith(".cjs")) {
    declarationCandidates.push(`${base.slice(0, -".cjs".length)}.d.cts`);
  } else if (specifier.endsWith(".js")) {
    declarationCandidates.push(`${base.slice(0, -".js".length)}.d.ts`);
  }
  declarationCandidates.push(`${base}.d.ts`, `${base}.d.mts`);
  const candidates = /\.d\.[cm]?ts$/u.test(importerPath)
    ? [...declarationCandidates, base]
    : [base, ...declarationCandidates];
  return candidates.find((candidate) => fsImpl.existsSync(candidate)) ?? null;
}

function mergeOrigins(target, origins) {
  for (const origin of origins) {
    target.add(origin);
  }
}

function createBindingOrigin(moduleId, name) {
  return JSON.stringify(["binding", moduleId, name]);
}

function createNamespaceOrigin(moduleId) {
  return JSON.stringify(["namespace", moduleId]);
}

function isExternalModuleSpecifier(specifier) {
  return !specifier.startsWith(".") && !path.isAbsolute(specifier);
}

function canUseOpaqueModuleBinding(target, importedName) {
  return (
    target.endsWith(".cjs") ||
    target.endsWith(".node") ||
    (target.endsWith(".json") && importedName === "default")
  );
}

function createOpaqueExternalOrigin(importerPath, specifier, kind, name = null) {
  return JSON.stringify(["opaque-external", importerPath, specifier, kind, name]);
}

function isOpaqueExternalOrigin(origin) {
  return origin.startsWith('["opaque-external",');
}

function resolveLocalBindingOrigins(binding, importerPath, fsImpl, state, issues) {
  if (!binding || binding.kind === "type") {
    return null;
  }
  if (binding.kind === "value") {
    return binding.origins;
  }
  const target = resolveReexport(importerPath, binding.specifier, fsImpl);
  if (!target) {
    if (isExternalModuleSpecifier(binding.specifier)) {
      if (/\.d\.[cm]?ts$/u.test(importerPath) && binding.kind !== "namespace-import") {
        issues.push({
          filePath: importerPath,
          specifier: binding.specifier,
          reason: "unresolved external declaration import",
        });
        return null;
      }
      return new Set([
        createOpaqueExternalOrigin(
          importerPath,
          binding.specifier,
          binding.kind === "namespace-import" ? "namespace" : "binding",
          binding.kind === "namespace-import" ? null : binding.importedName,
        ),
      ]);
    }
    issues.push({
      filePath: importerPath,
      specifier: binding.specifier,
      reason: "unresolved exported import",
    });
    return null;
  }
  if (binding.kind === "namespace-import") {
    return new Set([createNamespaceOrigin(target)]);
  }
  const targetResult = collectValueExports(target, fsImpl, state);
  issues.push(...targetResult.issues);
  if (targetResult.ambiguous.has(binding.importedName)) {
    issues.push({
      filePath: importerPath,
      specifier: `${binding.specifier}:${binding.importedName}`,
      reason: "ambiguous exported import",
    });
  }
  const origins = targetResult.exports.get(binding.importedName);
  if (origins) {
    return origins;
  }
  if (
    !/\.d\.[cm]?ts$/u.test(importerPath) &&
    canUseOpaqueModuleBinding(target, binding.importedName)
  ) {
    return new Set([createBindingOrigin(target, binding.importedName)]);
  }
  issues.push({
    filePath: importerPath,
    specifier: `${binding.specifier}:${binding.importedName}`,
    reason: "unresolved imported value",
  });
  return null;
}

function collectValueExports(filePath, fsImpl, state) {
  const normalizedFilePath = path.resolve(filePath);
  const cached = state.cache.get(normalizedFilePath);
  if (cached) {
    return cached;
  }
  if (state.visiting.has(normalizedFilePath)) {
    // Full cyclic star resolution requires a fixed point. Fail closed instead of
    // caching a partial map; script barrels can break the cycle with explicit exports.
    return {
      ambiguous: new Set(),
      exports: new Map(),
      issues: [
        {
          filePath: normalizedFilePath,
          specifier: normalizedFilePath,
          reason: "cyclic star re-export",
        },
      ],
    };
  }
  state.visiting.add(normalizedFilePath);
  const sourceText = fsImpl.readFileSync(normalizedFilePath, "utf8");
  const sourceFile = ts.createSourceFile(
    normalizedFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const localBindings = collectLocalBindings(sourceFile, normalizedFilePath);
  const isDeclaration = /\.d\.[cm]?ts$/u.test(normalizedFilePath);
  const explicitExports = new Map();
  const explicitAmbiguous = new Set();
  const starResults = [];
  const issues = [];
  const setExplicitExport = (name, origins) => {
    explicitExports.set(name, origins ?? new Set([createBindingOrigin(normalizedFilePath, name)]));
  };
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      const binding = ts.isIdentifier(statement.expression)
        ? localBindings.get(statement.expression.text)
        : null;
      setExplicitExport("default", binding?.kind === "value" ? binding.origins : undefined);
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) {
        continue;
      }
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) {
            continue;
          }
          const exportedName = element.name.text;
          const sourceName = element.propertyName?.text ?? exportedName;
          const specifier = statement.moduleSpecifier;
          if (specifier && ts.isStringLiteral(specifier)) {
            const target = resolveReexport(normalizedFilePath, specifier.text, fsImpl);
            const targetResult = target ? collectValueExports(target, fsImpl, state) : null;
            if (targetResult) {
              issues.push(...targetResult.issues);
            }
            const origins = targetResult?.exports.get(sourceName);
            if (origins) {
              explicitExports.set(exportedName, origins);
            } else if (targetResult?.ambiguous.has(sourceName)) {
              explicitAmbiguous.add(exportedName);
              issues.push({
                filePath: normalizedFilePath,
                specifier: `${specifier.text}:${sourceName}`,
                reason: "ambiguous named re-export",
              });
            } else if (!target && isExternalModuleSpecifier(specifier.text)) {
              if (isDeclaration) {
                issues.push({
                  filePath: normalizedFilePath,
                  specifier: specifier.text,
                  reason: "unresolved external declaration re-export",
                });
              } else {
                explicitExports.set(
                  exportedName,
                  new Set([
                    createOpaqueExternalOrigin(
                      normalizedFilePath,
                      specifier.text,
                      "binding",
                      sourceName,
                    ),
                  ]),
                );
              }
            } else if (!target) {
              if (!isDeclaration) {
                explicitExports.set(
                  exportedName,
                  new Set([createBindingOrigin(specifier.text, sourceName)]),
                );
              } else {
                issues.push({
                  filePath: normalizedFilePath,
                  specifier: specifier.text,
                  reason: "unresolved named re-export",
                });
              }
            } else if (!isDeclaration && canUseOpaqueModuleBinding(target, sourceName)) {
              explicitExports.set(exportedName, new Set([createBindingOrigin(target, sourceName)]));
            } else {
              issues.push({
                filePath: normalizedFilePath,
                specifier: `${specifier.text}:${sourceName}`,
                reason: "unresolved named re-export",
              });
            }
          } else {
            const origins = resolveLocalBindingOrigins(
              localBindings.get(sourceName),
              normalizedFilePath,
              fsImpl,
              state,
              issues,
            );
            if (origins) {
              explicitExports.set(exportedName, origins);
            }
          }
        }
        continue;
      }
      if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        const specifier = statement.moduleSpecifier;
        const target =
          specifier && ts.isStringLiteral(specifier)
            ? resolveReexport(normalizedFilePath, specifier.text, fsImpl)
            : null;
        const externalSpecifier =
          specifier && ts.isStringLiteral(specifier) && isExternalModuleSpecifier(specifier.text)
            ? specifier.text
            : null;
        setExplicitExport(
          statement.exportClause.name.text,
          new Set([
            target
              ? createNamespaceOrigin(target)
              : externalSpecifier
                ? createOpaqueExternalOrigin(normalizedFilePath, externalSpecifier, "namespace")
                : createNamespaceOrigin(specifier?.getText(sourceFile) ?? normalizedFilePath),
          ]),
        );
        continue;
      }
      const specifier = statement.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) {
        const target = resolveReexport(normalizedFilePath, specifier.text, fsImpl);
        if (target) {
          const targetResult = collectValueExports(target, fsImpl, state);
          starResults.push(targetResult);
          issues.push(...targetResult.issues);
        } else {
          issues.push({
            filePath: normalizedFilePath,
            specifier: specifier.text,
            reason: "unresolved star re-export",
          });
        }
      }
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      continue;
    }
    if (
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword) &&
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
    ) {
      const binding = statement.name ? localBindings.get(statement.name.text) : null;
      setExplicitExport("default", binding?.kind === "value" ? binding.origins : undefined);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const names = new Set();
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
      for (const name of names) {
        setExplicitExport(name);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name
    ) {
      setExplicitExport(statement.name.getText(sourceFile));
    }
  }

  const exports = new Map(explicitExports);
  const starOrigins = new Map();
  const ambiguous = new Set(explicitAmbiguous);
  for (const targetResult of starResults) {
    for (const name of targetResult.ambiguous) {
      if (name !== "default" && !explicitExports.has(name)) {
        ambiguous.add(name);
      }
    }
    for (const [name, origins] of targetResult.exports) {
      if (name === "default" || explicitExports.has(name) || explicitAmbiguous.has(name)) {
        continue;
      }
      const merged = starOrigins.get(name) ?? new Set();
      mergeOrigins(merged, origins);
      starOrigins.set(name, merged);
    }
  }
  for (const [name, origins] of starOrigins) {
    // ESM omits a name when multiple star exports resolve to different bindings.
    if (origins.size > 1) {
      ambiguous.add(name);
      if ([...origins].some(isOpaqueExternalOrigin)) {
        issues.push({
          filePath: normalizedFilePath,
          specifier: name,
          reason: "opaque external star collision",
        });
      }
    } else if (!ambiguous.has(name)) {
      exports.set(name, origins);
    }
  }

  const result = { ambiguous, exports, issues };
  state.visiting.delete(normalizedFilePath);
  state.cache.set(normalizedFilePath, result);
  return result;
}

function analyzeValueExportContract(filePath, fsImpl) {
  const result = collectValueExports(filePath, fsImpl, {
    cache: new Map(),
    visiting: new Set(),
  });
  const names = [...result.exports.keys()].toSorted((left, right) => left.localeCompare(right));
  return {
    contract: Buffer.from(names.map((name) => `${name}\n`).join(""), "utf8"),
    issues: result.issues,
  };
}

/** Generates the canonical byte representation of a module's runtime value exports. */
export function generateValueExportContract(filePath, options = {}) {
  const fsImpl = options.fsImpl ?? { existsSync, readFileSync };
  const result = analyzeValueExportContract(filePath, fsImpl);
  if (result.issues.length > 0) {
    throw new Error(result.issues.map((issue) => issue.reason).join(", "));
  }
  return result.contract;
}

function formatContract(contract) {
  return contract.toString("utf8").trim().split("\n").filter(Boolean);
}

/** Regenerates and byte-compares every script runtime/declaration value-export contract. */
export function verifyScriptDeclarationContracts(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const fsImpl = options.fsImpl ?? {
    existsSync,
    readFileSync,
    readdirSync,
  };
  const files = listRepositoryFiles(root, { ...options, fsImpl });
  const sourcePaths = new Set(
    files
      .filter((relativePath) => SCRIPT_DECLARATION_RE.test(relativePath))
      .map((declarationPath) => declarationPath.slice(0, -".d.mts".length) + ".mjs"),
  );
  for (const sourcePath of resolveTypedScriptImports(root, files, fsImpl, Boolean(options.files))) {
    sourcePaths.add(sourcePath);
  }

  const issues = [];
  const pairs = [];
  for (const sourcePath of [...sourcePaths].toSorted((left, right) => left.localeCompare(right))) {
    const declarationPath = sourcePath.slice(0, -".mjs".length) + ".d.mts";
    if (!fsImpl.existsSync(path.join(root, sourcePath))) {
      issues.push(`${sourcePath}: missing runtime source`);
      continue;
    }
    if (!fsImpl.existsSync(path.join(root, declarationPath))) {
      issues.push(`${sourcePath}: missing ${declarationPath}`);
      continue;
    }
    pairs.push({ sourcePath, declarationPath });
  }

  for (const { sourcePath, declarationPath } of pairs) {
    const runtimeAnalysis = analyzeValueExportContract(path.join(root, sourcePath), fsImpl);
    const declarationAnalysis = analyzeValueExportContract(
      path.join(root, declarationPath),
      fsImpl,
    );
    const analysisIssues = [...runtimeAnalysis.issues, ...declarationAnalysis.issues];
    if (analysisIssues.length > 0) {
      for (const issue of analysisIssues) {
        const issuePath = normalizePath(path.relative(root, issue.filePath));
        issues.push(`${issuePath}: ${issue.reason} ${JSON.stringify(issue.specifier)}`);
      }
      continue;
    }
    const runtimeContract = runtimeAnalysis.contract;
    const declarationContract = declarationAnalysis.contract;
    if (runtimeContract.equals(declarationContract)) {
      continue;
    }
    const runtimeExports = new Set(formatContract(runtimeContract));
    const declarationExports = new Set(formatContract(declarationContract));
    const missing = [...runtimeExports].filter((name) => !declarationExports.has(name));
    const extra = [...declarationExports].filter((name) => !runtimeExports.has(name));
    issues.push(
      `${declarationPath}: value-export contract drift` +
        (missing.length > 0 ? `; missing ${missing.join(", ")}` : "") +
        (extra.length > 0 ? `; extra ${extra.join(", ")}` : ""),
    );
  }

  return { checked: pairs.length, issues };
}

function main() {
  const result = verifyScriptDeclarationContracts();
  if (result.issues.length > 0) {
    for (const issue of result.issues) {
      console.error(`[script-declarations] ${issue}`);
    }
    console.error(
      "[script-declarations] update the adjacent .d.mts contract before merging script exports",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[script-declarations] ${result.checked} declaration contracts match`);
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main();
}
