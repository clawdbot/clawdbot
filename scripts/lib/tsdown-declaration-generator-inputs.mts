import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectModuleReferencesFromSource } from "./guard-inventory-utils.mjs";
import { STATE_SCHEMA_GENERATOR_INPUTS } from "./state-schema-inline-plugin.mts";
import { resolveDeclarationInputCaptureModule } from "./tsdown-declaration-inputs.mts";
import { resolveTsxImport } from "./tsx-cli-shim.mjs";
import { resolveWorkerDeployGeneratorInputs } from "./worker-deploy-build-plugin.mts";

const sourceFilePattern = /\.(?:[cm]?[jt]sx?)$/u;
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const portablePath = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    ? relative.split(path.sep).join("/")
    : file;
};

function dynamicEdgeExpressions(sourceFile: ts.SourceFile) {
  const expressions: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] !== undefined &&
      ((node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        !ts.isStringLiteralLike(node.arguments[0])) ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require" &&
          !ts.isStringLiteralLike(node.arguments[0])))
    ) {
      expressions.push(node.arguments[0].getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return expressions;
}

/** Resolve the complete executable and non-module input graph for one declaration writer. */
export function resolveTsdownDeclarationGeneratorInputs(rootDir: string, generatorEntry: string) {
  const root = fs.realpathSync(rootDir);
  const dynamicOwners = new Map<string, { expressions: string[]; targets: string[] }>([
    [
      "scripts/lib/dist-artifact-ownership.mts",
      { expressions: ["script"], targets: [generatorEntry] },
    ],
    [
      "scripts/lib/tsdown-declaration-inputs.mts",
      {
        expressions: ["pathToFileURL(resolveDeclarationInputCaptureModule()).href"],
        targets: [resolveDeclarationInputCaptureModule()],
      },
    ],
    [
      "scripts/lib/tsdown-declaration-writer.mts",
      {
        expressions: ['pathToFileURL(path.join(root, "tsdown.config.ts")).href'],
        targets: ["tsdown.config.ts"],
      },
    ],
    [
      "scripts/lib/tsx-cli-shim.mjs",
      {
        expressions: ["resolveTsxImport(SHIM_CHECKOUT_ROOT)"],
        targets: [fileURLToPath(resolveTsxImport(root))],
      },
    ],
  ]);
  const observedDynamicOwners = new Set<string>();
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), (file) =>
    ts.sys.readFile(file),
  );
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
        .join("\n"),
    );
  }
  const compilerOptions = parsed.options;
  const files = new Map<string, string>();

  const visit = (input: string) => {
    const requested = input.startsWith("file:") ? fileURLToPath(input) : input;
    const absolute = fs.realpathSync(path.resolve(root, requested));
    const id = portablePath(root, absolute);
    if (files.has(id)) {
      return;
    }
    files.set(id, absolute);
    if (
      id === absolute ||
      id.split("/").includes("node_modules") ||
      !sourceFilePattern.test(absolute)
    ) {
      return;
    }
    const source = fs.readFileSync(absolute, "utf8");
    const sourceFile = ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true);
    const expressions = dynamicEdgeExpressions(sourceFile);
    const owner = dynamicOwners.get(id);
    if (
      JSON.stringify(expressions) !== JSON.stringify(owner?.expressions ?? []) ||
      (expressions.length > 0 && !owner?.targets.length)
    ) {
      throw new Error(`Unresolved dynamic module edges in ${id}: ${JSON.stringify(expressions)}`);
    }
    if (owner) {
      observedDynamicOwners.add(id);
      owner.targets.forEach(visit);
    }
    for (const reference of collectModuleReferencesFromSource(source, {
      fileName: absolute,
      ts,
    })) {
      if (reference.kind === "import-meta-url") {
        const target = path.resolve(path.dirname(absolute), reference.specifier);
        if (fs.statSync(target).isDirectory()) {
          if (portablePath(root, fs.realpathSync(target)) !== "") {
            throw new Error(`Unowned import.meta directory in ${id}:${reference.line}`);
          }
        } else {
          visit(target);
        }
        continue;
      }
      if (builtins.has(reference.specifier)) {
        continue;
      }
      const exact = reference.specifier.startsWith(".")
        ? path.resolve(path.dirname(absolute), reference.specifier)
        : undefined;
      const resolved =
        exact && fs.existsSync(exact) && fs.statSync(exact).isFile()
          ? exact
          : ts.resolveModuleName(reference.specifier, absolute, compilerOptions, ts.sys)
              .resolvedModule?.resolvedFileName;
      if (!resolved) {
        throw new Error(
          `Unresolved ${reference.kind} in ${id}:${reference.line}: ${reference.specifier}`,
        );
      }
      const canonical = fs.realpathSync(resolved);
      const relative = path.relative(root, canonical);
      if (
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        !relative.split(path.sep).includes("node_modules")
      ) {
        visit(canonical);
      }
      // The lockfile and installed topology own resolved package imports. Exact
      // computed package targets above remain byte inputs in this same closure.
    }
  };

  [generatorEntry, "scripts/tsx.mjs", "tsdown.config.ts"].forEach(visit);
  for (const owner of dynamicOwners.keys()) {
    if (!observedDynamicOwners.has(owner)) {
      throw new Error(`Dynamic module owner is outside the generator closure: ${owner}`);
    }
  }
  return [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    ...[...files.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([, file]) => file),
    ...STATE_SCHEMA_GENERATOR_INPUTS,
    ...resolveWorkerDeployGeneratorInputs(root),
  ];
}
