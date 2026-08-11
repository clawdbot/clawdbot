// API baseline helpers render public SDK exports for contract drift checks.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  pluginSdkDocMetadata,
  type PluginSdkDocCategory,
  type PluginSdkDocEntrypoint,
} from "../../scripts/lib/plugin-sdk-doc-metadata.ts";
import {
  createDeclarationClosureRenderer,
  formatPluginSdkDiagnostics,
} from "./api-baseline-declaration-closure.js";
import { printPluginSdkExportDeclaration } from "./api-baseline-declaration-print.js";
import { normalizePluginSdkApiSourcePath as relativePath } from "./api-baseline-normalization.js";
import { publicPluginSdkEntrypoints } from "./entrypoints.ts";

export {
  normalizePluginSdkApiDeclarationText,
  normalizePluginSdkApiSourcePath,
} from "./api-baseline-normalization.js";

/** Declaration kind recorded for each public SDK export in the API baseline. */
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

/** Repo source location for a public SDK declaration or module. */
export type PluginSdkApiSourceLink = {
  /** Repo-relative source file path. */
  path: string;
};

/** One named export captured from a public SDK entrypoint. */
export type PluginSdkApiExport = {
  /** Hash of repo-owned declarations reachable from this export. */
  closureHash: string | null;
  /** Normalized TypeScript declaration text, or null when TypeScript cannot print it. */
  declaration: string | null;
  /** Exported symbol name as plugin authors import it. */
  exportName: string;
  /** Coarse declaration kind used by docs and drift reports. */
  kind: PluginSdkApiExportKind;
  /** Source location for the exported declaration when available. */
  source: PluginSdkApiSourceLink | null;
};

/** API baseline record for one public SDK module/subpath. */
export type PluginSdkApiModule = {
  /** Documentation category used to group SDK entrypoints when documented. */
  category: PluginSdkDocCategory | null;
  /** Canonical public SDK entrypoint. */
  entrypoint: string;
  /** Public exports discovered from the TypeScript program. */
  exports: PluginSdkApiExport[];
  /** Package specifier shown to plugin authors. */
  importSpecifier: string;
  /** Repo source for the SDK entrypoint file. */
  source: PluginSdkApiSourceLink;
};

/** Full generated SDK API baseline payload. */
export type PluginSdkApiBaseline = {
  /** Generator identifier used to reject hand-authored baseline files. */
  generatedBy: "scripts/generate-plugin-sdk-api-baseline.ts";
  /** Public SDK modules included in the baseline. */
  modules: PluginSdkApiModule[];
};

/** One committed Plugin SDK module contract file. */
export type PluginSdkApiBaselineContractFile = {
  /** Complete one-line JSON record, including its trailing newline. */
  content: string;
  /** Filename relative to the committed contract directory. */
  fileName: string;
};

/** Rendered baseline variants written to local and committed outputs. */
export type PluginSdkApiBaselineRender = {
  /** Structured baseline data before serialization. */
  baseline: PluginSdkApiBaseline;
  /** One deterministic committed contract file per public SDK entrypoint. */
  contractFiles: PluginSdkApiBaselineContractFile[];
  /** Pretty JSON artifact for humans and docs tooling. */
  json: string;
};

/** File-level drift in the committed Plugin SDK API contract directory. */
export type PluginSdkApiBaselineContractDiff = {
  /** Expected records whose committed content differs. */
  modified: string[];
  /** Expected records absent from the committed directory. */
  missing: string[];
  /** Unexpected JSON records left in the committed directory. */
  stale: string[];
};

/** Result returned when writing SDK API baseline artifacts. */
export type PluginSdkApiBaselineWriteResult = {
  /** True when the generated contract directory differs from disk. */
  changed: boolean;
  /** File-level drift when a check finds contract differences. */
  contractDiff: PluginSdkApiBaselineContractDiff | null;
  /** Committed per-entrypoint contract directory. */
  contractDirectory: string;
  /** True when generated artifacts were actually written. */
  wrote: boolean;
  /** JSON baseline artifact path. */
  jsonPath: string;
  /** Number of stale JSON records removed in write mode. */
  removedStaleCount: number;
};

const GENERATED_BY = "scripts/generate-plugin-sdk-api-baseline.ts" as const;
const DEFAULT_JSON_OUTPUT = "docs/.generated/plugin-sdk-api-baseline.json";
const DEFAULT_CONTRACT_DIRECTORY = "docs/.generated/plugin-sdk-api-baseline";
const SAFE_ENTRYPOINT_FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
type DeclarationClosureRenderer = ReturnType<typeof createDeclarationClosureRenderer>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function createCompilerContext(repoRoot: string, entrypoints: readonly string[]) {
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
  if (parsedConfig.errors.length > 0) {
    throw new Error(formatPluginSdkDiagnostics(parsedConfig.errors, repoRoot));
  }
  const fileNames = entrypoints
    .map((entrypoint) => path.join(repoRoot, "src", "plugin-sdk", `${entrypoint}.ts`))
    .toSorted((left, right) =>
      compareText(
        relativePath(repoRoot, path.resolve(left)),
        relativePath(repoRoot, path.resolve(right)),
      ),
    );
  const program = ts.createProgram(fileNames, {
    ...parsedConfig.options,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    noEmit: false,
    // Declaration diagnostics are checked explicitly; unrelated untyped external JS stays valid.
    noEmitOnError: false,
    removeComments: true,
    sourceMap: false,
  });
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
  return {
    checker: program.getTypeChecker(),
    declarationClosure: createDeclarationClosureRenderer({
      printer,
      program,
      repoRoot,
    }),
    printer,
    program,
  };
}

