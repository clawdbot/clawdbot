#!/usr/bin/env node

import path from "node:path";
import ts from "typescript";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { collectSourceFileContents } from "./lib/source-file-scan-cache.mts";
import {
  isTestLikeTypeScriptFile,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mts";

export type ExportNameCollision = {
  name: string;
  files: string[];
  sdk?: true;
};

export type SourceModule = {
  content: string;
  includeDefinitions?: boolean;
  path: string;
};

export type ImportedSymbolReference = {
  importedName: string;
  localName: string;
  moduleSpecifier: string;
};

export type NamedReExport = {
  exportedName: string;
  importedName: string;
  moduleSpecifier: string;
};

export type AliasingReExport = NamedReExport & {
  line: number;
  path: string;
};

export type ExportedValueDefinition = {
  importedReferences: ImportedSymbolReference[];
  name: string;
};

export type ModuleExports = {
  aliasingReExports: Array<Omit<AliasingReExport, "path">>;
  definitions: Set<string>;
  exportedNames: Set<string>;
  namedReExports: NamedReExport[];
  starExportSpecifiers: string[];
  valueDefinitions: Map<string, ExportedValueDefinition>;
};

const failurePrefix = "check-export-name-collisions";
const extraExcludedFileSuffixes = [".test-support.ts", ".test-helpers.ts", ".d.ts"];

function normalizeRelativePath(filePath: string) {
  return filePath.replaceAll(path.sep, "/");
}

export function isExcludedExportCollisionSource(filePath: string) {
  const normalized = normalizeRelativePath(filePath);
  const segments = normalized.split("/");
  return (
    segments.includes("test") ||
    segments.includes("__fixtures__") ||
    isTestLikeTypeScriptFile(normalized, extraExcludedFileSuffixes)
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((item) => item.kind === kind);
}

function collectBindingNames(name: ts.BindingName, names: Set<string>) {
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

function resolveImportedReference(
  expression: ts.Expression,
  importedSymbolsByLocalName: ReadonlyMap<string, ImportedSymbolReference>,
  namespaceImportsByLocalName: ReadonlyMap<string, string>,
) {
  const target = unwrapExpression(expression);
  if (ts.isIdentifier(target)) {
    return importedSymbolsByLocalName.get(target.text);
  }
  if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) {
    return undefined;
  }
  const namespaceName = ts.isPropertyAccessExpression(target)
    ? target.name.text
    : ts.isElementAccessExpression(target) &&
        target.argumentExpression &&
        ts.isStringLiteral(target.argumentExpression)
      ? target.argumentExpression.text
      : null;
  if (!namespaceName || !ts.isIdentifier(target.expression)) {
    return undefined;
  }
  const moduleSpecifier = namespaceImportsByLocalName.get(target.expression.text);
  return moduleSpecifier
    ? {
        importedName: namespaceName,
        localName: `${target.expression.text}.${namespaceName}`,
        moduleSpecifier,
      }
    : undefined;
}

function collectImportedReferences(
  node: ts.Node,
  importedSymbolsByLocalName: ReadonlyMap<string, ImportedSymbolReference>,
  namespaceImportsByLocalName: ReadonlyMap<string, string>,
) {
  const references = new Map<string, ImportedSymbolReference>();
  const addReference = (reference: ImportedSymbolReference | undefined) => {
    if (reference) {
      references.set(
        `${reference.moduleSpecifier}\0${reference.importedName}\0${reference.localName}`,
        reference,
      );
    }
  };
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current)) {
      addReference(
        resolveImportedReference(
          current.expression,
          importedSymbolsByLocalName,
          namespaceImportsByLocalName,
        ),
      );
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return [...references.values()].toSorted((left, right) =>
    `${left.moduleSpecifier}\0${left.importedName}\0${left.localName}`.localeCompare(
      `${right.moduleSpecifier}\0${right.importedName}\0${right.localName}`,
    ),
  );
}

function parametersAreForwarded(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  args: ts.NodeArray<ts.Expression>,
) {
  if (parameters.length !== args.length) {
    return false;
  }
  return parameters.every((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) {
      return false;
    }
    const argument = args[index];
    if (!argument) {
      return false;
    }
    if (parameter.dotDotDotToken) {
      if (!ts.isSpreadElement(argument)) {
        return false;
      }
      const forwarded = unwrapExpression(argument.expression);
      return ts.isIdentifier(forwarded) && forwarded.text === parameter.name.text;
    }
    if (ts.isSpreadElement(argument)) {
      return false;
    }
    const forwarded = unwrapExpression(argument);
    return ts.isIdentifier(forwarded) && forwarded.text === parameter.name.text;
  });
}

