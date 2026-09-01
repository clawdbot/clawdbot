import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { executeTsdownBuildPlan, type prepareTsdownBuildExecution } from "../tsdown-build.mts";
import {
  listCacheFiles,
  portableRelativePath,
  publishArtifactFiles,
  restoreBuildStepCacheOutputs,
  finalizeBuildStepCache,
  type BuildCacheStep,
  type BuildCacheState,
  type BuildCacheParams,
} from "./build-artifact-cache.mts";

function declarationReferences(file: string, contents: string) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest);
  const modules = source.typeReferenceDirectives.map((reference) => reference.fileName);
  function visit(node: ts.Node) {
    let specifier: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifier = node.moduleReference.expression;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    } else if (ts.isModuleDeclaration(node)) {
      specifier = node.name;
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      modules.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(source, visit);
  // Parse declarations so comments cannot invent imports, and reference directives
  // and import-equals declarations cannot hide missing staged dependencies.
  return [
    ...source.referencedFiles.map((reference) => reference.fileName),
    ...modules
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) =>
        /\.d\.[cm]?ts$/u.test(specifier)
          ? specifier
          : /\.[cm]?js$/u.test(specifier)
            ? specifier.replace(/\.([cm]?)js$/u, ".d.$1ts")
            : `${specifier}.d.ts`,
      ),
  ];
}

/** Publish a declaration subset only after its complete canonical build succeeds. */
export async function publishStagedDeclarations(
  plan: NonNullable<ReturnType<typeof prepareTsdownBuildExecution>>,
  staging: string,
  dist: string,
  required: string[],
  previous: string[],
  cache?: {
    step: BuildCacheStep;
    state: BuildCacheState;
    params: BuildCacheParams;
    sealInputs?: () => { signature: string; inputs: string[] };
  },
) {
  const reused = cache?.state.fresh === true;
  if (reused) {
    if (!restoreBuildStepCacheOutputs(cache.state, cache.params)) {
      throw new Error("Declaration cache changed before restoration; rerun the build");
    }
    console.log(`[${cache.step.label}] restored complete cached generation`);
  } else {
    const code = await executeTsdownBuildPlan(plan);
    if (code !== 0) {
      throw Object.assign(new Error(`Declaration build failed with exit ${code}`), {
        exitCode: code,
      });
    }
  }
  const files = listCacheFiles(
    staging,
    [{ path: ".", extensions: [".d.ts", ".d.mts", ".d.cts"] }],
    fs,
  ).map((file) => portableRelativePath(staging, file));
  const emitted = new Set(files);
  for (const entry of required) {
    if (!emitted.has(entry)) {
      throw new Error(`Missing canonical declaration: ${entry}`);
    }
  }
  // Validate all staged relative edges before touching live declarations, including
  // shared root chunks. The caller supplies only its owned previous inventory.
  const dependencies = new Map<string, string[]>();
  for (const file of files) {
    const targets: string[] = [];
    const contents = fs.readFileSync(path.join(staging, file), "utf8");
    for (const declaration of declarationReferences(file, contents)) {
      if (path.posix.isAbsolute(declaration) || path.win32.isAbsolute(declaration)) {
        throw new Error(`Incomplete declaration closure: ${file} -> ${declaration}`);
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), declaration));
      if (!emitted.has(target)) {
        throw new Error(`Incomplete declaration closure: ${file} -> ${declaration}`);
      }
      targets.push(target);
    }
    dependencies.set(file, targets);
  }
  // Postorder makes dependencies visible before their importers. Mark before
  // descending because declaration cycles are legal and the closure is validated.
  const visited = new Set<string>();
  const ordered: string[] = [];
  function visit(file: string) {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    for (const dependency of dependencies.get(file) ?? []) {
      visit(dependency);
    }
    ordered.push(file);
  }
  for (const file of files) {
    visit(file);
  }
  if (cache?.sealInputs && !reused) {
    const { signature, inputs } = cache.sealInputs();
    cache.state.signature = signature;
    cache.state.consumedInputs = inputs;
  }
  publishArtifactFiles(staging, dist, ordered, previous);
  if (cache && !reused) {
    // Seal only the validated private generation; live dist also contains declarations
    // owned by other compiler groups and must never become this snapshot.
    finalizeBuildStepCache(cache.step, cache.state, cache.params);
  }
}
