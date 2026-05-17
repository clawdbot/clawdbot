import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  pluginSdkDocMetadata,
  resolvePluginSdkDocImportSpecifier,
  type PluginSdkDocCategory,
  type PluginSdkDocEntrypoint,
} from "../../scripts/lib/plugin-sdk-doc-metadata.ts";
import { publicPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mjs";

export type PluginSdkApiExportKind =
  | "class"
  | "const"
  | "enum"
  | "function"
  | "interface"
  | "namespace"
  | "type"
  | "unknown"
  | "variable";

export type PluginSdkApiSourceLink = {
  line: number;
  path: string;
};

export type PluginSdkApiExport = {
  declaration: string | null;
  exportName: string;
  kind: PluginSdkApiExportKind;
  source: PluginSdkApiSourceLink | null;
};

export type PluginSdkApiModule = {
  category: PluginSdkDocCategory;
  entrypoint: PluginSdkDocEntrypoint;
  exports: PluginSdkApiExport[];
  importSpecifier: string;
  source: PluginSdkApiSourceLink;
};

export type PluginSdkApiBaseline = {
  generatedBy: "scripts/generate-plugin-sdk-api-baseline.ts";
  modules: PluginSdkApiModule[];
};

export type PluginSdkApiBaselineRender = {
  baseline: PluginSdkApiBaseline;
  json: string;
  jsonl: string;
};

export type PluginSdkApiBaselineWriteResult = {
  changed: boolean;
  wrote: boolean;
  jsonPath: string;
  statefilePath: string;
  hashPath: string;
};

const GENERATED_BY = "scripts/generate-plugin-sdk-api-baseline.ts" as const;
const DEFAULT_JSON_OUTPUT = "docs/.generated/plugin-sdk-api-baseline.json";
const DEFAULT_STATEFILE_OUTPUT = "docs/.generated/plugin-sdk-api-baseline.jsonl";
const DEFAULT_HASH_OUTPUT = "docs/.generated/plugin-sdk-api-baseline.sha256";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function relativePath(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join(path.posix.sep);
}

function isAbsoluteImportPath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeDeclarationImportSpecifier(repoRoot: string, value: string): string {
  if (!isAbsoluteImportPath(value)) {
    return value;
  }

  const resolvedPath = path.resolve(value);
  const relative = path.relative(repoRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return value;
  }
  return relative.split(path.sep).join(path.posix.sep);
}

export function normalizePluginSdkApiDeclarationText(repoRoot: string, value: string): string {
  return value.replaceAll(
    /import\("([^"]+)"((?:\s*,[^)]*)?)\)/g,
    (match, specifier: string, suffix: string) => {
      const normalized = normalizeDeclarationImportSpecifier(repoRoot, specifier);
      return normalized === specifier ? match : `import("${normalized}"${suffix})`;
    },
  );
}

function createCompilerContext(repoRoot: string) {
  const configPath = ts.findConfigFile(
    repoRoot,
    (filePath) => ts.sys.fileExists(filePath),
    "tsconfig.json",
  );
  assert(configPath, "Could not find tsconfig.json");
  const configFile = ts.readConfigFile(configPath, (filePath) => ts.sys.readFile(filePath));
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  const fileNames = parsedConfig.fileNames.toSorted((left, right) =>
    compareText(
      relativePath(repoRoot, path.resolve(left)),
      relativePath(repoRoot, path.resolve(right)),
    ),
  );
  const program = ts.createProgram(fileNames, parsedConfig.options);
  return {
    checker: program.getTypeChecker(),
    printer: ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }),
    program,
  };
}

function buildSourceLink(
  repoRoot: string,
  program: ts.Program,
  filePath: string,
  start: number,
): PluginSdkApiSourceLink {
  const sourceFile = program.getSourceFile(filePath);
  assert(sourceFile, `Unable to read source file for ${relativePath(repoRoot, filePath)}`);
  const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
  return {
    line,
    path: relativePath(repoRoot, filePath),
  };
}