function isAwaitedZeroArgumentCall(expression: ts.Expression) {
  const unwrapped = unwrapExpression(expression);
  if (!ts.isAwaitExpression(unwrapped)) {
    return false;
  }
  const awaited = unwrapExpression(unwrapped.expression);
  return ts.isCallExpression(awaited) && awaited.arguments.length === 0;
}

function returnCall(statement: ts.Statement | undefined) {
  if (!statement || !ts.isReturnStatement(statement) || !statement.expression) {
    return null;
  }
  const expression = unwrapExpression(statement.expression);
  return ts.isCallExpression(expression) ? expression : null;
}

function isStaticImportForwarder(
  call: ts.CallExpression,
  functionName: string,
  importedNamesByLocalName: ReadonlyMap<string, string>,
) {
  const callee = unwrapExpression(call.expression);
  return (
    ts.isIdentifier(callee) &&
    callee.text !== functionName &&
    importedNamesByLocalName.get(callee.text) === functionName
  );
}

function isLazyModuleForwarderCall(
  call: ts.CallExpression,
  functionName: string,
  moduleObjectName?: string,
) {
  const callee = unwrapExpression(call.expression);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== functionName) {
    return false;
  }
  const target = unwrapExpression(callee.expression);
  if (moduleObjectName) {
    return ts.isIdentifier(target) && target.text === moduleObjectName;
  }
  return isAwaitedZeroArgumentCall(target);
}

function isForwardingOnlyFunction(
  declaration: ts.FunctionDeclaration | ts.ArrowFunction,
  functionName: string,
  importedNamesByLocalName: ReadonlyMap<string, string>,
) {
  const body = declaration.body;
  if (!body) {
    return false;
  }
  let call: ts.CallExpression | null;
  let moduleObjectName: string | undefined;
  if (!ts.isBlock(body)) {
    const expression = unwrapExpression(body);
    call = ts.isCallExpression(expression) ? expression : null;
  } else if (body.statements.length === 1 || body.statements.length === 2) {
    if (body.statements.length === 2) {
      const loadStatement = body.statements[0];
      if (!loadStatement || !ts.isVariableStatement(loadStatement)) {
        return false;
      }
      const { declarations, flags } = loadStatement.declarationList;
      const [loaded] = declarations;
      if (
        !(flags & ts.NodeFlags.Const) ||
        declarations.length !== 1 ||
        !loaded ||
        !ts.isIdentifier(loaded.name) ||
        !loaded.initializer ||
        !isAwaitedZeroArgumentCall(loaded.initializer)
      ) {
        return false;
      }
      moduleObjectName = loaded.name.text;
    }
    call = returnCall(body.statements.at(-1));
  } else {
    return false;
  }
  return Boolean(
    call &&
    parametersAreForwarded(declaration.parameters, call.arguments) &&
    ((!moduleObjectName && isStaticImportForwarder(call, functionName, importedNamesByLocalName)) ||
      isLazyModuleForwarderCall(call, functionName, moduleObjectName)),
  );
}

