// Declaration closure rendering keeps compiler-owned dependencies in API baselines.
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import {
  normalizePluginSdkApiDeclarationText,
  normalizePluginSdkApiSourcePath,
} from "./api-baseline-normalization.js";

export type PluginSdkDeclarationClosure = {
  hash: string;
};

type ClosureExport<T> = {
  closure: PluginSdkDeclarationClosure;
  surface: T;
};

type DeclarationReference = {
  mode: ts.ResolutionMode;
  specifier: string;
};

type EmittedDeclaration = {
  declarationFile: ts.SourceFile;
  text: string;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function formatPluginSdkDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  currentDirectory: string,
): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => currentDirectory,
    getNewLine: () => "\n",
  });
}

export function attachPluginSdkDeclarationClosures<T extends { declaration: string | null }>(
  exports: readonly ClosureExport<T>[],
): T[] {
  return exports.map(({ closure, surface }) => {
    if (surface.declaration && closure.hash) {
      surface.declaration = `// declaration closure: ${closure.hash}\n${surface.declaration}`;
    }
    return surface;
  });
}

function collectDeclarationReferences(
  sourceFile: ts.SourceFile,
  options: ts.CompilerOptions,
): DeclarationReference[] {
  const references = new Map<string, DeclarationReference>();
  const add = (literal: ts.StringLiteralLike) => {
    const mode = ts.getModeForUsageLocation(sourceFile, literal, options);
    references.set(`${mode ?? "default"}\0${literal.text}`, {
      mode,
      specifier: literal.text,
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      add(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...references.values()].toSorted(
    (left, right) =>
      compareText(left.specifier, right.specifier) ||
      compareText(String(left.mode), String(right.mode)),
  );
}

export function createDeclarationClosureRenderer(params: {
  printer: ts.Printer;
  program: ts.Program;
  repoRoot: string;
}): (sourceFile: ts.SourceFile) => PluginSdkDeclarationClosure {
  const { printer, program, repoRoot } = params;
  const options = program.getCompilerOptions();
  const canonical = (fileName: string) => {
    const resolved = path.resolve(fileName);
    return ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
  };
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const sourceFile of program.getSourceFiles()) {
    sourceFiles.set(canonical(sourceFile.fileName), sourceFile);
    const realPath = ts.sys.realpath?.(sourceFile.fileName);
    if (realPath) {
      sourceFiles.set(canonical(realPath), sourceFile);
    }
  }
  const resolutionCache = ts.createModuleResolutionCache(repoRoot, canonical, options);
  const moduleHost = ts.createCompilerHost(options, true);
  const emitted = new Map<string, EmittedDeclaration>();
  const renderedClosures = new Map<string, PluginSdkDeclarationClosure>();

  const baseDiagnostics = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  if (baseDiagnostics.length > 0) {
    throw new Error(
      `Unable to emit Plugin SDK declarations:\n${formatPluginSdkDiagnostics(baseDiagnostics, program.getCurrentDirectory())}`,
    );
  }

  const isRepoOwned = (sourceFile: ts.SourceFile) => {
    if (
      program.isSourceFileDefaultLibrary(sourceFile) ||
      program.isSourceFileFromExternalLibrary(sourceFile)
    ) {
      return false;
    }
    const relative = path.relative(repoRoot, path.resolve(sourceFile.fileName));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      !relative.split(path.sep).includes("node_modules")
    );
  };

  const getDeclaration = (sourceFile: ts.SourceFile): EmittedDeclaration => {
    const key = canonical(sourceFile.fileName);
    const cached = emitted.get(key);
    if (cached) {
      return cached;
    }
    const diagnostics = [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...(sourceFile.isDeclarationFile ? [] : program.getDeclarationDiagnostics(sourceFile)),
    ];
    if (diagnostics.length > 0) {
      throw new Error(
        `Unable to emit ${normalizePluginSdkApiSourcePath(repoRoot, sourceFile.fileName)}:\n${formatPluginSdkDiagnostics(diagnostics, program.getCurrentDirectory())}`,
      );
    }

    let declarationFile = sourceFile;
    if (!sourceFile.isDeclarationFile) {
      let output: { content: string; fileName: string } | undefined;
      const result = program.emit(
        sourceFile,
        (fileName, content, _writeByteOrderMark, _onError, outputSources) => {
          if (!/\.d\.[cm]?ts$/u.test(fileName)) {
            return;
          }
          const outputSource = outputSources?.[0];
          if (
            outputSources?.length !== 1 ||
            !outputSource ||
            canonical(outputSource.fileName) !== canonical(sourceFile.fileName)
          ) {
            throw new Error(`Declaration output ${fileName} has no unique source owner`);
          }
          if (output) {
            throw new Error(`Duplicate declaration output for ${sourceFile.fileName}`);
          }
          output = { content, fileName };
        },
        undefined,
        true,
      );
      if (result.emitSkipped || result.diagnostics.length > 0) {
        const detail = result.diagnostics.length
          ? `\n${formatPluginSdkDiagnostics(result.diagnostics, program.getCurrentDirectory())}`
          : "";
        throw new Error(
          `Unable to emit ${normalizePluginSdkApiSourcePath(repoRoot, sourceFile.fileName)}${detail}`,
        );
      }
      if (!output) {
        throw new Error(
          `Missing emitted declaration for ${normalizePluginSdkApiSourcePath(repoRoot, sourceFile.fileName)}`,
        );
      }
      declarationFile = ts.createSourceFile(
        output.fileName,
        output.content,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      declarationFile.impliedNodeFormat = sourceFile.impliedNodeFormat;
    }

    const declaration = {
      declarationFile,
      text: normalizePluginSdkApiDeclarationText(
        repoRoot,
        printer.printFile(declarationFile).trim(),
      ),
    };
    emitted.set(key, declaration);
    return declaration;
  };

  const resolveDependency = (
    sourceFile: ts.SourceFile,
    reference: DeclarationReference,
  ): ts.SourceFile | undefined => {
    const resolved = ts.resolveModuleName(
      reference.specifier,
      sourceFile.fileName,
      options,
      moduleHost,
      resolutionCache,
      undefined,
      reference.mode,
    ).resolvedModule;
    if (!resolved) {
      if (ts.isExternalModuleNameRelative(reference.specifier)) {
        throw new Error(
          `Unable to resolve declaration dependency ${reference.specifier} from ${normalizePluginSdkApiSourcePath(repoRoot, sourceFile.fileName)}`,
        );
      }
      return undefined;
    }
    if (resolved.isExternalLibraryImport) {
      return undefined;
    }
    const dependency = sourceFiles.get(canonical(resolved.resolvedFileName));
    if (!dependency) {
      const relative = path.relative(repoRoot, path.resolve(resolved.resolvedFileName));
      if (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      ) {
        throw new Error(
          `Missing program source for declaration dependency ${resolved.resolvedFileName}`,
        );
      }
      return undefined;
    }
    return isRepoOwned(dependency) ? dependency : undefined;
  };

  return (owner) => {
    const ownerKey = canonical(owner.fileName);
    const cached = renderedClosures.get(ownerKey);
    if (cached) {
      return cached;
    }
    if (!isRepoOwned(owner)) {
      return { hash: "" };
    }

    const visited = new Set<string>();
    const sections = new Map<string, string>();
    const visit = (sourceFile: ts.SourceFile) => {
      const key = canonical(sourceFile.fileName);
      if (visited.has(key)) {
        return;
      }
      visited.add(key);
      const declaration = getDeclaration(sourceFile);
      sections.set(
        normalizePluginSdkApiSourcePath(repoRoot, sourceFile.fileName),
        declaration.text,
      );
      for (const reference of collectDeclarationReferences(declaration.declarationFile, options)) {
        const dependency = resolveDependency(sourceFile, reference);
        if (dependency) {
          visit(dependency);
        }
      }
    };
    visit(owner);
    const renderedSections = [...sections.entries()]
      .toSorted(([left], [right]) => compareText(left, right))
      .map(([sourcePath, text]) => ({ sourcePath, text }));
    const hash = createHash("sha256")
      .update(JSON.stringify(renderedSections), "utf8")
      .digest("hex");
    const closure = { hash };
    renderedClosures.set(ownerKey, closure);
    return closure;
  };
}
