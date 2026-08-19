// Repo tool shim guard keeps package-manager shims out of platform-fragile spawns.
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { resolveRepoRoot } from "../../scripts/lib/repo-root.mjs";
import { collectTypeScriptFilesFromRoots } from "../../scripts/lib/ts-guard-utils.mts";

const repoRoot = resolveRepoRoot(import.meta.url);
const RESOLVER_NAME = "resolveRepoToolBinPath";
const LAUNCHER_NAME = "createManagedCommandInvocation";
const FORWARDED_OPTIONS = ["shell", "windowsVerbatimArguments"] as const;

// Handing a shim straight to one of these is safe: they either normalize it for
// the platform, or only read the path to locate the toolchain on disk.
const SHIM_SAFE_SINKS = new Set([
  "ensureRepoToolNodeModulesLink",
  "buildCmdExeCommandLine",
  "createRequire",
  "existsSync",
  "dirname",
  "resolveOxlintToolchainEnv",
]);

function calleeName(call: ts.CallExpression) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
}

/** Local aliases still spawn the same shim, so detection follows the import binding. */
function collectImportedNames(sourceFile: ts.SourceFile, exportedName: string) {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const element of bindings.elements) {
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === exportedName) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function isSpawnCall(call: ts.CallExpression) {
  const name = calleeName(call).toLowerCase();
  return name.includes("spawn") || name.includes("execfile");
}

function findOptionValue(options: ts.Expression | undefined, optionName: string) {
  if (!options || !ts.isObjectLiteralExpression(options)) {
    return undefined;
  }
  for (const property of options.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === optionName
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

/**
 * Reports two failures that both break Windows silently: spawning a resolved
 * shim, which Windows cannot execute, and dropping the launcher options that
 * make the normalized command line run. A shim that escapes through an object
 * property is out of scope; the launchers are the shapes this guard covers.
 */
function findViolations(sourceFile: ts.SourceFile) {
  const resolverNames = collectImportedNames(sourceFile, RESOLVER_NAME);
  const launcherNames = collectImportedNames(sourceFile, LAUNCHER_NAME);
  const shimNames = new Set<string>();
  const launchedNames = new Set<string>();
  const collectBindings = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const producer = calleeName(node.initializer);
      if (resolverNames.has(producer)) {
        shimNames.add(node.name.text);
      }
      if (launcherNames.has(producer)) {
        launchedNames.add(node.name.text);
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const violations: string[] = [];
  const report = (node: ts.Node, message: string) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(`${sourceFile.fileName}:${line + 1} ${message}`);
  };
  const check = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const sink = calleeName(node);
      // Direct arguments only: a shim nested in an object literal reaches a
      // launcher that owns the normalization, which is the supported shape.
      const passesShim = node.arguments.some(
        (argument) =>
          (ts.isIdentifier(argument) && shimNames.has(argument.text)) ||
          (ts.isCallExpression(argument) && resolverNames.has(calleeName(argument))),
      );
      if (passesShim && !SHIM_SAFE_SINKS.has(sink)) {
        report(node, `passes a tool shim to ${sink}(), which cannot run it on Windows`);
      }
    }
    if (ts.isCallExpression(node) && isSpawnCall(node)) {
      const [command, , options] = node.arguments;
      if (
        command &&
        ts.isPropertyAccessExpression(command) &&
        command.name.text === "command" &&
        ts.isIdentifier(command.expression) &&
        launchedNames.has(command.expression.text)
      ) {
        const invocation = command.expression.text;
        for (const optionName of FORWARDED_OPTIONS) {
          const value = findOptionValue(options, optionName);
          const forwarded =
            value &&
            ts.isPropertyAccessExpression(value) &&
            ts.isIdentifier(value.expression) &&
            value.expression.text === invocation &&
            value.name.text === optionName;
          if (!forwarded) {
            report(node, `drops ${invocation}.${optionName} from the spawn options`);
          }
        }
      }
    }
    ts.forEachChild(node, check);
  };
  check(sourceFile);
  return violations;
}

describe("repo tool shim guard", () => {
  it("keeps every resolved tool shim inside a platform-aware launcher", async () => {
    const files = await collectTypeScriptFilesFromRoots([path.join(repoRoot, "scripts")], {
      fileExtensions: [".mts", ".mjs", ".ts"],
    });
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    let scanned = 0;
    for (const file of files) {
      const content = await readFile(file, "utf8");
      if (!content.includes(RESOLVER_NAME) && !content.includes(".command")) {
        continue;
      }
      scanned += 1;
      const sourceFile = ts.createSourceFile(
        path.relative(repoRoot, file).split(path.sep).join("/"),
        content,
        ts.ScriptTarget.Latest,
        true,
      );
      violations.push(...findViolations(sourceFile));
    }

    expect(scanned).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