function isForwardingOnlyConst(
  declaration: ts.VariableDeclaration,
  exportName: string,
  importedNamesByLocalName: ReadonlyMap<string, string>,
  lazyRuntimeMethods: ReadonlyMap<string, number>,
) {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
    return false;
  }
  const initializer = unwrapExpression(declaration.initializer);
  if (ts.isIdentifier(initializer)) {
    return importedNamesByLocalName.get(initializer.text) === exportName;
  }
  if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)) {
    const arity = lazyRuntimeMethods.get(initializer.expression.text);
    const selector = initializer.arguments.at(-1);
    if (
      arity !== initializer.arguments.length ||
      !selector ||
      !ts.isArrowFunction(selector) ||
      ts.isBlock(selector.body)
    ) {
      return false;
    }
    const [parameter] = selector.parameters;
    const member = unwrapExpression(selector.body);
    return (
      selector.parameters.length === 1 &&
      parameter !== undefined &&
      !parameter.initializer &&
      !parameter.dotDotDotToken &&
      ts.isIdentifier(parameter.name) &&
      ts.isPropertyAccessExpression(member) &&
      ts.isIdentifier(member.expression) &&
      member.expression.text === parameter.name.text &&
      member.name.text === exportName
    );
  }
  return (
    ts.isArrowFunction(initializer) &&
    isForwardingOnlyFunction(initializer, exportName, importedNamesByLocalName)
  );
}

