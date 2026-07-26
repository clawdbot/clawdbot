// API baseline helpers hash public SDK exports for contract drift checks.
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
import { publicPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mjs";

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

/** Rendered baseline variants written to JSON and statefile outputs. */
export type PluginSdkApiBaselineRender = {
  /** Structured baseline data before serialization. */
  baseline: PluginSdkApiBaseline;
  /** Pretty JSON artifact for humans and docs tooling. */
  json: string;
  /** Line-delimited export records used by lightweight contract checks. */
  jsonl: string;
};

/** Result returned when writing SDK API baseline artifacts. */
export type PluginSdkApiBaselineWriteResult = {
  /** True when the generated contract manifest differs from disk. */
  changed: boolean;
  /** True when generated artifacts were actually written. */
  wrote: boolean;
  /** JSON baseline artifact path. */
  jsonPath: string;
  /** JSONL statefile artifact path. */
  statefilePath: string;
  /** Per-record SHA-256 contract manifest path. */
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

/** Normalize compiler source paths into stable repo-relative or node_modules-relative paths. */
export function normalizePluginSdkApiSourcePath(repoRoot: string, filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  const relative = path.relative(repoRoot, resolvedPath);
  const relativePosix = relative.split(path.sep).join(path.posix.sep);
  if (
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    !relativePosix.startsWith("node_modules/")
  ) {
    return relativePosix;
  }

  const pathParts = resolvedPath.split(/[\\/]+/);
  const nodeModulesIndex = pathParts.lastIndexOf("node_modules");
  if (nodeModulesIndex >= 0 && nodeModulesIndex < pathParts.length - 1) {
    return ["node_modules", ...pathParts.slice(nodeModulesIndex + 1)].join(path.posix.sep);
  }

  return relativePosix;
}

function relativePath(repoRoot: string, filePath: string): string {
  return normalizePluginSdkApiSourcePath(repoRoot, filePath);
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

/** Strip machine-local absolute paths from declaration text before hashing baseline output. */
export function normalizePluginSdkApiDeclarationText(repoRoot: string, value: string): string {
  return value.replaceAll(
    /import\("([^"]+)"((?:\s*,[^)]*)?)\)/g,
    (match, specifier: string, suffix: string) => {
      const normalized = normalizeDeclarationImportSpecifier(repoRoot, specifier);
      return normalized === specifier ? match : `import("${normalized}"${suffix})`;
    },
  );
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
  const fileNames = entrypoints
    .map((entrypoint) => path.join(repoRoot, "src", "plugin-sdk", `${entrypoint}.ts`))
    .toSorted((left, right) =>
      compareText(
        relativePath(repoRoot, path.resolve(left)),
        relativePath(repoRoot, path.resolve(right)),
      ),
    );
  const program = ts.createProgram(fileNames, parsedConfig.options);
  return {
    checker: program.getTypeChecker(),
    printer: ts.createPrinter({
      newLine: ts.NewLineKind.LineFeed,
      removeComments: true,
    }),
    program,
  };
}

/** List canonical public SDK entrypoints included in the API baseline. */
export function listPluginSdkApiBaselineEntrypoints(): string[] {
  return [...publicPluginSdkEntrypoints];
}

function buildSourceLink(repoRoot: string, filePath: string): PluginSdkApiSourceLink {
  return {
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

const DECLARATION_TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.MultilineObjectLiterals;
const DECLARATION_NODE_BUILDER_FLAGS = ts.NodeBuilderFlags.NoTruncation;

function declarationModifiers(node: ts.Node): readonly ts.Modifier[] | undefined {
  return ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
}

function inferDeclarationTypeNode(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  explicitType: ts.TypeNode | undefined,
): ts.TypeNode | undefined {
  return (
    explicitType ??
    checker.typeToTypeNode(
      checker.getTypeAtLocation(declaration),
      declaration,
      DECLARATION_NODE_BUILDER_FLAGS,
    )
  );
}

function inferDeclarationReturnTypeNode(
  checker: ts.TypeChecker,
  declaration: ts.SignatureDeclaration,
  explicitType: ts.TypeNode | undefined,
): ts.TypeNode | undefined {
  if (explicitType) {
    return explicitType;
  }
  const signature = checker.getSignatureFromDeclaration(declaration);
  return signature
    ? checker.typeToTypeNode(
        checker.getReturnTypeOfSignature(signature),
        declaration,
        DECLARATION_NODE_BUILDER_FLAGS,
      )
    : undefined;
}

function stripParameterInitializer(parameter: ts.ParameterDeclaration): ts.ParameterDeclaration {
  return ts.factory.updateParameterDeclaration(
    parameter,
    declarationModifiers(parameter),
    parameter.dotDotDotToken,
    parameter.name,
    parameter.questionToken,
    parameter.type,
    undefined,
  );
}

function stripClassMemberImplementation(
  checker: ts.TypeChecker,
  member: ts.ClassElement,
): ts.ClassElement | null {
  if (ts.isClassStaticBlockDeclaration(member)) {
    return null;
  }
  if (ts.isConstructorDeclaration(member)) {
    return ts.factory.updateConstructorDeclaration(
      member,
      declarationModifiers(member),
      member.parameters.map(stripParameterInitializer),
      undefined,
    );
  }
  if (ts.isMethodDeclaration(member)) {
    return ts.factory.updateMethodDeclaration(
      member,
      declarationModifiers(member),
      member.asteriskToken,
      member.name,
      member.questionToken,
      member.typeParameters,
      member.parameters.map(stripParameterInitializer),
      inferDeclarationReturnTypeNode(checker, member, member.type),
      undefined,
    );
  }
  if (ts.isGetAccessorDeclaration(member)) {
    return ts.factory.updateGetAccessorDeclaration(
      member,
      declarationModifiers(member),
      member.name,
      member.parameters.map(stripParameterInitializer),
      inferDeclarationReturnTypeNode(checker, member, member.type),
      undefined,
    );
  }
  if (ts.isSetAccessorDeclaration(member)) {
    return ts.factory.updateSetAccessorDeclaration(
      member,
      declarationModifiers(member),
      member.name,
      member.parameters.map(stripParameterInitializer),
      undefined,
    );
  }
  if (ts.isPropertyDeclaration(member)) {
    return ts.factory.updatePropertyDeclaration(
      member,
      declarationModifiers(member),
      member.name,
      member.questionToken ?? member.exclamationToken,
      inferDeclarationTypeNode(checker, member, member.type),
      undefined,
    );
  }
  return member;
}

function stripClassImplementation(
  checker: ts.TypeChecker,
  declaration: ts.ClassDeclaration,
  exportName: string,
): ts.ClassDeclaration {
  const members = declaration.members.flatMap((member) => {
    const stripped = stripClassMemberImplementation(checker, member);
    return stripped ? [stripped] : [];
  });
  return ts.factory.updateClassDeclaration(
    declaration,
    declarationModifiers(declaration),
    ts.factory.createIdentifier(exportName),
    declaration.typeParameters,
    declaration.heritageClauses,
    members,
  );
}

function renameStructuredDeclarationForExport(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  exportName: string,
): ts.Declaration {
  const name = ts.factory.createIdentifier(exportName);
  if (ts.isClassDeclaration(declaration)) {
    return stripClassImplementation(checker, declaration, exportName);
  }
  if (ts.isInterfaceDeclaration(declaration)) {
    return ts.factory.updateInterfaceDeclaration(
      declaration,
      declarationModifiers(declaration),
      name,
      declaration.typeParameters,
      declaration.heritageClauses,
      declaration.members,
    );
  }
  if (ts.isEnumDeclaration(declaration)) {
    return ts.factory.updateEnumDeclaration(
      declaration,
      declarationModifiers(declaration),
      name,
      declaration.members,
    );
  }
  if (ts.isModuleDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    return ts.factory.updateModuleDeclaration(
      declaration,
      declarationModifiers(declaration),
      name,
      declaration.body,
    );
  }
  return declaration;
}

function ensureExportedDeclarationText(value: string): string {
  return /^export\b/u.test(value) ? value : `export ${value}`;
}

function printTypeParameters(printer: ts.Printer, declaration: ts.TypeAliasDeclaration): string {
  if (!declaration.typeParameters?.length) {
    return "";
  }
  const sourceFile = declaration.getSourceFile();
  const parameters = declaration.typeParameters.map((typeParameter) =>
    printer.printNode(ts.EmitHint.Unspecified, typeParameter, sourceFile).trim(),
  );
  return `<${parameters.join(", ")}>`;
}

function printNode(
  repoRoot: string,
  checker: ts.TypeChecker,
  printer: ts.Printer,
  declaration: ts.Declaration,
  exportName: string,
): string | null {
  if (ts.isFunctionDeclaration(declaration)) {
    const signatures = checker.getTypeAtLocation(declaration).getCallSignatures();
    if (signatures.length === 0) {
      return `export function ${exportName}();`;
    }
    return normalizePluginSdkApiDeclarationText(
      repoRoot,
      signatures
        .map(
          (signature) =>
            `export function ${exportName}${checker.signatureToString(
              signature,
              declaration,
              DECLARATION_TYPE_FORMAT_FLAGS,
            )};`,
        )
        .join("\n"),
    );
  }

  if (ts.isVariableDeclaration(declaration)) {
    const type = checker.getTypeAtLocation(declaration);
    const prefix =
      declaration.parent && (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) !== 0
        ? "const"
        : "let";
    return normalizePluginSdkApiDeclarationText(
      repoRoot,
      `export ${prefix} ${exportName}: ${checker.typeToString(
        type,
        declaration,
        DECLARATION_TYPE_FORMAT_FLAGS,
      )};`,
    );
  }

  if (ts.isTypeAliasDeclaration(declaration)) {
    const type = checker.getTypeAtLocation(declaration);
    const typeParameters = printTypeParameters(printer, declaration);
    return normalizePluginSdkApiDeclarationText(
      repoRoot,
      `export type ${exportName}${typeParameters} = ${checker.typeToString(
        type,
        declaration,
        DECLARATION_TYPE_FORMAT_FLAGS,
      )};`,
    );
  }

  const printableDeclaration = renameStructuredDeclarationForExport(
    checker,
    declaration,
    exportName,
  );
  const text = printer
    .printNode(ts.EmitHint.Unspecified, printableDeclaration, declaration.getSourceFile())
    .trim();
  if (!text) {
    return null;
  }
  return normalizePluginSdkApiDeclarationText(repoRoot, ensureExportedDeclarationText(text));
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
  repoRoot: string;
  symbol: ts.Symbol;
}): PluginSdkApiExport {
  const { checker, printer, repoRoot, symbol } = params;
  const { declaration, resolvedSymbol } = resolveSymbolAndDeclaration(checker, repoRoot, symbol);
  const exportName = symbol.getName();
  return {
    declaration: declaration
      ? printNode(repoRoot, checker, printer, declaration, exportName)
      : null,
    exportName,
    kind: inferExportKind(resolvedSymbol, declaration),
    source: declaration ? buildSourceLink(repoRoot, declaration.getSourceFile().fileName) : null,
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
  entrypoint: string;
}): PluginSdkApiModule {
  const { checker, printer, program, repoRoot, entrypoint } = params;
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
    source: buildSourceLink(repoRoot, moduleSourcePath),
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
          sourcePath: exportSurface.source?.path ?? null,
        }),
      );
    }
  }

  return lines;
}

/** Render the current public SDK API baseline without writing generated artifacts. */
export async function renderPluginSdkApiBaseline(params?: {
  repoRoot?: string;
  entrypoints?: readonly string[];
}): Promise<PluginSdkApiBaselineRender> {
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  const entrypoints = params?.entrypoints ?? listPluginSdkApiBaselineEntrypoints();
  validateMetadata();
  const { checker, printer, program } = createCompilerContext(repoRoot, entrypoints);
  const modules = entrypoints
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

/** Build a mergeable per-entrypoint sha256 manifest for the Plugin SDK API contract. */
export function computePluginSdkApiBaselineHashFileContent(
  rendered: PluginSdkApiBaselineRender,
): string {
  return `${rendered.baseline.modules
    .map((moduleSurface) => {
      const label = `module/${encodeURIComponent(moduleSurface.entrypoint)}`;
      return `${sha256(JSON.stringify(moduleSurface))}  ${label}`;
    })
    .join("\n")}\n`;
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

/** Write or check SDK API contract artifacts used by CI and release checks. */
export async function writePluginSdkApiBaselineArtifacts(params?: {
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

  await fs.mkdir(path.dirname(hashPath), { recursive: true });
  await fs.writeFile(hashPath, nextHashContent, "utf8");
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
