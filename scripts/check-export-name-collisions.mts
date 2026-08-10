#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  collectTypeScriptFilesFromRoots,
  isTestLikeTypeScriptFile,
  resolveSourceRoots,
  runAsScript,
  unwrapExpression,
} from "./lib/ts-guard-utils.mts";

export type ExportNameCollision = {
  name: string;
  files: string[];
  sdk?: true;
};

type SourceModule = {
  content: string;
  includeDefinitions?: boolean;
  path: string;
};

type ModuleExports = {
  definitions: Set<string>;
  exportedNames: Set<string>;
  starExportSpecifiers: string[];
};

const exportNameCollisionSchema = z
  .object({
    name: z.string(),
    files: z.array(z.string()),
    sdk: z.literal(true).optional(),
  })
  .strict();
const exportNameCollisionBaselineSchema = z.array(exportNameCollisionSchema);

const baselineRelativePath = "scripts/lib/export-name-collision-baseline.json";
const baselineRegenCommand = "pnpm lint:tmp:export-name-collisions:gen";
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

function returnCall(statement: ts.Statement) {
  if (!ts.isReturnStatement(statement) || !statement.expression) {
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

  if (!ts.isBlock(body)) {
    const expression = unwrapExpression(body);
    return (
      ts.isCallExpression(expression) &&
      parametersAreForwarded(declaration.parameters, expression.arguments) &&
      (isStaticImportForwarder(expression, functionName, importedNamesByLocalName) ||
        isLazyModuleForwarderCall(expression, functionName))
    );
  }

  if (body.statements.length === 1) {
    const statement = body.statements[0];
    if (!statement) {
      return false;
    }
    const call = returnCall(statement);
    return Boolean(
      call &&
      parametersAreForwarded(declaration.parameters, call.arguments) &&
      (isStaticImportForwarder(call, functionName, importedNamesByLocalName) ||
        isLazyModuleForwarderCall(call, functionName)),
    );
  }

  if (body.statements.length !== 2) {
    return false;
  }
  const loadStatement = body.statements[0];
  const returnStatement = body.statements[1];
  if (
    !loadStatement ||
    !returnStatement ||
    !ts.isVariableStatement(loadStatement) ||
    !(loadStatement.declarationList.flags & ts.NodeFlags.Const) ||
    loadStatement.declarationList.declarations.length !== 1
  ) {
    return false;
  }
  const declarationItem = loadStatement.declarationList.declarations[0];
  if (
    !declarationItem ||
    !ts.isIdentifier(declarationItem.name) ||
    !declarationItem.initializer ||
    !isAwaitedZeroArgumentCall(declarationItem.initializer)
  ) {
    return false;
  }
  const call = returnCall(returnStatement);
  return Boolean(
    call &&
    parametersAreForwarded(declaration.parameters, call.arguments) &&
    isLazyModuleForwarderCall(call, functionName, declarationItem.name.text),
  );
}

function isForwardingOnlyConst(
  declaration: ts.VariableDeclaration,
  exportName: string,
  importedNamesByLocalName: ReadonlyMap<string, string>,
) {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
    return false;
  }
  const initializer = unwrapExpression(declaration.initializer);
  if (ts.isIdentifier(initializer)) {
    return importedNamesByLocalName.get(initializer.text) === exportName;
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
  const localConstDeclarations = new Map<string, ts.VariableDeclaration[]>();
  const localFunctions = new Map<string, ts.FunctionDeclaration[]>();
  const directlyExportedNames = new Set<string>();
  const locallyExportedNames = new Set<string>();
  const exportedNames = new Set<string>();
  const starExportSpecifiers: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          if (!statement.importClause?.isTypeOnly && !specifier.isTypeOnly) {
            importedNamesByLocalName.set(
              specifier.name.text,
              specifier.propertyName?.text ?? specifier.name.text,
            );
          }
        }
      }
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
        // Renamed re-exports are deliberately outside this guard's first slice.
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

  const definitions = new Set<string>();
  for (const name of new Set([...directlyExportedNames, ...locallyExportedNames])) {
    const constDeclarations = localConstDeclarations.get(name);
    if (constDeclarations) {
      const [constDeclaration] = constDeclarations;
      if (
        constDeclarations.length === 1 &&
        constDeclaration &&
        isForwardingOnlyConst(constDeclaration, name, importedNamesByLocalName)
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

  return { definitions, exportedNames, starExportSpecifiers };
}

function resolveStarExportPath(
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
    const targetPath = resolveStarExportPath(modulePath, specifier, modulesByPath);
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

/** Finds duplicate exported function/const definitions across source modules. */
export function findExportNameCollisions(modules: SourceModule[]): ExportNameCollision[] {
  const filesByName = new Map<string, Set<string>>();
  const sdkExportNames = new Set<string>();
  const modulesByPath = new Map<string, ModuleExports>();
  for (const sourceModule of modules.toSorted((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const relativePath = normalizeRelativePath(sourceModule.path);
    const moduleExports = collectModuleExportNames(sourceModule.content, relativePath);
    modulesByPath.set(relativePath, moduleExports);
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
  return collisions.toSorted((left, right) => left.name.localeCompare(right.name));
}

type CollisionChange = {
  baseline?: ExportNameCollision;
  current?: ExportNameCollision;
};

/** Compares every collision cluster so additions fail and removals ratchet debt down. */
export function compareExportNameCollisionDebt(
  current: ExportNameCollision[],
  baseline: ExportNameCollision[],
) {
  const currentByName = new Map(current.map((collision) => [collision.name, collision]));
  const baselineByName = new Map(baseline.map((collision) => [collision.name, collision]));
  const regressions: CollisionChange[] = [];
  const improvements: CollisionChange[] = [];
  const names = [...new Set([...currentByName.keys(), ...baselineByName.keys()])].toSorted();

  for (const name of names) {
    const currentCollision = currentByName.get(name);
    const baselineCollision = baselineByName.get(name);
    if (!baselineCollision) {
      regressions.push({ current: currentCollision });
      continue;
    }
    if (!currentCollision) {
      improvements.push({ baseline: baselineCollision });
      continue;
    }
    const baselineFiles = new Set(baselineCollision.files);
    const currentFiles = new Set(currentCollision.files);
    const hasAddedFile = currentCollision.files.some((file) => !baselineFiles.has(file));
    const hasRemovedFile = baselineCollision.files.some((file) => !currentFiles.has(file));
    if (hasAddedFile || (currentCollision.sdk === true && baselineCollision.sdk !== true)) {
      regressions.push({ baseline: baselineCollision, current: currentCollision });
    }
    if (hasRemovedFile || (baselineCollision.sdk === true && currentCollision.sdk !== true)) {
      improvements.push({ baseline: baselineCollision, current: currentCollision });
    }
  }
  return { regressions, improvements };
}

function resolveBaselinePath(repoRoot: string) {
  return path.join(repoRoot, ...baselineRelativePath.split("/"));
}

export async function collectRepositoryCollisions(repoRoot: string) {
  const sourceCollectOptions = {
    fileExtensions: [".ts", ".mts", ".js", ".mjs"],
    includeTests: true,
    skipDirectories: ["test", "__fixtures__"],
  };
  const supportCollectOptions = {
    ...sourceCollectOptions,
    fileExtensions: [".ts", ".mts"],
  };
  const [collectedFiles, collectedSupportFiles] = await Promise.all([
    collectTypeScriptFilesFromRoots(resolveSourceRoots(repoRoot, ["src"]), sourceCollectOptions),
    // Package modules are resolution-only: Plugin SDK barrels can export their
    // names, but the collision rule itself remains scoped to src/ definitions.
    collectTypeScriptFilesFromRoots(
      resolveSourceRoots(repoRoot, ["packages"]),
      supportCollectOptions,
    ),
  ]);
  const files = collectedFiles.filter((filePath) => !isExcludedExportCollisionSource(filePath));
  const supportFiles = collectedSupportFiles.filter(
    (filePath) => !isExcludedExportCollisionSource(filePath),
  );
  const modules = await Promise.all(
    [
      ...files.map((filePath) => ({ filePath, includeDefinitions: true })),
      ...supportFiles.map((filePath) => ({ filePath, includeDefinitions: false })),
    ].map(async ({ filePath, includeDefinitions }) => ({
      content: await fs.readFile(filePath, "utf8"),
      includeDefinitions,
      path: normalizeRelativePath(path.relative(repoRoot, filePath)),
    })),
  );
  return findExportNameCollisions(modules);
}

async function readBaseline(repoRoot: string) {
  try {
    return exportNameCollisionBaselineSchema.parse(
      JSON.parse(await fs.readFile(resolveBaselinePath(repoRoot), "utf8")),
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeBaseline(repoRoot: string) {
  const collisions = await collectRepositoryCollisions(repoRoot);
  await fs.writeFile(resolveBaselinePath(repoRoot), `${JSON.stringify(collisions, null, 2)}\n`);
  return collisions.length;
}

function formatCollision(collision: ExportNameCollision | undefined) {
  return JSON.stringify(collision);
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  if (process.argv.includes("--update-debt-baseline")) {
    const count = await writeBaseline(repoRoot);
    console.log(`Wrote ${baselineRelativePath} (${count} entries)`);
    return 0;
  }

  const baseline = await readBaseline(repoRoot);
  if (!baseline) {
    console.error(
      `Missing ${baselineRelativePath}; run \`${baselineRegenCommand}\` and commit it.`,
    );
    return 1;
  }
  const current = await collectRepositoryCollisions(repoRoot);
  const debt = compareExportNameCollisionDebt(current, baseline);
  if (debt.regressions.length === 0 && debt.improvements.length === 0) {
    console.log("export name collision guard passed.");
    return 0;
  }

  if (debt.regressions.length > 0) {
    console.error(
      `Found new exported function/const name collisions beyond ${baselineRelativePath}:`,
    );
    for (const regression of debt.regressions) {
      console.error(`- ${formatCollision(regression.current)}`);
    }
    console.error(
      `Give each behavior one exported spelling. If the debt increase is intentional, run \`${baselineRegenCommand}\` and commit the generated baseline.`,
    );
  }
  if (debt.improvements.length > 0) {
    console.error(`Export name collision debt dropped below ${baselineRelativePath}:`);
    for (const improvement of debt.improvements) {
      console.error(
        `- ${improvement.baseline?.name}: ${formatCollision(improvement.baseline)} -> ${formatCollision(improvement.current)}`,
      );
    }
    console.error(`Run \`${baselineRegenCommand}\` to ratchet the baseline down and commit it.`);
  }
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