/** Collects value exports and locally defined exported functions/consts from one module. */
export function collectModuleExportNames(content: string, fileName = "source.ts"): ModuleExports {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const importedNamesByLocalName = new Map<string, string>();
  const importedSymbolsByLocalName = new Map<string, ImportedSymbolReference>();
  const namespaceImportsByLocalName = new Map<string, string>();
  const localConstDeclarations = new Map<string, ts.VariableDeclaration[]>();
  const localFunctions = new Map<string, ts.FunctionDeclaration[]>();
  const directlyExportedNames = new Set<string>();
  const locallyExportedNames = new Set<string>();
  const exportedNames = new Set<string>();
  const aliasingReExports: Array<Omit<AliasingReExport, "path">> = [];
  const namedReExports: NamedReExport[] = [];
  const pendingLocalReExports: Array<{ exportedName: string; localName: string }> = [];
  const starExportSpecifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          if (!statement.importClause?.isTypeOnly && !specifier.isTypeOnly) {
            const importedName = specifier.propertyName?.text ?? specifier.name.text;
            const moduleSpecifier = ts.isStringLiteral(statement.moduleSpecifier)
              ? statement.moduleSpecifier.text
              : "";
            importedNamesByLocalName.set(specifier.name.text, importedName);
            importedSymbolsByLocalName.set(specifier.name.text, {
              importedName,
              localName: specifier.name.text,
              moduleSpecifier,
            });
          }
        }
      } else if (
        bindings &&
        ts.isNamespaceImport(bindings) &&
        !statement.importClause?.isTypeOnly &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        namespaceImportsByLocalName.set(bindings.name.text, statement.moduleSpecifier.text);
      }
      continue;
    }

    if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression &&
      ts.isStringLiteral(statement.moduleReference.expression)
    ) {
      namespaceImportsByLocalName.set(
        statement.name.text,
        statement.moduleReference.expression.text,
      );
      continue;
    }

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      const declarations = localFunctions.get(name) ?? [];
      declarations.push(statement);
      localFunctions.set(name, declarations);
      if (
        hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
        !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
      ) {
        directlyExportedNames.add(name);
        exportedNames.add(name);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      const isConst = Boolean(statement.declarationList.flags & ts.NodeFlags.Const);
      if (!isConst) {
        continue;
      }
      const statementNames = new Set<string>();
      for (const declaration of statement.declarationList.declarations) {
        const declarationNames = new Set<string>();
        collectBindingNames(declaration.name, declarationNames);
        for (const name of declarationNames) {
          statementNames.add(name);
          const declarations = localConstDeclarations.get(name) ?? [];
          declarations.push(declaration);
          localConstDeclarations.set(name, declarations);
        }
      }
      for (const name of statementNames) {
        if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
          directlyExportedNames.add(name);
          exportedNames.add(name);
        }
      }
      continue;
    }

    const moduleSpecifier = ts.isExportDeclaration(statement)
      ? statement.moduleSpecifier
      : undefined;
    if (
      ts.isExportDeclaration(statement) &&
      !statement.exportClause &&
      moduleSpecifier &&
      ts.isStringLiteral(moduleSpecifier)
    ) {
      starExportSpecifiers.push(moduleSpecifier.text);
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      !statement.isTypeOnly
    ) {
      for (const specifier of statement.exportClause.elements) {
        if (specifier.isTypeOnly) {
          continue;
        }
        const localName = specifier.propertyName?.text ?? specifier.name.text;
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          const reExport = {
            exportedName: specifier.name.text,
            importedName: localName,
            moduleSpecifier: statement.moduleSpecifier.text,
          };
          namedReExports.push(reExport);
          if (reExport.exportedName !== reExport.importedName) {
            aliasingReExports.push({ ...reExport, line: toLine(sourceFile, specifier) });
          }
        } else if (!statement.moduleSpecifier) {
          pendingLocalReExports.push({ exportedName: specifier.name.text, localName });
        }
        if (specifier.name.text !== localName) {
          continue;
        }
        exportedNames.add(specifier.name.text);
        if (!statement.moduleSpecifier) {
          locallyExportedNames.add(localName);
        }
      }
    }
  }

  for (const reExport of pendingLocalReExports) {
    const imported = importedSymbolsByLocalName.get(reExport.localName);
    if (imported) {
      namedReExports.push({
        exportedName: reExport.exportedName,
        importedName: imported.importedName,
        moduleSpecifier: imported.moduleSpecifier,
      });
    }
  }

  // Only the shared helpers guarantee transparent argument forwarding; a same-named
  // factory from another module or a selector that adds behavior remains a definition.
  const lazyRuntimeMethods = new Map<string, number>();
  for (const reference of importedSymbolsByLocalName.values()) {
    const source = reference.moduleSpecifier.startsWith(".")
      ? path.posix.normalize(
          path.posix.join(path.posix.dirname(fileName), reference.moduleSpecifier),
        )
      : reference.moduleSpecifier;
    if (
      ![
        "src/shared/lazy-runtime.js",
        "src/plugin-sdk/lazy-runtime.js",
        "openclaw/plugin-sdk/lazy-runtime",
        "@openclaw/plugin-sdk/lazy-runtime",
      ].includes(source)
    ) {
      continue;
    }
    if (reference.importedName === "createLazyRuntimeMethod") {
      lazyRuntimeMethods.set(reference.localName, 2);
    } else if (reference.importedName === "createLazyRuntimeMethodBinder") {
      for (const [name, declarations] of localConstDeclarations) {
        const [declaration] = declarations;
        const initializer = declaration?.initializer;
        if (
          declarations.length === 1 &&
          declaration &&
          ts.isIdentifier(declaration.name) &&
          initializer &&
          ts.isCallExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          initializer.expression.text === reference.localName &&
          initializer.arguments.length === 1
        ) {
          lazyRuntimeMethods.set(name, 1);
        }
      }
    }
  }

  const definitions = new Set<string>();
  const valueDefinitions = new Map<string, ExportedValueDefinition>();
  for (const name of new Set([...directlyExportedNames, ...locallyExportedNames])) {
    const constDeclarations = localConstDeclarations.get(name);
    if (constDeclarations) {
      const [constDeclaration] = constDeclarations;
      if (constDeclarations.length === 1 && constDeclaration) {
        const importedReferences = collectImportedReferences(
          constDeclaration,
          importedSymbolsByLocalName,
          namespaceImportsByLocalName,
        );
        const initializer = constDeclaration.initializer
          ? unwrapExpression(constDeclaration.initializer)
          : undefined;
        if (initializer) {
          const aliasSource = resolveImportedReference(
            initializer,
            importedSymbolsByLocalName,
            namespaceImportsByLocalName,
          );
          if (aliasSource) {
            importedReferences.push(aliasSource);
          }
        }
        valueDefinitions.set(name, {
          importedReferences: importedReferences.toSorted((left, right) =>
            `${left.moduleSpecifier}\0${left.importedName}\0${left.localName}`.localeCompare(
              `${right.moduleSpecifier}\0${right.importedName}\0${right.localName}`,
            ),
          ),
          name,
        });
      }
      if (
        constDeclarations.length === 1 &&
        constDeclaration &&
        isForwardingOnlyConst(constDeclaration, name, importedNamesByLocalName, lazyRuntimeMethods)
      ) {
        continue;
      }
      definitions.add(name);
      continue;
    }
    const functionDeclarations = localFunctions.get(name);
    if (!functionDeclarations) {
      continue;
    }
    const implementation = functionDeclarations.find((declaration) => declaration.body);
    if (implementation?.body) {
      valueDefinitions.set(name, {
        importedReferences: collectImportedReferences(
          implementation.body,
          importedSymbolsByLocalName,
          namespaceImportsByLocalName,
        ),
        name,
      });
    }
    // Lazy runtime facades are mandated by AGENTS.md. Exempt only exact same-name
    // argument forwarding so those boundaries do not become duplicate behavior.
    if (
      implementation &&
      isForwardingOnlyFunction(implementation, name, importedNamesByLocalName)
    ) {
      continue;
    }
    definitions.add(name);
  }

  return {
    aliasingReExports,
    definitions,
    exportedNames,
    namedReExports: namedReExports.toSorted((left, right) =>
      `${left.exportedName}\0${left.importedName}\0${left.moduleSpecifier}`.localeCompare(
        `${right.exportedName}\0${right.importedName}\0${right.moduleSpecifier}`,
      ),
    ),
    starExportSpecifiers,
    valueDefinitions,
  };
}