function inferExportKind(
  symbol: ts.Symbol,
  declaration: ts.Declaration | undefined,
): PluginSdkApiExportKind {
  if (declaration) {
    switch (declaration.kind) {
      case ts.SyntaxKind.ClassDeclaration:
        return "class";
      case ts.SyntaxKind.EnumDeclaration:
        return "enum";
      case ts.SyntaxKind.FunctionDeclaration:
        return "function";
      case ts.SyntaxKind.InterfaceDeclaration:
        return "interface";
      case ts.SyntaxKind.ModuleDeclaration:
        return "namespace";
      case ts.SyntaxKind.TypeAliasDeclaration:
        return "type";
      case ts.SyntaxKind.VariableDeclaration: {
        const variableStatement = declaration.parent?.parent;
        if (
          variableStatement &&
          ts.isVariableStatement(variableStatement) &&
          (ts.getCombinedNodeFlags(variableStatement.declarationList) & ts.NodeFlags.Const) !== 0
        ) {
          return "const";
        }
        return "variable";
      }
      default:
        break;
    }
  }

  if (symbol.flags & ts.SymbolFlags.Function) {
    return "function";
  }
  if (symbol.flags & ts.SymbolFlags.Class) {
    return "class";
  }
  if (symbol.flags & ts.SymbolFlags.Interface) {
    return "interface";
  }
  if (symbol.flags & ts.SymbolFlags.TypeAlias) {
    return "type";
  }
  if (symbol.flags & ts.SymbolFlags.ConstEnum || symbol.flags & ts.SymbolFlags.RegularEnum) {
    return "enum";
  }
  if (symbol.flags & ts.SymbolFlags.Variable) {
    return "variable";
  }
  if (symbol.flags & ts.SymbolFlags.NamespaceModule || symbol.flags & ts.SymbolFlags.ValueModule) {
    return "namespace";
  }
  return "unknown";
}

function resolveSymbolAndDeclaration(
  checker: ts.TypeChecker,
  repoRoot: string,
  symbol: ts.Symbol,
): {
  declaration: ts.Declaration | undefined;
  resolvedSymbol: ts.Symbol;
} {
  const resolvedSymbol =
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declarations = (
    resolvedSymbol.getDeclarations() ??
    symbol.getDeclarations() ??
    []
  ).toSorted((left, right) => compareDeclarations(repoRoot, left, right));
  const declaration = declarations.find((candidate) => candidate.kind !== ts.SyntaxKind.SourceFile);
  return { declaration, resolvedSymbol };
}