/** List canonical public SDK entrypoints included in the API baseline. */
export function listPluginSdkApiBaselineEntrypoints(): string[] {
  return [...publicPluginSdkEntrypoints];
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

  for (const [flag, kind] of [
    [ts.SymbolFlags.Function, "function"],
    [ts.SymbolFlags.Class, "class"],
    [ts.SymbolFlags.Interface, "interface"],
    [ts.SymbolFlags.TypeAlias, "type"],
    [ts.SymbolFlags.ConstEnum | ts.SymbolFlags.RegularEnum, "enum"],
    [ts.SymbolFlags.Variable, "variable"],
    [ts.SymbolFlags.NamespaceModule | ts.SymbolFlags.ValueModule, "namespace"],
  ] as const) {
    if (symbol.flags & flag) {
      return kind;
    }
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDeclarations(
  repoRoot: string,
  left: ts.Declaration,
  right: ts.Declaration,
): number {
  return (
    compareText(
      relativePath(repoRoot, left.getSourceFile().fileName),
      relativePath(repoRoot, right.getSourceFile().fileName),
    ) ||
    left.getStart() - right.getStart() ||
    left.kind - right.kind
  );
}

function buildExportSurface(params: {
  checker: ts.TypeChecker;
  declarationClosure: DeclarationClosureRenderer;
  printer: ts.Printer;
  repoRoot: string;
  symbol: ts.Symbol;
}): PluginSdkApiExport {
  const { checker, declarationClosure, printer, repoRoot, symbol } = params;
  const { declaration, resolvedSymbol } = resolveSymbolAndDeclaration(checker, repoRoot, symbol);
  const exportName = symbol.getName();
  const declarationName = declaration ? ts.getNameOfDeclaration(declaration) : undefined;
  const closureName =
    declarationName && ts.isIdentifier(declarationName) ? declarationName.text : exportName;
  const declarationText = declaration
    ? printPluginSdkExportDeclaration(repoRoot, checker, printer, declaration, exportName)
    : null;
  const declarationSource = declaration?.getSourceFile();
  return {
    closureHash:
      declarationSource && declarationText
        ? (declarationClosure(declarationSource, closureName)?.hash ?? null)
        : null,
    declaration: declarationText,
    exportName,
    kind: inferExportKind(resolvedSymbol, declaration),
    source: declarationSource ? { path: relativePath(repoRoot, declarationSource.fileName) } : null,
  };
}

const EXPORT_KIND_SORT_RANK: Record<PluginSdkApiExportKind, number> = {
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

function sortExports(left: PluginSdkApiExport, right: PluginSdkApiExport): number {
  return (
    EXPORT_KIND_SORT_RANK[left.kind] - EXPORT_KIND_SORT_RANK[right.kind] ||
    compareText(left.exportName, right.exportName)
  );
}

function buildModuleSurface(params: {
  checker: ts.TypeChecker;
  declarationClosure: DeclarationClosureRenderer;
  printer: ts.Printer;
  program: ts.Program;
  repoRoot: string;
  entrypoint: string;
}): PluginSdkApiModule {
  const { checker, declarationClosure, printer, program, repoRoot, entrypoint } = params;
  const metadata = Object.hasOwn(pluginSdkDocMetadata, entrypoint)
    ? pluginSdkDocMetadata[entrypoint as PluginSdkDocEntrypoint]
    : undefined;
  const importSpecifier = `openclaw/plugin-sdk/${entrypoint}`;
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
        declarationClosure,
        printer,
        repoRoot,
        symbol,
      }),
    )
    .toSorted(sortExports);

  return {
    category: metadata?.category ?? null,
    entrypoint,
    exports,
    importSpecifier,
    source: { path: relativePath(repoRoot, moduleSourcePath) },
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function buildContractFiles(baseline: PluginSdkApiBaseline): PluginSdkApiBaselineContractFile[] {
  return baseline.modules.map((moduleSurface) => {
    assert(
      SAFE_ENTRYPOINT_FILE_NAME.test(moduleSurface.entrypoint),
      `Plugin SDK entrypoint is not filename-safe: ${moduleSurface.entrypoint}`,
    );
    const contractSurface = {
      category: moduleSurface.category,
      entrypoint: moduleSurface.entrypoint,
      exports: moduleSurface.exports.map((exportSurface) => ({
        closureHash: exportSurface.closureHash,
        declaration: exportSurface.declaration,
        exportName: exportSurface.exportName,
        kind: exportSurface.kind,
      })),
      importSpecifier: moduleSurface.importSpecifier,
    };
    return {
      content: `${JSON.stringify({
        contentHash: sha256(JSON.stringify(contractSurface)),
        entrypoint: moduleSurface.entrypoint,
        importSpecifier: moduleSurface.importSpecifier,
      })}\n`,
      fileName: `${moduleSurface.entrypoint}.json`,
    };
  });
}

/** Render the current public SDK API baseline without writing generated artifacts. */
export async function renderPluginSdkApiBaseline(params?: {
  repoRoot?: string;
  entrypoints?: readonly string[];
}): Promise<PluginSdkApiBaselineRender> {
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  const entrypoints = params?.entrypoints ?? listPluginSdkApiBaselineEntrypoints();
  validateMetadata();
  const { checker, declarationClosure, printer, program } = createCompilerContext(
    repoRoot,
    entrypoints,
  );
  const modules = [...entrypoints].toSorted(compareText).map((entrypoint) =>
    buildModuleSurface({
      checker,
      declarationClosure,
      printer,
      program,
      repoRoot,
      entrypoint,
    }),
  );

  return renderPluginSdkApiBaselineModules(modules);
}

/** Serialize discovered SDK modules in canonical order without rebuilding declarations. */
export function renderPluginSdkApiBaselineModules(
  modules: readonly PluginSdkApiModule[],
): PluginSdkApiBaselineRender {
  const baseline: PluginSdkApiBaseline = {
    generatedBy: GENERATED_BY,
    modules: [...modules].toSorted((left, right) =>
      compareText(left.importSpecifier, right.importSpecifier),
    ),
  };

  return {
    baseline,
    contractFiles: buildContractFiles(baseline),
    json: `${JSON.stringify(baseline, null, 2)}\n`,
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

async function listContractFileNames(contractDirectory: string): Promise<string[]> {
  try {
    return (await fs.readdir(contractDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .toSorted(compareText);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** Compare or write an already-rendered SDK API contract. */
export async function writeRenderedPluginSdkApiBaselineArtifacts(params: {
  check?: boolean;
  contractDirectory: string;
  jsonPath: string;
  rendered: PluginSdkApiBaselineRender;
}): Promise<PluginSdkApiBaselineWriteResult> {
  const currentFileNames = await listContractFileNames(params.contractDirectory);
  const expectedFileNames = new Set(params.rendered.contractFiles.map((file) => file.fileName));
  const contractDiff: PluginSdkApiBaselineContractDiff = {
    modified: [],
    missing: [],
    stale: currentFileNames.filter((fileName) => !expectedFileNames.has(fileName)),
  };
  for (const contractFile of params.rendered.contractFiles) {
    const current = await loadCurrentFile(
      path.join(params.contractDirectory, contractFile.fileName),
    );
    if (current === null) {
      contractDiff.missing.push(contractFile.fileName);
    } else if (current !== contractFile.content) {
      contractDiff.modified.push(contractFile.fileName);
    }
  }
  const changed = Object.values(contractDiff).some((fileNames) => fileNames.length > 0);

  if (params.check) {
    return {
      changed,
      contractDiff: changed ? contractDiff : null,
      contractDirectory: params.contractDirectory,
      wrote: false,
      jsonPath: params.jsonPath,
      removedStaleCount: 0,
    };
  }

  await fs.mkdir(params.contractDirectory, { recursive: true });
  for (const contractFile of params.rendered.contractFiles) {
    await fs.writeFile(
      path.join(params.contractDirectory, contractFile.fileName),
      contractFile.content,
      "utf8",
    );
  }
  for (const fileName of contractDiff.stale) {
    await fs.unlink(path.join(params.contractDirectory, fileName));
  }
  await fs.mkdir(path.dirname(params.jsonPath), { recursive: true });
  await fs.writeFile(params.jsonPath, params.rendered.json, "utf8");

  return {
    changed,
    contractDiff: null,
    contractDirectory: params.contractDirectory,
    wrote: true,
    jsonPath: params.jsonPath,
    removedStaleCount: contractDiff.stale.length,
  };
}

/** Render, then write or check SDK API contract artifacts used by CI and release checks. */
export async function writePluginSdkApiBaselineArtifacts(params?: {
  repoRoot?: string;
  check?: boolean;
  contractDirectory?: string;
  jsonPath?: string;
}): Promise<PluginSdkApiBaselineWriteResult> {
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  return writeRenderedPluginSdkApiBaselineArtifacts({
    check: params?.check,
    contractDirectory: path.resolve(
      repoRoot,
      params?.contractDirectory ?? DEFAULT_CONTRACT_DIRECTORY,
    ),
    jsonPath: path.resolve(repoRoot, params?.jsonPath ?? DEFAULT_JSON_OUTPUT),
    rendered: await renderPluginSdkApiBaseline({ repoRoot }),
  });
}