export function resolveExportModulePath(
  sourcePath: string,
  specifier: string,
  modulesByPath: ReadonlyMap<string, ModuleExports>,
) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const unresolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourcePath), specifier),
  );
  const extensionless = unresolved.replace(/\.(?:c|m)?(?:j|t)s$/u, "");
  const candidates = [
    `${extensionless}.ts`,
    `${extensionless}.mts`,
    `${extensionless}.js`,
    `${extensionless}.mjs`,
    `${extensionless}/index.ts`,
    `${extensionless}/index.mts`,
    `${extensionless}/index.js`,
    `${extensionless}/index.mjs`,
  ];
  return candidates.find((candidate) => modulesByPath.has(candidate)) ?? null;
}

function collectTransitiveExportNames(
  modulePath: string,
  modulesByPath: ReadonlyMap<string, ModuleExports>,
  visiting = new Set<string>(),
): Set<string> {
  if (visiting.has(modulePath)) {
    return new Set();
  }
  const moduleExports = modulesByPath.get(modulePath);
  if (!moduleExports) {
    return new Set();
  }
  const nextVisiting = new Set(visiting).add(modulePath);
  const names = new Set(moduleExports.exportedNames);
  for (const specifier of moduleExports.starExportSpecifiers) {
    const targetPath = resolveExportModulePath(modulePath, specifier, modulesByPath);
    if (!targetPath) {
      continue;
    }
    for (const name of collectTransitiveExportNames(targetPath, modulesByPath, nextVisiting)) {
      names.add(name);
    }
  }
  return names;
}

// Per-module test-hook namespaces are an intentional same-name family: each module
// exports its own `testing`/`testApi` object and tests import it qualified from that
// exact module. Flagging them would push burn-down work to "fix" a deliberate idiom.
const intentionalSameNameFamilies = new Set(["testing", "testApi"]);