function printNode(
  repoRoot: string,
  checker: ts.TypeChecker,
  printer: ts.Printer,
  declaration: ts.Declaration,
): string | null {
  if (ts.isFunctionDeclaration(declaration)) {
    const signatures = checker.getTypeAtLocation(declaration).getCallSignatures();
    if (signatures.length === 0) {
      return `export function ${declaration.name?.text ?? "anonymous"}();`;
    }
    return normalizePluginSdkApiDeclarationText(
      repoRoot,
      signatures
        .map(
          (signature) =>
            `export function ${declaration.name?.text ?? "anonymous"}${checker.signatureToString(signature)};`,
        )
        .join("\n"),
    );
  }

  if (ts.isVariableDeclaration(declaration)) {
    const name = declaration.name.getText();
    const type = checker.getTypeAtLocation(declaration);
    const prefix =
      declaration.parent && (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) !== 0
        ? "const"
        : "let";
    return normalizePluginSdkApiDeclarationText(
      repoRoot,
      `export ${prefix} ${name}: ${checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation)};`,
    );
  }

  if (ts.isInterfaceDeclaration(declaration)) {
    return `export interface ${declaration.name.text}`;
  }

  if (ts.isClassDeclaration(declaration)) {
    return `export class ${declaration.name?.text ?? "AnonymousClass"}`;
  }

  if (ts.isEnumDeclaration(declaration)) {
    return `export enum ${declaration.name.text}`;
  }

  if (ts.isModuleDeclaration(declaration)) {
    return `export namespace ${declaration.name.getText()}`;
  }

  if (ts.isTypeAliasDeclaration(declaration)) {
    const type = checker.getTypeAtLocation(declaration);
    const rendered = normalizePluginSdkApiDeclarationText(
      repoRoot,
      `export type ${declaration.name.text} = ${checker.typeToString(
        type,
        declaration,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.MultilineObjectLiterals,
      )};`,
    );
    if (rendered.length > 1200) {
      return `export type ${declaration.name.text} = /* see source */`;
    }
    return rendered;
  }

  const text = printer
    .printNode(ts.EmitHint.Unspecified, declaration, declaration.getSourceFile())
    .trim();
  if (!text) {
    return null;
  }
  const normalizedText = normalizePluginSdkApiDeclarationText(repoRoot, text);
  return normalizedText.length > 1200
    ? `${normalizedText.slice(0, 1175).trimEnd()}\n/* truncated; see source */`
    : normalizedText;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareDeclarations(
  repoRoot: string,
  left: ts.Declaration,
  right: ts.Declaration,
): number {
  const byPath = compareText(
    relativePath(repoRoot, left.getSourceFile().fileName),
    relativePath(repoRoot, right.getSourceFile().fileName),
  );
  if (byPath !== 0) {
    return byPath;
  }

  const byStart = left.getStart() - right.getStart();
  if (byStart !== 0) {
    return byStart;
  }

  return left.kind - right.kind;
}

function buildExportSurface(params: {
  checker: ts.TypeChecker;
  printer: ts.Printer;
  program: ts.Program;
  repoRoot: string;
  symbol: ts.Symbol;
}): PluginSdkApiExport {
  const { checker, printer, program, repoRoot, symbol } = params;
  const { declaration, resolvedSymbol } = resolveSymbolAndDeclaration(checker, repoRoot, symbol);
  return {
    declaration: declaration ? printNode(repoRoot, checker, printer, declaration) : null,
    exportName: symbol.getName(),
    kind: inferExportKind(resolvedSymbol, declaration),
    source: declaration
      ? buildSourceLink(
          repoRoot,
          program,
          declaration.getSourceFile().fileName,
          declaration.getStart(),
        )
      : null,
  };
}

function sortExports(left: PluginSdkApiExport, right: PluginSdkApiExport): number {
  const kindRank: Record<PluginSdkApiExportKind, number> = {
    function: 0,
    const: 1,
    variable: 2,
    type: 3,
    interface: 4,
    class: 5,
    enum: 6,
    namespace: 7,
    unknown: 8,
  };

  const byKind = kindRank[left.kind] - kindRank[right.kind];
  if (byKind !== 0) {
    return byKind;
  }
  return compareText(left.exportName, right.exportName);
}

function buildModuleSurface(params: {
  checker: ts.TypeChecker;
  printer: ts.Printer;
  program: ts.Program;
  repoRoot: string;
  entrypoint: PluginSdkDocEntrypoint;
}): PluginSdkApiModule {
  const { checker, printer, program, repoRoot, entrypoint } = params;
  const metadata = pluginSdkDocMetadata[entrypoint];
  const importSpecifier = resolvePluginSdkDocImportSpecifier(entrypoint);
  const moduleSourcePath = path.join(repoRoot, "src", "plugin-sdk", `${entrypoint}.ts`);
  const sourceFile = program.getSourceFile(moduleSourcePath);
  assert(sourceFile, `Missing source file for ${importSpecifier}`);

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  assert(moduleSymbol, `Unable to resolve module symbol for ${importSpecifier}`);

  const exports = checker
    .getExportsOfModule(moduleSymbol)
    .filter((symbol) => symbol.getName() !== "__esModule")
    .map((symbol) =>
      buildExportSurface({
        checker,
        printer,
        program,
        repoRoot,
        symbol,
      }),
    )
    .toSorted(sortExports);

  return {
    category: metadata.category,
    entrypoint,
    exports,
    importSpecifier,
    source: buildSourceLink(repoRoot, program, moduleSourcePath, 0),
  };
}

function buildJsonlLines(baseline: PluginSdkApiBaseline): string[] {
  const lines: string[] = [];

  for (const moduleSurface of baseline.modules) {
    lines.push(
      JSON.stringify({
        category: moduleSurface.category,
        entrypoint: moduleSurface.entrypoint,
        importSpecifier: moduleSurface.importSpecifier,
        recordType: "module",
        sourceLine: moduleSurface.source.line,
        sourcePath: moduleSurface.source.path,
      }),
    );

    for (const exportSurface of moduleSurface.exports) {
      lines.push(
        JSON.stringify({
          declaration: exportSurface.declaration,
          entrypoint: moduleSurface.entrypoint,
          exportName: exportSurface.exportName,
          importSpecifier: moduleSurface.importSpecifier,
          kind: exportSurface.kind,
          recordType: "export",
          sourceLine: exportSurface.source?.line ?? null,
          sourcePath: exportSurface.source?.path ?? null,
        }),
      );
    }
  }

  return lines;
}

export async function renderPluginSdkApiBaseline(params?: {
  repoRoot?: string;
}): Promise<PluginSdkApiBaselineRender> {
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  validateMetadata();
  const { checker, printer, program } = createCompilerContext(repoRoot);
  const modules = (Object.keys(pluginSdkDocMetadata) as PluginSdkDocEntrypoint[])
    .map((entrypoint) =>
      buildModuleSurface({
        checker,
        printer,
        program,
        repoRoot,
        entrypoint,
      }),
    )
    .toSorted((left, right) => compareText(left.importSpecifier, right.importSpecifier));

  const baseline: PluginSdkApiBaseline = {
    generatedBy: GENERATED_BY,
    modules,
  };

  return {
    baseline,
    json: `${JSON.stringify(baseline, null, 2)}\n`,
    jsonl: `${buildJsonlLines(baseline).join("\n")}\n`,
  };
}

async function loadCurrentFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Build the sha256 hash file content for plugin SDK API baseline artifacts. */
export function computePluginSdkApiBaselineHashFileContent(
  rendered: PluginSdkApiBaselineRender,
): string {
  const lines = [
    `${sha256(rendered.json)}  plugin-sdk-api-baseline.json`,
    `${sha256(rendered.jsonl)}  plugin-sdk-api-baseline.jsonl`,
  ];
  return `${lines.join("\n")}\n`;
}

function validateMetadata(): void {
  const canonicalEntrypoints = new Set<string>(publicPluginSdkEntrypoints);
  const metadataEntrypoints = new Set<string>(Object.keys(pluginSdkDocMetadata));

  for (const entrypoint of metadataEntrypoints) {
    assert(
      canonicalEntrypoints.has(entrypoint),
      `Metadata entrypoint ${entrypoint} is not exported in the Plugin SDK.`,
    );
  }
}

export async function writePluginSdkApiBaselineStatefile(params?: {
  repoRoot?: string;
  check?: boolean;
  jsonPath?: string;
  statefilePath?: string;
  hashPath?: string;
}): Promise<PluginSdkApiBaselineWriteResult> {
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  const jsonPath = path.resolve(repoRoot, params?.jsonPath ?? DEFAULT_JSON_OUTPUT);
  const statefilePath = path.resolve(repoRoot, params?.statefilePath ?? DEFAULT_STATEFILE_OUTPUT);
  const hashPath = path.resolve(repoRoot, params?.hashPath ?? DEFAULT_HASH_OUTPUT);
  const rendered = await renderPluginSdkApiBaseline({ repoRoot });

  const nextHashContent = computePluginSdkApiBaselineHashFileContent(rendered);
  const currentHashContent = await loadCurrentFile(hashPath);
  const changed = currentHashContent !== nextHashContent;

  if (params?.check) {
    return {
      changed,
      wrote: false,
      jsonPath,
      statefilePath,
      hashPath,
    };
  }

  // Write the hash file (tracked in git)
  await fs.mkdir(path.dirname(hashPath), { recursive: true });
  await fs.writeFile(hashPath, nextHashContent, "utf8");

  // Write full JSON/JSONL artifacts locally (gitignored, useful for inspection)
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, rendered.json, "utf8");
  await fs.writeFile(statefilePath, rendered.jsonl, "utf8");

  return {
    changed,
    wrote: true,
    jsonPath,
    statefilePath,
    hashPath,
  };
}