function analyzeExportNames(modules: SourceModule[]) {
  const aliasingReExports: AliasingReExport[] = [];
  const filesByName = new Map<string, Set<string>>();
  const sdkExportNames = new Set<string>();
  const modulesByPath = new Map<string, ModuleExports>();
  for (const sourceModule of modules.toSorted((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const relativePath = normalizeRelativePath(sourceModule.path);
    const moduleExports = collectModuleExportNames(sourceModule.content, relativePath);
    modulesByPath.set(relativePath, moduleExports);
    if (sourceModule.includeDefinitions !== false && !relativePath.startsWith("src/plugin-sdk/")) {
      aliasingReExports.push(
        ...moduleExports.aliasingReExports.map((reExport) => ({
          ...reExport,
          path: relativePath,
        })),
      );
    }
    if (sourceModule.includeDefinitions !== false) {
      for (const name of moduleExports.definitions) {
        const files = filesByName.get(name) ?? new Set<string>();
        files.add(relativePath);
        filesByName.set(name, files);
      }
    }
  }
  for (const modulePath of modulesByPath.keys()) {
    if (!modulePath.startsWith("src/plugin-sdk/")) {
      continue;
    }
    for (const name of collectTransitiveExportNames(modulePath, modulesByPath)) {
      sdkExportNames.add(name);
    }
  }

  const collisions: ExportNameCollision[] = [];
  for (const [name, fileSet] of filesByName) {
    if (fileSet.size < 2 || intentionalSameNameFamilies.has(name)) {
      continue;
    }
    const collision: ExportNameCollision = {
      name,
      files: [...fileSet].toSorted(),
    };
    if (sdkExportNames.has(name)) {
      collision.sdk = true;
    }
    collisions.push(collision);
  }
  return {
    aliasingReExports: aliasingReExports.toSorted(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.exportedName.localeCompare(right.exportedName),
    ),
    collisions: collisions.toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}

/** Finds direct renamed re-exports outside the Plugin SDK boundary. */
export function findAliasingReExports(modules: SourceModule[]) {
  return analyzeExportNames(modules).aliasingReExports;
}

/** Finds duplicate exported function/const definitions across source modules. */
export function findExportNameCollisions(modules: SourceModule[]): ExportNameCollision[] {
  return analyzeExportNames(modules).collisions;
}

async function collectRepositoryModules(repoRoot: string) {
  const ignoredDirNames = new Set(["node_modules", "test", "__fixtures__"]);
  const [collectedFiles, collectedSupportFiles] = await Promise.all([
    collectSourceFileContents({
      repoRoot,
      scanRoots: ["src"],
      scanExtensions: new Set([".ts", ".mts", ".js", ".mjs"]),
      ignoredDirNames,
    }),
    // Package modules are resolution-only: Plugin SDK barrels can export their
    // names, but the collision rule itself remains scoped to src/ definitions.
    collectSourceFileContents({
      repoRoot,
      scanRoots: ["packages"],
      scanExtensions: new Set([".ts", ".mts"]),
      ignoredDirNames,
    }),
  ]);
  const files = collectedFiles.filter(
    ({ relativeFile }) => !isExcludedExportCollisionSource(relativeFile),
  );
  const supportFiles = collectedSupportFiles.filter(
    ({ relativeFile }) => !isExcludedExportCollisionSource(relativeFile),
  );
  return [
    ...files.map(({ content, relativeFile }) => ({
      content,
      includeDefinitions: true,
      path: relativeFile,
    })),
    ...supportFiles.map(({ content, relativeFile }) => ({
      content,
      includeDefinitions: false,
      path: relativeFile,
    })),
  ];
}

async function collectRepositoryExportAnalysis(repoRoot: string) {
  return analyzeExportNames(await collectRepositoryModules(repoRoot));
}

export async function collectRepositoryCollisions(repoRoot: string) {
  return (await collectRepositoryExportAnalysis(repoRoot)).collisions;
}

function printAliasingReExports(reExports: AliasingReExport[]) {
  if (reExports.length === 0) {
    return;
  }
  console.log("Aliasing re-exports outside src/plugin-sdk/ (informational):");
  for (const reExport of reExports) {
    console.log(
      `- ${reExport.path}:${reExport.line}: ${reExport.importedName} as ${reExport.exportedName} from ${JSON.stringify(reExport.moduleSpecifier)}`,
    );
  }
}

export async function main(
  repoRoot = resolveRepoRoot(import.meta.url),
  argv = process.argv.slice(2),
) {
  if (argv.length > 0) {
    console.error(`Unknown argument(s): ${argv.join(", ")}`);
    return 2;
  }

  const analysis = await collectRepositoryExportAnalysis(repoRoot);
  printAliasingReExports(analysis.aliasingReExports);
  if (analysis.collisions.length === 0) {
    console.log("export name collision guard passed.");
    return 0;
  }

  console.error("Found exported function/const name collisions:");
  for (const collision of analysis.collisions) {
    console.error(`- ${JSON.stringify(collision)}`);
  }
  console.error("Give each behavior one exported spelling.");
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
