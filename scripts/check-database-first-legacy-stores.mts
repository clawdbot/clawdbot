#!/usr/bin/env node

// Guards database-first state ownership by blocking legacy store writes in runtime code.
import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  explicitUndefinedLegacyObjectPropertyValue,
  mergeConditionalLegacyObjectPropertyValue,
  mergeConditionalLiteralTexts,
  mergeExhaustiveLiteralTexts,
  mergeLegacyObjectPropertyValues,
  mergeLegacyPathBranchAssignments,
  type LegacyObjectPropertyValue as LegacyPropertyValue,
  type LegacyPathBranchAssignment,
} from "./lib/legacy-store-path-domain.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { runAsScript, toLine, unwrapExpression } from "./lib/ts-guard-utils.mts";

type LegacyStoreViolation = { kind: string; line: number };
type StringMap<Value> = Map<string, Value>;
type ScopeStack<Value> = Array<StringMap<Value>>;
type WrapperNode = ts.FunctionLikeDeclaration;
type LexicalScope = StringMap<unknown> | Set<string>;
type WrapperRecord = { environment: LexicalScope[][]; node: WrapperNode };
type WrapperValue = WrapperRecord | WrapperRecord[] | null;

function undefinedFact(
  expression: ts.Expression | null = null,
  fsSafeFactory: string | null = null,
  fsWrite: string | null = null,
  wrapper: WrapperValue = null,
) {
  return {
    root: "<argument>",
    expression,
    fsModule: false,
    fsModules: new Map<string, boolean>(),
    fsSafeFactory,
    fsWrite,
    fsWrites: new Map<string, string | null>(),
    jsonStore: false,
    jsonStores: new Map<string, boolean>(),
    knownObject: false,
    knownObjects: new Map<string, boolean>(),
    knownUndefined: true,
    legacyPath: false,
    literalTexts: new Array<string>(),
    properties: new Map<string, LegacyPropertyValue>(),
    requireAlias: false,
    store: false,
    stores: new Map<string, boolean>(),
    wrapper,
    wrappers: new Map<string, WrapperValue>(),
  };
}

type ExpressionFact = ReturnType<typeof undefinedFact> & { possiblyUndefined?: boolean };
type BranchIdentifierAssignment = LegacyPathBranchAssignment & {
  index: number;
  name: string;
  literalTexts: string[];
};
type BranchPropertyAssignment = {
  index: number;
  objectName: string;
  propertyName: string;
  value: LegacyPropertyValue;
  knownObjectLiteral: boolean;
};
type BranchFsIdentifierAssignment = {
  index: number;
  name: string;
  moduleValue: boolean;
  writeAlias: string | null;
  fsSafeFactoryAlias: string | null;
  fsSafeStoreValue: boolean;
  fsSafeJsonStoreValue: boolean;
  requireAlias: boolean;
};
type BranchFsSafePropertyAssignment = {
  index: number;
  objectName: string;
  propertyName: string;
  storeValue: boolean;
  jsonStoreValue: boolean;
};
type BranchWrapperAssignment = { index: number; name: string; value: WrapperValue };
type TrackedObjectMethodsParams = {
  objectName: string;
  initializer: ts.Expression;
  directSourceName?: (expression: ts.Expression) => string | null;
  spreadSourceName?: (expression: ts.Expression) => string | null;
  onAlias?: (targetName: string, sourceName: string) => void;
  onUnknownSpread?: (objectName: string) => void;
  onSpread?: (targetName: string, sourceName: string) => void;
  onPropertyName?: (propertyName: string, key: string) => void;
  onMethod: (key: string, method: WrapperNode) => void;
  onIdentifier: (key: string, identifier: string, expression: ts.Expression) => void;
  onNested: (key: string, nested: ts.ObjectLiteralExpression) => void;
  onOther?: (key: string, value: ts.Expression, hasNestedObject: boolean) => void;
};

const isWrapperNode = (node: ts.Node): node is WrapperNode =>
  ts.isFunctionLike(node) && "body" in node;

const databaseFirstLegacyStoreSourceRoots = ["src", "extensions", "packages"];
const databaseFirstNativeSourceRoots = ["apps/macos/Sources/OpenClaw"];
const nativeLegacyPortGuardianMigrationPath =
  "apps/macos/Sources/OpenClaw/PortGuardianRecordStore.swift";
const nativeLegacyPortGuardianFilenamePattern = /\bport-guard\.(?:json|lock)\b/u;
const unknownComputedPropertyName = "\0";

const legacyWriteCallees = new Set([
  "appendFile",
  "appendFileSync",
  "cp",
  "cpSync",
  "copyFile",
  "copyFileSync",
  "createWriteStream",
  "open",
  "openSync",
  "rm",
  "rmSync",
  "unlink",
  "unlinkSync",
  "rename",
  "renameSync",
  "writeFile",
  "writeFileSync",
]);

const fsModuleSpecifiers = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);

const helperWriteCallees = new Set([
  "acquireFileLock",
  "appendRegularFile",
  "appendRegularFileSync",
  "replaceFileAtomic",
  "replaceFileAtomicSync",
  "saveJsonFile",
  "writeJson",
  "writeJsonAtomic",
  "writeJsonFileAtomically",
  "writeJsonSync",
  "writeTextAtomic",
  "withFileLock",
]);

const fsSafeStoreFactoryCallees = new Set([
  "fileStore",
  "fileStoreSync",
  "privateFileStore",
  "privateFileStoreSync",
  "root",
]);
const fsSafeJsonStoreFactoryCallees = new Set(["jsonStore"]);

const fsSafeStoreWriteMethods = new Set([
  "append",
  "copyIn",
  "create",
  "createJson",
  "mkdir",
  "move",
  "openWritable",
  "remove",
  "write",
  "writeJson",
  "writeStream",
  "writeText",
]);
const fsSafeJsonStoreWriteMethods = new Set(["update", "updateOr", "write"]);

const helperWriteModulePattern =
  /(?:^|\/)(?:file-lock|fs-safe|json-files|json-store|private-file-store|replace-file)(?:\.[cm]?[jt]s)?$/u;
const fsSafePackageModulePattern = /^@openclaw\/fs-safe(?:\/(?:root|store))?$/u;

const bridgeMarkerPattern = /\btranscriptLocator\b|sqlite-transcript:\/\//u;

// The restart handoff must survive its one cutover migration without leaving
// filesystem fallback imports in the steady-state runtime owner.
const legacyRestartSentinelMigrationPath = "src/infra/state-migrations.restart-sentinel.ts";
const legacyRestartSentinelPreflightPath = "src/cli/program/config-guard.ts";
const legacyRestartSentinelRuntimePath = "src/infra/restart-sentinel.ts";
const legacyRestartSentinelPreflightFilenames = new Set([
  "restart-sentinel.json",
  "restart-sentinel.json.doctor-importing",
]);
const legacyRestartSentinelFilenamePattern =
  /(?:^|[/\\])restart-sentinel\.json(?:\.doctor-importing)?$/u;
const legacyRestartSentinelRuntimeImportSpecifiers = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
  "node:path",
  "path",
]);
const legacyExecApprovalsMigrationPath = "src/infra/state-migrations.exec-approvals.ts";
const legacyExecApprovalsConfigPath = "src/infra/exec-approvals-config.ts";
const legacyExecApprovalsRuntimePath = "src/infra/exec-approvals-store.ts";
// Stable oc:// URI identity, not a filesystem path; see the owning module.
const stableExecApprovalsPolicyUriPath = "extensions/policy/src/exec-approvals-uri.ts";
const legacyExecApprovalsFilenamePattern =
  /(?:^|[/\\])exec-approvals\.json(?:\.doctor-importing)?$/u;

const legacyStorePatterns = [
  /\bsessions\.json\b/u,
  /\.trajectory\.jsonl\b/u,
  /\.acp-stream\.jsonl\b/u,
  /\bacp\/event-ledger\.json\b/u,
  /\bcache\/[^"'`]*\.json\b/u,
  /\bagents\/[^"'`]+\/agent\/(?:auth|models)\.json\b/u,
  /\b(?:credentials\/oauth|github-copilot\.token|openrouter-models|auth-profiles|auth-state|exec-approvals|(?:openclaw-)?workspace-state)\.json\b/u,
  // Dynamic template spans resolve to `*`, so the start alternative also
  // catches `${workspaceKey}.attested` and `${workspaceDir}.attested`.
  /(?:^|[/\\])[^/\\"'`]+\.attested\b/u,
  /\btui\/last-session\.json\b/u,
  /\bcommitments\/commitments\.json\b/u,
  /\bmedia\/outgoing\/records\/[^"'`]*\.json\b/u,
  /\bpush\/(?:apns-registrations|web-push-subscriptions|vapid-keys)\.json\b/u,
  /\bmcp-oauth\/[^"'`]*\.json\b/u,
  /\bnode\.json\b/u,
  /\bidentity\/device\.json\b/u,
  /\bsubagents\/runs\.json\b/u,
  /\btmp\/skill-uploads\b/u,
  /\b(?:crestodian|openclaw)\/rescue-pending\/[^"'`]*\.json\b/u,
  /\bcron\/(?:runs\/[^"'`]+\.jsonl|jobs\.json|jobs-state\.json)\b/u,
  /\b(?:process-leases|session-toggles|known-users|msteams-conversations|msteams-polls|msteams-sso-tokens|bot-storage|sync-store|thread-bindings|inbound-dedupe|startup-verification|storage-meta|crypto-idb-snapshot|command-deploy-cache|plugin-binding-approvals|plugins\/installs|config-health|port-guard|restart-sentinel|gateway-restart-intent|gateway-supervisor-restart-handoff)\.json\b/u,
  /\b(?:calls|ref-index|config-audit|audit\/(?:file-transfer|openclaw|system-agent|crestodian))\.jsonl\b/u,
  /\b(?:reply-cache|sent-echoes|events|claims)\.jsonl\b/u,
  /\bplugin-state\/state\.sqlite\b/u,
  /\btasks\/(?:runs\.sqlite|flows\/registry\.sqlite)\b/u,
  /\bopenclaw-state\.sqlite\b/u,
  /\bopenclaw-native-hook-relays\b/u,
  /(?:^|\/)(?:meta|file-meta)\.json$/u,
  /(?:^|\/)viewer\.html$/u,
  /(?:^|\/)qmd\/embed\.lock(?:\.lock)?$/u,
  /(?:^|\/)qmd-write\.lock(?:\.lock)?$/u,
];

const allowedRuntimeMigrationPaths = [
  "src/commands/doctor/",
  "src/commands/doctor-usage-cost-cache.ts",
  "src/infra/session-state-migration.ts",
  "src/infra/state-migrations.ts",
  "src/infra/state-migrations.acp-replay.ts",
  "src/infra/state-migrations.tui-last-session.ts",
  "src/infra/state-migrations.managed-outgoing-images.ts",
  "src/infra/state-migrations.apns.ts",
  "src/infra/state-migrations.mcp-oauth.ts",
  legacyExecApprovalsMigrationPath,
  legacyRestartSentinelMigrationPath,
  "src/infra/state-migrations.workspace-setup.ts",
  "src/infra/state-migrations.web-push.ts",
  "src/infra/state-migrations.node-host.ts",
  "src/infra/state-migrations.device-identity.ts",
  "src/infra/state-migrations.subagent-registry.ts",
  "src/infra/state-migrations.rescue-pending.ts",
  "src/commands/session-state-migration.ts",
  "src/commands/doctor-state-migrations.test.ts",
];

const allowedFixturePaths = new Set(["extensions/qa-lab/src/providers/shared/auth-store.ts"]);

const sourceFileExtensions = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".tsx"]);

const sourceTestExtensions = ["js", "mjs", "ts"];
const sourceTestHelperStems = [
  "test-fixtures",
  "test-helper",
  "test-helpers",
  "test-harness",
  "test-mocks",
  "test-support",
  "test-utils",
];
const sourceTestSuffixes = [
  ...["e2e-harness", ...sourceTestHelperStems, "test"].flatMap((stem) =>
    sourceTestExtensions.map((extension) => `.${stem}.${extension}`),
  ),
  ...sourceTestHelperStems.flatMap((stem) =>
    sourceTestExtensions.map((extension) => `${stem}.${extension}`),
  ),
];

function isAllowedLegacyOwnerPath(relativePath: string) {
  return (
    allowedFixturePaths.has(relativePath) ||
    allowedRuntimeMigrationPaths.some((allowed) => relativePath.startsWith(allowed)) ||
    /^extensions\/[^/]+\/(?:doctor-contract-api|legacy-state-migrations-api)\.ts$/u.test(
      relativePath,
    )
  );
}

function lastScope<Scope>(scopes: Scope[]) {
  return scopes[scopes.length - 1]!;
}

function scopeForRead<Value>(scopes: ScopeStack<Value>, name: string) {
  return scopes.findLast((scope) => scope.has(name));
}

function scopeForWrite<Value>(scopes: ScopeStack<Value>, name: string) {
  return scopeForRead(scopes, name) ?? lastScope(scopes);
}

function isSourceFile(filePath: string) {
  return sourceFileExtensions.has(path.extname(filePath));
}

function isGeneratedAssetSourceFile(filePath: string) {
  const normalized = filePath.replaceAll(path.sep, "/");
  return (
    /(?:^|\/)extensions\/[^/]+\/(?:assets|dist)\/.+\.[cm]?js$/u.test(normalized) ||
    /(?:^|\/)extensions\/canvas\/src\/host\/a2ui\/[^/]+\.bundle\.js$/u.test(normalized) ||
    /(?:^|\/)packages\/[^/]+\/dist\/.+\.[cm]?js$/u.test(normalized)
  );
}

function isGeneratedAssetSourcePath(filePath: string) {
  return (
    /(?:^|\/)extensions\/[^/]+\/(?:assets|dist)(?:\/|$)/u.test(
      filePath.replaceAll(path.sep, "/"),
    ) || /(?:^|\/)packages\/[^/]+\/dist(?:\/|$)/u.test(filePath.replaceAll(path.sep, "/"))
  );
}

function isTestLikeSourceFile(filePath: string) {
  return sourceTestSuffixes.some((suffix) => filePath.endsWith(suffix));
}

async function collectFiles(
  targetPath: string,
  includeFile: (filePath: string) => boolean,
  skipEntry: (entryPath: string, entry: import("node:fs").Dirent) => boolean = () => false,
): Promise<string[]> {
  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  if (stat.isFile()) {
    return includeFile(targetPath) ? [targetPath] : [];
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (skipEntry(entryPath, entry)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath, includeFile, skipEntry)));
      continue;
    }
    if (entry.isFile() && includeFile(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

function collectSourceFiles(targetPath: string) {
  return collectFiles(
    targetPath,
    (filePath) =>
      isSourceFile(filePath) &&
      !isTestLikeSourceFile(filePath) &&
      !isGeneratedAssetSourceFile(filePath),
    (entryPath, entry) => entry.name === "node_modules" || isGeneratedAssetSourcePath(entryPath),
  );
}

export async function collectDatabaseFirstLegacyStoreSourceFiles(sourceRoots: string[]) {
  return (await Promise.all(sourceRoots.map((root) => collectSourceFiles(root)))).flat();
}

function collectNativeSourceFiles(targetPath: string) {
  return collectFiles(targetPath, (filePath) => path.extname(filePath) === ".swift");
}

export function collectDatabaseFirstNativeLegacyStoreViolations(
  content: string,
  relativePath: string,
): LegacyStoreViolation[] {
  if (relativePath === nativeLegacyPortGuardianMigrationPath) {
    return [];
  }
  return content
    .split("\n")
    .flatMap((line, index) =>
      nativeLegacyPortGuardianFilenamePattern.test(line)
        ? [{ kind: "legacy PortGuardian file reference", line: index + 1 }]
        : [],
    );
}

function importSource(node: ts.ImportDeclaration) {
  const moduleSpecifier = node.moduleSpecifier;
  return ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : "";
}

function isLegacyRestartSentinelPreflightDetection(
  node: ts.StringLiteralLike,
  relativePath: string,
) {
  if (
    relativePath !== legacyRestartSentinelPreflightPath ||
    !legacyRestartSentinelPreflightFilenames.has(node.text)
  ) {
    return false;
  }
  const joinCall = node.parent;
  if (
    !ts.isCallExpression(joinCall) ||
    joinCall.arguments.length !== 2 ||
    joinCall.arguments[1] !== node ||
    !ts.isPropertyAccessExpression(joinCall.expression) ||
    !ts.isIdentifier(joinCall.expression.expression) ||
    joinCall.expression.expression.text !== "path" ||
    joinCall.expression.name.text !== "join" ||
    !ts.isIdentifier(joinCall.arguments[0]!) ||
    joinCall.arguments[0]!.text !== "stateDir"
  ) {
    return false;
  }
  const paths = joinCall.parent;
  if (!ts.isArrayLiteralExpression(paths)) {
    return false;
  }
  const someAccess = paths.parent;
  if (
    !ts.isPropertyAccessExpression(someAccess) ||
    someAccess.expression !== paths ||
    someAccess.name.text !== "some"
  ) {
    return false;
  }
  const someCall = someAccess.parent;
  return (
    ts.isCallExpression(someCall) &&
    someCall.arguments.length === 1 &&
    ts.isIdentifier(someCall.arguments[0]!) &&
    someCall.arguments[0]!.text === "fileOrDirExists"
  );
}

function collectLegacyRestartSentinelBoundaryViolations(
  sourceFile: ts.SourceFile,
  relativePath: string,
) {
  if (relativePath === legacyRestartSentinelMigrationPath) {
    return [];
  }

  const violations: LegacyStoreViolation[] = [];
  const seen = new Set<string>();
  function add(node: ts.Node, kind: string) {
    const line = toLine(sourceFile, node);
    const key = `${line}:${kind}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    violations.push({ kind, line });
  }

  function visit(node: ts.Node) {
    if (
      ts.isStringLiteralLike(node) &&
      legacyRestartSentinelFilenamePattern.test(node.text) &&
      !isLegacyRestartSentinelPreflightDetection(node, relativePath)
    ) {
      add(node, "legacy restart sentinel reference");
    }
    if (
      relativePath === legacyRestartSentinelRuntimePath &&
      ts.isImportDeclaration(node) &&
      legacyRestartSentinelRuntimeImportSpecifiers.has(importSource(node))
    ) {
      add(node, "legacy restart sentinel filesystem import");
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

function collectLegacyExecApprovalsBoundaryViolations(
  sourceFile: ts.SourceFile,
  relativePath: string,
) {
  if (
    relativePath === legacyExecApprovalsMigrationPath ||
    relativePath === legacyExecApprovalsConfigPath ||
    relativePath === stableExecApprovalsPolicyUriPath
  ) {
    return [];
  }

  const violations: LegacyStoreViolation[] = [];
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) && legacyExecApprovalsFilenamePattern.test(node.text)) {
      violations.push({
        kind: "legacy exec approvals reference",
        line: toLine(sourceFile, node),
      });
    }
    if (
      relativePath === legacyExecApprovalsRuntimePath &&
      ts.isImportDeclaration(node) &&
      legacyRestartSentinelRuntimeImportSpecifiers.has(importSource(node))
    ) {
      violations.push({
        kind: "legacy exec approvals filesystem import",
        line: toLine(sourceFile, node),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

function isHelperWriteModuleSource(source: string) {
  return (
    source === "openclaw/plugin-sdk/file-access-runtime" ||
    source === "openclaw/plugin-sdk/security-runtime" ||
    fsSafePackageModulePattern.test(source) ||
    helperWriteModulePattern.test(source)
  );
}

function collectCreateRequireBindings(sourceFile: ts.SourceFile) {
  const bindings = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) && ["node:module", "module"].includes(importSource(node))) {
      const namedBindings = node.importClause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === "createRequire") {
            bindings.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return bindings;
}

function isFsRequireExpression(
  expression: ts.Expression,
  isRequireName: (name: string) => boolean = (name) => name === "require",
) {
  const call = unwrapExpression(expression);
  if (!ts.isCallExpression(call)) {
    return false;
  }
  const requireExpression = unwrapExpression(call.expression);
  if (!ts.isIdentifier(requireExpression)) {
    return false;
  }
  const requireName = requireExpression.text;
  const [specifier] = call.arguments;
  return (
    isRequireName(requireName) &&
    specifier !== undefined &&
    ts.isStringLiteralLike(specifier) &&
    fsModuleSpecifiers.has(specifier.text)
  );
}

function unwrapAwaitExpression(expression: ts.Expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isAwaitExpression(unwrapped) ? unwrapExpression(unwrapped.expression) : unwrapped;
}

function isFsDynamicImportExpression(expression: ts.Expression) {
  const call = unwrapAwaitExpression(expression);
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) {
    return false;
  }
  const [specifier] = call.arguments;
  return (
    specifier !== undefined &&
    ts.isStringLiteralLike(specifier) &&
    fsModuleSpecifiers.has(specifier.text)
  );
}

function collectFsBindings(sourceFile: ts.SourceFile) {
  const fsModuleBindings = new Set<string>();
  const fsWriteAliases = new Map<string, string | null>();
  const fsSafeStoreFactoryAliases = new Map<string, string | null>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const source = importSource(statement);
    const clause = statement.importClause;
    if (!clause) {
      continue;
    }
    if (clause.name && fsModuleSpecifiers.has(source)) {
      fsModuleBindings.add(clause.name.text);
    }
    const namedBindings = clause.namedBindings;
    if (!namedBindings) {
      continue;
    }
    if (ts.isNamespaceImport(namedBindings)) {
      if (fsModuleSpecifiers.has(source)) {
        fsModuleBindings.add(namedBindings.name.text);
      }
      if (isHelperWriteModuleSource(source)) {
        for (const helperName of helperWriteCallees) {
          fsWriteAliases.set(`${namedBindings.name.text}.${helperName}`, helperName);
        }
        for (const factoryName of [
          ...fsSafeStoreFactoryCallees,
          ...fsSafeJsonStoreFactoryCallees,
        ]) {
          fsSafeStoreFactoryAliases.set(`${namedBindings.name.text}.${factoryName}`, factoryName);
        }
      }
      continue;
    }
    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (fsModuleSpecifiers.has(source) && importedName === "promises") {
        fsModuleBindings.add(element.name.text);
      }
      if (fsModuleSpecifiers.has(source) && legacyWriteCallees.has(importedName)) {
        fsWriteAliases.set(element.name.text, importedName);
      }
      if (isHelperWriteModuleSource(source) && helperWriteCallees.has(importedName)) {
        fsWriteAliases.set(element.name.text, importedName);
      }
      if (
        isHelperWriteModuleSource(source) &&
        (fsSafeStoreFactoryCallees.has(importedName) ||
          fsSafeJsonStoreFactoryCallees.has(importedName))
      ) {
        fsSafeStoreFactoryAliases.set(element.name.text, importedName);
      }
    }
  }

  return { fsModuleBindings, fsWriteAliases, fsSafeStoreFactoryAliases };
}

function templateCandidateText(current: ts.TemplateExpression) {
  let text = current.head.text;
  for (const span of current.templateSpans) {
    text += `*${span.literal.text}`;
  }
  return text || "*";
}

function legacyCandidateTexts(sourceFile: ts.SourceFile, node: ts.Expression) {
  const candidates = node.pos >= 0 && node.end >= 0 ? [node.getText(sourceFile)] : [];
  const stringSegments: string[] = [];

  function binaryExpressionCandidateText(current: ts.BinaryExpression): string | null {
    if (current.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
      return null;
    }
    const left = pathSegmentCandidateText(current.left);
    const right = pathSegmentCandidateText(current.right);
    if (!left && !right) {
      return null;
    }
    return `${left ?? "*"}${right ?? "*"}`;
  }

  function pathSegmentCandidateText(current: ts.Expression) {
    const unwrapped = unwrapExpression(current);
    if (ts.isStringLiteralLike(unwrapped)) {
      return unwrapped.text;
    }
    if (ts.isTemplateExpression(unwrapped)) {
      return templateCandidateText(unwrapped);
    }
    if (ts.isBinaryExpression(unwrapped)) {
      return binaryExpressionCandidateText(unwrapped) ?? "*";
    }
    return "*";
  }

  if (candidates.length === 0) {
    const syntheticPathSegment = pathSegmentCandidateText(node);
    if (syntheticPathSegment !== "*") {
      candidates.push(syntheticPathSegment);
    }
  }

  function maybeAddCallPathCandidate(current: ts.Node) {
    if (!ts.isCallExpression(current) || current.arguments.length < 2) {
      return;
    }
    const segments = current.arguments.map((argument) => pathSegmentCandidateText(argument));
    if (!segments.some((segment) => segment !== "*")) {
      return;
    }
    candidates.push(segments.join("/"));
  }

  function visit(current: ts.Node) {
    maybeAddCallPathCandidate(current);
    if (ts.isStringLiteralLike(current)) {
      stringSegments.push(current.text);
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  if (stringSegments.length > 1) {
    candidates.push(stringSegments.join("/"));
  }
  return candidates;
}

/**
 * Finds database-first legacy-store violations in one TypeScript/JavaScript source file.
 */
export function collectDatabaseFirstLegacyStoreViolations(
  content: string,
  inputRelativePath = "source.ts",
): LegacyStoreViolation[] {
  const relativePath = inputRelativePath.replaceAll("\\", "/");
  const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true);
  const boundaryViolations = [
    ...collectLegacyRestartSentinelBoundaryViolations(sourceFile, relativePath),
    ...collectLegacyExecApprovalsBoundaryViolations(sourceFile, relativePath),
  ];
  if (isAllowedLegacyOwnerPath(relativePath)) {
    return boundaryViolations;
  }

  const createRequireBindings = collectCreateRequireBindings(sourceFile);
  const { fsModuleBindings, fsWriteAliases, fsSafeStoreFactoryAliases } =
    collectFsBindings(sourceFile);
  const violations: LegacyStoreViolation[] = [...boundaryViolations];
  const seenViolations = new Set(
    boundaryViolations.map((violation) => `${violation.line}:${violation.kind}`),
  );
  const fsModuleBindingScopes = [
    new Map<string, boolean>([...fsModuleBindings].map((name) => [name, true])),
  ];
  const fsModulePropertyScopes = [new Map<string, boolean>()];
  const fsWriteAliasScopes = [fsWriteAliases];
  const fsSafeStoreFactoryAliasScopes = [fsSafeStoreFactoryAliases];
  const fsSafeStoreScopes = [new Map<string, boolean>()];
  const fsSafeJsonStoreScopes = [new Map<string, boolean>()];
  const requireAliasScopes = [new Map<string, boolean>([["require", true]])];
  const createRequireShadowScopes = [new Set<string>()];
  const legacyPathScopes = [new Map<string, boolean>()];
  const literalTextScopes = [new Map<string, string[] | null>()];
  const staticExpressionScopes = [new Map<string, ts.Expression | null>()];
  const knownUndefinedScopes = [new Map<string, boolean>()];
  const legacyKnownObjectLiteralScopes = [new Map<string, boolean>()];
  const legacyObjectPropertyScopes = [new Map<string, LegacyPropertyValue>()];
  const wrapperFunctionScopes = [new Map<string, WrapperValue>()];
  const conditionalExecutionScopes = [false];
  function createBranchEffects() {
    return {
      fsIdentifierAssignments: new Map<string, BranchFsIdentifierAssignment>(),
      fsSafePropertyAssignments: new Map<string, BranchFsSafePropertyAssignment>(),
      identifierAssignments: new Map<string, BranchIdentifierAssignment>(),
      propertyAssignments: new Map<string, BranchPropertyAssignment>(),
      wrapperAssignments: new Map<string, BranchWrapperAssignment>(),
    };
  }
  type BranchEffects = ReturnType<typeof createBranchEffects>;
  const branchEffectScopes = new Array<BranchEffects | null>();
  const activeWrapperNodes = new Set<WrapperNode>();
  const intrinsicWrapperCalls = new WeakSet<ts.CallExpression>();
  const wrapperCallSites = new Array<ts.Expression>();
  const wrapperExecutionScopeIndexes = new Array<number>();
  let definitionScanDepth = 0;
  const lexicalScopeStacks: Array<[LexicalScope[], MapConstructor | SetConstructor]> = [
    [fsWriteAliasScopes, Map],
    [fsSafeStoreFactoryAliasScopes, Map],
    [fsSafeStoreScopes, Map],
    [fsSafeJsonStoreScopes, Map],
    [fsModuleBindingScopes, Map],
    [fsModulePropertyScopes, Map],
    [requireAliasScopes, Map],
    [createRequireShadowScopes, Set],
    [legacyPathScopes, Map],
    [literalTextScopes, Map],
    [staticExpressionScopes, Map],
    [knownUndefinedScopes, Map],
    [legacyKnownObjectLiteralScopes, Map],
    [legacyObjectPropertyScopes, Map],
    [wrapperFunctionScopes, Map],
  ];

  function withLexicalScope<Result>(isConditional: boolean, visitScope: () => Result) {
    for (const [scopes, Scope] of lexicalScopeStacks) {
      scopes.push(Scope === Map ? new Map<string, unknown>() : new Set<string>());
    }
    conditionalExecutionScopes.push(isConditional);
    try {
      return visitScope();
    } finally {
      conditionalExecutionScopes.pop();
      for (let index = lexicalScopeStacks.length - 1; index >= 0; index--) {
        lexicalScopeStacks[index]![0].pop();
      }
    }
  }

  function addViolation(node: ts.Node, kind: string) {
    const callSite = kind === "legacy store filesystem write" ? wrapperCallSites[0] : null;
    const reportedNode = callSite ?? node;
    const line = toLine(sourceFile, reportedNode);
    const key = `${line}:${kind}`;
    if (seenViolations.has(key)) {
      return;
    }
    seenViolations.add(key);
    violations.push({ kind, line });
  }

  function resolveRequireAlias(name: string) {
    return scopeForRead(requireAliasScopes, name)?.get(name) === true;
  }

  function isNodeRequireName(name: string) {
    return resolveRequireAlias(name);
  }

  function isCreateRequireShadowed(name: string) {
    return createRequireShadowScopes.some((scope) => scope.has(name));
  }

  function isCreateRequireExpression(expression: ts.Expression) {
    const call = unwrapExpression(expression);
    if (!ts.isCallExpression(call)) {
      return false;
    }
    const callee = unwrapExpression(call.expression);
    return (
      ts.isIdentifier(callee) &&
      createRequireBindings.has(callee.text) &&
      !isCreateRequireShadowed(callee.text)
    );
  }

  function isRequireAliasExpression(expression: ts.Expression) {
    const value = unwrapExpression(expression);
    return (
      isCreateRequireExpression(value) ||
      (ts.isIdentifier(value) && resolveRequireAlias(value.text))
    );
  }

  function resolveFsModuleBinding(name: string) {
    return scopeForRead(fsModuleBindingScopes, name)?.get(name) === true;
  }

  function resolveFsModuleProperty(pathParts: string[]) {
    const fullPath = pathParts.join(".");
    const prefixes = pathParts.map((_, index) => pathParts.slice(0, index + 1).join("."));
    for (let index = fsModulePropertyScopes.length - 1; index >= 0; index--) {
      const scope = fsModulePropertyScopes[index]!;
      if (scope.has(fullPath)) {
        return scope.get(fullPath) === true;
      }
      for (const prefix of prefixes) {
        if (scope.get(prefix) === false) {
          return false;
        }
      }
    }
    return false;
  }

  function resolveFsWriteAlias(name: string) {
    return scopeForRead(fsWriteAliasScopes, name)?.get(name) ?? null;
  }

  function resolveFsSafeStoreFactoryAlias(name: string) {
    return scopeForRead(fsSafeStoreFactoryAliasScopes, name)?.get(name) ?? null;
  }

  function resolveFsSafeStore(name: string) {
    const value = lookupFsSafeStore(name);
    return value === true;
  }

  function lookupFsSafeStore(name: string) {
    const scope = scopeForRead(fsSafeStoreScopes, name);
    return scope ? scope.get(name) === true : null;
  }

  function resolveFsSafeJsonStore(name: string) {
    const value = lookupFsSafeJsonStore(name);
    return value === true;
  }

  function lookupFsSafeJsonStore(name: string) {
    const scope = scopeForRead(fsSafeJsonStoreScopes, name);
    return scope ? scope.get(name) === true : null;
  }

  function lookupKnownLegacyObjectLiteral(name: string) {
    for (let index = legacyKnownObjectLiteralScopes.length - 1; index >= 0; index--) {
      const scope = legacyKnownObjectLiteralScopes[index]!;
      if (scope.has(name)) {
        return scope.get(name) === true;
      }
      if (legacyPathScopes[index]!.has(name)) {
        return false;
      }
    }
    return false;
  }

  function isKnownLegacyObjectLiteralExpression(expression: ts.Expression) {
    const unwrapped = unwrapExpression(expression);
    return (
      ts.isObjectLiteralExpression(unwrapped) ||
      (ts.isIdentifier(unwrapped) && lookupKnownLegacyObjectLiteral(unwrapped.text))
    );
  }

  function markKnownLegacyObjectLiteral(
    name: string,
    initializer: ts.Expression,
    targetScope: StringMap<boolean> = lastScope(legacyKnownObjectLiteralScopes),
  ) {
    targetScope.set(name, isKnownLegacyObjectLiteralExpression(initializer));
  }

  function objectPropertyKey(objectName: string, propertyName: string) {
    return `${objectName}.${propertyName}`;
  }

  function shadowObjectPropertyScopes<Value>(
    scopes: ScopeStack<Value>,
    objectName: string,
    value: Value,
    targetScope: StringMap<Value> = lastScope(scopes),
  ) {
    const prefix = `${objectName}.`;
    for (const scope of scopes) {
      for (const name of scope.keys()) {
        if (name.startsWith(prefix)) {
          targetScope.set(name, value);
        }
      }
    }
  }

  function visitObjectLiteralProperties(
    objectName: string,
    initializer: ts.Expression,
    onProperty: (name: string, value: ts.Expression) => void,
    onSpread: ((expression: ts.Expression) => void) | null = null,
  ) {
    const objectLiteral = unwrapExpression(initializer);
    if (!ts.isObjectLiteralExpression(objectLiteral)) {
      return;
    }
    for (const property of objectLiteral.properties) {
      if (ts.isSpreadAssignment(property)) {
        onSpread?.(unwrapExpression(property.expression));
        continue;
      }
      if (ts.isPropertyAssignment(property)) {
        const name = propertyNameText(property.name);
        if (name) {
          onProperty(`${objectName}.${name}`, property.initializer);
        }
      } else if (ts.isShorthandPropertyAssignment(property)) {
        onProperty(`${objectName}.${property.name.text}`, property.name);
      }
    }
  }

  function resolveLegacyPathIdentifier(name: string) {
    return scopeForRead(legacyPathScopes, name)?.get(name) === true;
  }

  function resolveLiteralTextIdentifier(name: string) {
    return scopeForRead(literalTextScopes, name)?.get(name) ?? [];
  }

  function resolveStaticExpression(name: string) {
    return scopeForRead(staticExpressionScopes, name)?.get(name) ?? null;
  }

  function resolveKnownUndefinedIdentifier(name: string) {
    return scopeForRead(knownUndefinedScopes, name)?.get(name) === true;
  }

  function requireAliasWriteTarget(name: string) {
    for (let index = requireAliasScopes.length - 1; index >= 0; index--) {
      const scope = requireAliasScopes[index]!;
      if (scope.has(name)) {
        return { index, scope };
      }
    }
    return { index: requireAliasScopes.length - 1, scope: lastScope(requireAliasScopes) };
  }

  function expressionLiteralCandidateTexts(node: ts.Expression) {
    const candidates = legacyCandidateTexts(sourceFile, node);
    const segmentOptions: string[][] = [];

    function combineSegmentOptions(left: string[], right: string[]) {
      const joined = left.flatMap((leftOption) =>
        right.map((rightOption) => `${leftOption}${rightOption}`),
      );
      return joined.length > 32 ? joined.slice(0, 32) : joined;
    }

    function expressionSegmentOptions(current: ts.Expression): string[] {
      const unwrapped = unwrapExpression(current);
      if (ts.isStringLiteralLike(unwrapped)) {
        return [unwrapped.text];
      }
      if (ts.isTemplateExpression(unwrapped)) {
        let joined = [unwrapped.head.text];
        for (const span of unwrapped.templateSpans) {
          joined = combineSegmentOptions(joined, expressionSegmentOptions(span.expression));
          joined = combineSegmentOptions(joined, [span.literal.text]);
        }
        return joined.length > 0 ? joined : ["*"];
      }
      if (
        ts.isBinaryExpression(unwrapped) &&
        unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        return combineSegmentOptions(
          expressionSegmentOptions(unwrapped.left),
          expressionSegmentOptions(unwrapped.right),
        );
      }
      if (ts.isIdentifier(unwrapped)) {
        const texts = resolveLiteralTextIdentifier(unwrapped.text);
        return texts.length > 0 ? texts : ["*"];
      }
      return ["*"];
    }

    function maybeAddCallLiteralCandidate(current: ts.Node) {
      if (!ts.isCallExpression(current) || current.arguments.length < 2) {
        return;
      }
      const argumentOptions = current.arguments.map((argument) =>
        expressionSegmentOptions(argument),
      );
      if (!argumentOptions.some((options) => options.some((option) => option !== "*"))) {
        return;
      }
      let joined = [""];
      for (const options of argumentOptions) {
        joined = joined.flatMap((prefix) =>
          options.map((option) => (prefix.length === 0 ? option : `${prefix}/${option}`)),
        );
        if (joined.length > 32) {
          joined = joined.slice(0, 32);
        }
      }
      candidates.push(...joined);
    }

    function visitCandidate(current: ts.Node) {
      maybeAddCallLiteralCandidate(current);
      if (ts.isStringLiteralLike(current)) {
        segmentOptions.push([current.text]);
        return;
      }
      if (ts.isIdentifier(current)) {
        const texts = resolveLiteralTextIdentifier(current.text);
        if (texts.length > 0) {
          segmentOptions.push(texts);
        }
      }
      ts.forEachChild(current, visitCandidate);
    }
    const expressionOptions = expressionSegmentOptions(node);
    if (expressionOptions.some((option) => option !== "*")) {
      candidates.push(...expressionOptions);
    }
    visitCandidate(node);
    if (segmentOptions.length > 1) {
      let joined = [""];
      for (const options of segmentOptions) {
        joined = joined.flatMap((prefix) =>
          options.map((option) => (prefix.length === 0 ? option : `${prefix}/${option}`)),
        );
        if (joined.length > 32) {
          joined = joined.slice(0, 32);
        }
      }
      candidates.push(...joined);
    }
    return candidates;
  }

  function expressionTextContainsLegacyStore(node: ts.Expression) {
    return expressionLiteralCandidateTexts(node).some((text) =>
      legacyStorePatterns.some((pattern) => pattern.test(text)),
    );
  }

  function literalTextsFromExpression(expression: ts.Expression) {
    const unwrapped = unwrapExpression(expression);
    if (ts.isStringLiteralLike(unwrapped)) {
      return [unwrapped.text];
    }
    if (ts.isIdentifier(unwrapped)) {
      return resolveLiteralTextIdentifier(unwrapped.text);
    }
    return [];
  }

  function arrayLiteralElementAt(expression: ts.Expression, index: number) {
    const unwrapped = unwrapExpression(expression);
    if (!ts.isArrayLiteralExpression(unwrapped)) {
      return null;
    }
    const element = unwrapped.elements[index];
    return element && !ts.isSpreadElement(element) ? element : null;
  }

  function legacyObjectPropertyRewriteValues(
    objectName: string,
    initializer: ts.Expression,
    existingScope: StringMap<LegacyPropertyValue>,
  ) {
    const values = new Map<string, LegacyPropertyValue>();
    markLegacyObjectProperties(objectName, initializer, values, null);
    if (isKnownLegacyObjectLiteralExpression(initializer)) {
      const descendantPrefix = `${objectName}.`;
      for (const key of existingScope.keys()) {
        if (key.startsWith(descendantPrefix) && !values.has(key)) {
          values.set(key, explicitUndefinedLegacyObjectPropertyValue);
        }
      }
    }
    return values;
  }

  function lookupLegacyObjectProperty(
    objectName: string,
    propertyName: string,
    maxScopeIndex = legacyObjectPropertyScopes.length - 1,
  ) {
    const result = lookupLegacyObjectPropertyEntry(objectName, propertyName, maxScopeIndex);
    if (result.found) {
      return result.value === true;
    }
    if (result.objectKnown) {
      return result.objectValue ? null : false;
    }
    return null;
  }

  function lookupLegacyObjectPropertyEntry(
    objectName: string,
    propertyName: string,
    maxScopeIndex = legacyObjectPropertyScopes.length - 1,
  ):
    | { found: true; value: LegacyPropertyValue; objectKnown?: never; objectValue?: never }
    | { found: false; objectKnown: boolean; objectValue: boolean; value?: never } {
    const key = objectPropertyKey(objectName, propertyName);
    for (
      let index = Math.min(maxScopeIndex, legacyObjectPropertyScopes.length - 1);
      index >= 0;
      index--
    ) {
      const propertyScope = legacyObjectPropertyScopes[index]!;
      if (propertyScope.has(key)) {
        return { found: true, value: propertyScope.get(key)! };
      }
      if (legacyPathScopes[index]!.has(objectName)) {
        return {
          found: false,
          objectKnown: true,
          objectValue: legacyPathScopes[index]!.get(objectName) === true,
        };
      }
    }
    return { found: false, objectKnown: false, objectValue: false };
  }

  function legacyObjectPropertyValueFromExpression(expression: ts.Expression) {
    return isKnownUndefinedExpression(expression)
      ? explicitUndefinedLegacyObjectPropertyValue
      : expressionContainsLegacyStore(expression);
  }

  function elementAccessNames(expression: ts.Expression) {
    const argument = unwrapExpression(expression);
    if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) {
      return [argument.text];
    }
    return ts.isIdentifier(argument) ? resolveLiteralTextIdentifier(argument.text) : [];
  }

  function elementAccessName(expression: ts.Expression | undefined) {
    if (!expression) {
      return null;
    }
    const names = elementAccessNames(expression);
    return names.length === 1 ? (names[0] ?? null) : null;
  }

  function propertyAccessPath(expression: ts.Expression): string[] | null {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      return [unwrapped.text];
    }
    if (ts.isPropertyAccessExpression(unwrapped)) {
      const parentPath = propertyAccessPath(unwrapped.expression);
      return parentPath ? [...parentPath, unwrapped.name.text] : null;
    }
    if (ts.isElementAccessExpression(unwrapped)) {
      const propertyName = elementAccessName(unwrapped.argumentExpression);
      if (!propertyName) {
        return null;
      }
      const parentPath = propertyAccessPath(unwrapped.expression);
      return parentPath ? [...parentPath, propertyName] : null;
    }
    return null;
  }

  function legacyObjectPropertyWriteTarget(objectName: string, propertyName: string) {
    const key = objectPropertyKey(objectName, propertyName);
    for (let index = legacyObjectPropertyScopes.length - 1; index >= 0; index--) {
      const propertyScope = legacyObjectPropertyScopes[index]!;
      if (propertyScope.has(key) || legacyPathScopes[index]!.has(objectName)) {
        return { index, scope: propertyScope };
      }
    }
    return {
      index: legacyObjectPropertyScopes.length - 1,
      scope: lastScope(legacyObjectPropertyScopes),
    };
  }

  function legacyIdentifierWriteScopes(name: string) {
    for (let index = legacyPathScopes.length - 1; index >= 0; index--) {
      if (legacyPathScopes[index]!.has(name)) {
        return {
          index,
          pathScope: legacyPathScopes[index]!,
          propertyScope: legacyObjectPropertyScopes[index]!,
          wrapperScope: wrapperFunctionScopes[index]!,
        };
      }
    }
    return {
      index: legacyPathScopes.length - 1,
      pathScope: lastScope(legacyPathScopes),
      propertyScope: lastScope(legacyObjectPropertyScopes),
      wrapperScope: lastScope(wrapperFunctionScopes),
    };
  }

  function isConditionallyExecutedScope(node: ts.Node) {
    const parent = node.parent;
    return (
      (ts.isBlock(node) &&
        parent &&
        ((ts.isIfStatement(parent) &&
          (parent.thenStatement === node || parent.elseStatement === node)) ||
          (ts.isIterationStatement(parent, false) && parent.statement === node) ||
          (ts.isTryStatement(parent) && parent.tryBlock === node))) ||
      ts.isCaseBlock(node) ||
      ts.isCatchClause(node)
    );
  }

  function expressionContainsLegacyStore(node: ts.Expression) {
    if (expressionTextContainsLegacyStore(node)) {
      return true;
    }
    let found = false;
    function visitExpression(current: ts.Node) {
      if (found) {
        return;
      }
      if (
        ts.isIdentifier(current) &&
        !(ts.isPropertyAccessExpression(current.parent) && current.parent.name === current) &&
        resolveLegacyPathIdentifier(current.text)
      ) {
        found = true;
        return;
      }
      const propertyAccess = rootedPropertyAccessCandidates(current);
      if (propertyAccess?.propertyPaths.some((propertyPath) => propertyPath.length > 0)) {
        const propertyValue = lookupLegacyObjectPropertyCandidates(propertyAccess);
        if (propertyValue !== null) {
          found = propertyValue;
          return;
        }
      }
      ts.forEachChild(current, visitExpression);
    }
    visitExpression(node);
    return found;
  }

  function visitWithChildScope(node: ts.Node & { statements?: ts.NodeArray<ts.Statement> }) {
    withLexicalScope(
      lastScope(conditionalExecutionScopes) || isConditionallyExecutedScope(node),
      () => {
        if (node.statements) {
          registerHoistedWrapperFunctions(node.statements);
        }
        ts.forEachChild(node, visit);
      },
    );
  }

  function registerFsBindingParameter(name: ts.BindingName) {
    if (ts.isIdentifier(name)) {
      lastScope(fsModuleBindingScopes).set(name.text, true);
      return;
    }
    if (!ts.isObjectBindingPattern(name)) {
      return;
    }
    for (const element of name.elements) {
      const importedName = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (importedName === "promises") {
        if (ts.isIdentifier(element.name)) {
          lastScope(fsModuleBindingScopes).set(element.name.text, true);
        } else if (ts.isObjectBindingPattern(element.name)) {
          registerFsPromisesBindingParameter(element.name);
        }
      }
      if (importedName && legacyWriteCallees.has(importedName) && ts.isIdentifier(element.name)) {
        lastScope(fsWriteAliasScopes).set(element.name.text, importedName);
      }
    }
  }

  function registerFsPromisesBindingParameter(name: ts.BindingName) {
    if (!ts.isObjectBindingPattern(name)) {
      return;
    }
    for (const element of name.elements) {
      const importedName = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (importedName && legacyWriteCallees.has(importedName) && ts.isIdentifier(element.name)) {
        lastScope(fsWriteAliasScopes).set(element.name.text, importedName);
      }
      if (ts.isObjectBindingPattern(element.name)) {
        registerFsPromisesBindingParameter(element.name);
      }
    }
  }

  function visitFunctionLike(node: WrapperNode, fsBindingIndexes: Set<number> = new Set()) {
    withLexicalScope(false, () => {
      if (node.name && ts.isIdentifier(node.name)) {
        markFsWriteAliasShadows(node.name);
        markFsSafeStoreShadows(node.name);
        markFsModuleBindingShadows(node.name);
        markFsModulePropertyShadows(node.name);
        markCreateRequireShadows(node.name);
        lastScope(wrapperFunctionScopes).set(node.name.text, wrapperRecordForNode(node));
      }
      node.parameters.forEach((parameter, index) => {
        for (const name of bindingPatternNames(parameter.name)) {
          lastScope(legacyPathScopes).set(name, false);
          lastScope(legacyKnownObjectLiteralScopes).set(name, false);
          lastScope(knownUndefinedScopes).set(name, false);
          lastScope(literalTextScopes).set(name, null);
          lastScope(wrapperFunctionScopes).set(name, null);
          lastScope(requireAliasScopes).set(name, false);
        }
        markFsWriteAliasShadows(parameter.name);
        markFsSafeStoreShadows(parameter.name);
        markFsModuleBindingShadows(parameter.name);
        markFsModulePropertyShadows(parameter.name);
        markCreateRequireShadows(parameter.name);
        registerFsModuleTypeProperties(parameter.name, parameter.type);
        if (fsBindingIndexes.has(index)) {
          registerFsBindingParameter(parameter.name);
        }
      });
      definitionScanDepth += 1;
      try {
        ts.forEachChild(node, visit);
      } finally {
        definitionScanDepth -= 1;
      }
    });
  }

  function dynamicFsImportThenCallback(node: ts.CallExpression) {
    const callee = unwrapExpression(node.expression);
    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.name.text !== "then" ||
      !isFsDynamicImportExpression(callee.expression)
    ) {
      return null;
    }
    const [callback] = node.arguments;
    return callback && ts.isFunctionLike(callback) ? callback : null;
  }

  function isFsModuleExpression(expression: ts.Expression) {
    const receiver = unwrapExpression(expression);
    if (
      isFsRequireExpression(receiver, isNodeRequireName) ||
      isFsDynamicImportExpression(receiver)
    ) {
      return true;
    }
    if (ts.isIdentifier(receiver)) {
      return resolveFsModuleBinding(receiver.text);
    }
    const receiverPath = propertyAccessPath(receiver);
    if (receiverPath && resolveFsModuleProperty(receiverPath)) {
      return true;
    }
    if (!ts.isPropertyAccessExpression(receiver) || receiver.name.text !== "promises") {
      return false;
    }
    const propertyPath = propertyAccessPath(receiver.expression);
    return Boolean(
      isFsRequireExpression(receiver.expression, isNodeRequireName) ||
      isFsDynamicImportExpression(receiver.expression) ||
      (ts.isIdentifier(receiver.expression) && resolveFsModuleBinding(receiver.expression.text)) ||
      (propertyPath && resolveFsModuleProperty(propertyPath)),
    );
  }

  function legacyFsWriteName(
    expression: ts.Expression,
    aliases: StringMap<string | null> | null = null,
  ) {
    const callee = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const aliasedName = callExpressionName(callee);
      const writeAlias = aliasedName ? resolveFsWriteAlias(aliasedName) : null;
      if (writeAlias) {
        return writeAlias;
      }
      return legacyWriteCallees.has(callee.name.text) && isFsModuleExpression(callee.expression)
        ? callee.name.text
        : null;
    }
    if (ts.isElementAccessExpression(callee)) {
      const aliasedName = callExpressionName(callee);
      const writeAlias = aliasedName ? resolveFsWriteAlias(aliasedName) : null;
      if (writeAlias) {
        return writeAlias;
      }
      const writeName = elementAccessName(callee.argumentExpression);
      return writeName &&
        legacyWriteCallees.has(writeName) &&
        isFsModuleExpression(callee.expression)
        ? writeName
        : null;
    }
    if (!ts.isIdentifier(callee)) {
      return null;
    }
    return aliases && aliases.has(callee.text)
      ? (aliases.get(callee.text) ?? null)
      : resolveFsWriteAlias(callee.text);
  }

  function fsSafeStoreFactoryAliasName(expression: ts.Expression) {
    const callee = unwrapExpression(expression);
    if (ts.isIdentifier(callee)) {
      return resolveFsSafeStoreFactoryAlias(callee.text);
    }
    const name = callExpressionName(callee);
    return name ? resolveFsSafeStoreFactoryAlias(name) : null;
  }

  function isFsSafeStoreFactoryCall(expression: ts.Expression) {
    const unwrapped = unwrapExpression(expression);
    const call = ts.isAwaitExpression(unwrapped)
      ? unwrapExpression(unwrapped.expression)
      : unwrapped;
    if (!ts.isCallExpression(call)) {
      return false;
    }
    const callee = unwrapExpression(call.expression);
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const methodName = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : elementAccessName(callee.argumentExpression);
      if (methodName === "root" && isFsSafeStoreExpression(callee.expression)) {
        return true;
      }
    }
    const name = callExpressionName(call.expression);
    const factoryName = name ? resolveFsSafeStoreFactoryAlias(name) : null;
    return Boolean(factoryName && fsSafeStoreFactoryCallees.has(factoryName));
  }

  function isFsSafeStoreExpression(expression: ts.Expression) {
    const unwrapped = unwrapExpression(expression);
    if (isFsSafeStoreFactoryCall(unwrapped)) {
      return true;
    }
    if (ts.isIdentifier(unwrapped)) {
      return resolveFsSafeStore(unwrapped.text);
    }
    const receiverPath = propertyAccessPath(unwrapped);
    if (receiverPath) {
      return resolveFsSafeStore(receiverPath.join("."));
    }
    return false;
  }

  function objectFilePathContainsLegacyStore(expression: ts.Expression) {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      return lookupLegacyObjectProperty(unwrapped.text, "filePath") === true;
    }
    if (!ts.isObjectLiteralExpression(unwrapped)) {
      return expressionContainsLegacyStore(unwrapped);
    }
    return objectLiteralPropertyContainsLegacyStore(unwrapped, "filePath");
  }

  function expressionContainsFsSafeJsonStoreLegacyPath(expression: ts.Expression) {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      return resolveFsSafeJsonStore(unwrapped.text);
    }
    const receiverPath = propertyAccessPath(unwrapped);
    if (receiverPath && resolveFsSafeJsonStore(receiverPath.join("."))) {
      return true;
    }
    if (!ts.isCallExpression(unwrapped)) {
      return false;
    }
    const callName = callExpressionName(unwrapped.expression);
    const factoryName = callName ? resolveFsSafeStoreFactoryAlias(callName) : null;
    if (factoryName && fsSafeJsonStoreFactoryCallees.has(factoryName)) {
      const options = unwrapped.arguments[0];
      return options ? objectFilePathContainsLegacyStore(options) : false;
    }
    const callee = unwrapExpression(unwrapped.expression);
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
      return false;
    }
    const methodName = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : elementAccessName(callee.argumentExpression);
    if (methodName !== "json" || !isFsSafeStoreExpression(callee.expression)) {
      return false;
    }
    const pathArgument = unwrapped.arguments[0];
    return pathArgument ? pathArgumentContainsLegacyStore(pathArgument) : false;
  }

  function fsSafeJsonStoreWriteContainsLegacyStore(call: ts.CallExpression) {
    const callee = unwrapExpression(call.expression);
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
      return false;
    }
    const methodName = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : elementAccessName(callee.argumentExpression);
    if (!methodName || !fsSafeJsonStoreWriteMethods.has(methodName)) {
      return false;
    }
    return expressionContainsFsSafeJsonStoreLegacyPath(callee.expression);
  }

  function fsSafeStoreWritePathArguments(call: ts.CallExpression) {
    const callee = unwrapExpression(call.expression);
    if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) {
      return [];
    }
    const methodName = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : elementAccessName(callee.argumentExpression);
    if (!methodName || !fsSafeStoreWriteMethods.has(methodName)) {
      return [];
    }
    if (!isFsSafeStoreExpression(callee.expression)) {
      return [];
    }
    if (methodName === "move") {
      return [...call.arguments].slice(0, 2);
    }
    return call.arguments[0] ? [call.arguments[0]] : [];
  }

  function markFsWriteAliasShadows(name: ts.BindingName) {
    for (const bindingName of bindingPatternNames(name)) {
      if (resolveFsWriteAlias(bindingName)) {
        lastScope(fsWriteAliasScopes).set(bindingName, null);
      }
      shadowVisibleFsWriteObjectAliases(bindingName);
    }
  }

  function markFsSafeStoreShadows(name: ts.BindingName) {
    for (const bindingName of bindingPatternNames(name)) {
      if (resolveFsSafeStoreFactoryAlias(bindingName)) {
        lastScope(fsSafeStoreFactoryAliasScopes).set(bindingName, null);
      }
      shadowObjectPropertyScopes(fsSafeStoreFactoryAliasScopes, bindingName, null);
      if (resolveFsSafeStore(bindingName)) {
        lastScope(fsSafeStoreScopes).set(bindingName, false);
      }
      if (resolveFsSafeJsonStore(bindingName)) {
        lastScope(fsSafeJsonStoreScopes).set(bindingName, false);
      }
      shadowObjectPropertyScopes(fsSafeStoreScopes, bindingName, false);
      shadowObjectPropertyScopes(fsSafeJsonStoreScopes, bindingName, false);
    }
  }

  function markFsModuleBindingShadows(name: ts.BindingName) {
    for (const bindingName of bindingPatternNames(name)) {
      if (resolveFsModuleBinding(bindingName)) {
        lastScope(fsModuleBindingScopes).set(bindingName, false);
      }
    }
  }

  function markFsModulePropertyShadows(name: ts.BindingName) {
    for (const bindingName of bindingPatternNames(name)) {
      clearFsModuleObjectProperties(lastScope(fsModulePropertyScopes), bindingName);
    }
  }

  function markCreateRequireShadows(name: ts.BindingName) {
    for (const bindingName of bindingPatternNames(name)) {
      if (createRequireBindings.has(bindingName)) {
        lastScope(createRequireShadowScopes).add(bindingName);
      }
    }
  }

  function isFsModuleTypeNode(type: ts.TypeNode | undefined) {
    return Boolean(
      type &&
      /\btypeof\s+import\s*\(\s*["'](?:node:fs|node:fs\/promises|fs|fs\/promises)["']\s*\)/u.test(
        type.getText(sourceFile),
      ),
    );
  }

  function fsModulePropertyPathsFromType(type: ts.TypeNode | undefined): string[][] {
    const paths: string[][] = [];
    if (!type || !ts.isTypeLiteralNode(type)) {
      return paths;
    }
    for (const member of type.members) {
      if (!ts.isPropertySignature(member) || !member.type) {
        continue;
      }
      const propertyName = propertyNameText(member.name);
      if (!propertyName) {
        continue;
      }
      if (isFsModuleTypeNode(member.type)) {
        paths.push([propertyName]);
      }
      for (const nestedPath of fsModulePropertyPathsFromType(member.type)) {
        paths.push([propertyName, ...nestedPath]);
      }
    }
    return paths;
  }

  function registerFsModuleTypeProperties(name: ts.BindingName, type: ts.TypeNode | undefined) {
    if (!ts.isIdentifier(name) || !type) {
      return;
    }
    if (isFsModuleTypeNode(type)) {
      lastScope(fsModuleBindingScopes).set(name.text, true);
    }
    for (const pathParts of fsModulePropertyPathsFromType(type)) {
      lastScope(fsModulePropertyScopes).set([name.text, ...pathParts].join("."), true);
    }
  }

  function collectFsWriteAliasesFromBinding(node: ts.Node) {
    collectFsWriteAliasesFromBindingInto(node, lastScope(fsWriteAliasScopes));
  }

  function clearFsWriteObjectAliases(scope: StringMap<string | null>, objectName: string) {
    shadowObjectPropertyScopes([scope], objectName, null, scope);
  }

  function shadowVisibleFsWriteObjectAliases(objectName: string) {
    shadowObjectPropertyScopes(fsWriteAliasScopes, objectName, null);
  }

  function setFsWriteObjectAlias(
    scope: StringMap<string | null>,
    name: string,
    writeName: string | null,
    conditionalWrite: boolean,
  ) {
    if (writeName) {
      scope.set(name, writeName);
    } else if (!conditionalWrite) {
      scope.set(name, null);
    }
  }

  function registerFsWriteObjectAliases(
    objectName: string,
    initializer: ts.Expression,
    scope: StringMap<string | null> = lastScope(fsWriteAliasScopes),
    conditionalWrite = false,
  ) {
    visitObjectLiteralProperties(objectName, initializer, (name, value) => {
      setFsWriteObjectAlias(scope, name, legacyFsWriteName(value), conditionalWrite);
    });
  }

  function clearFsSafeStoreObjectAliases(
    storeScope: StringMap<boolean>,
    jsonStoreScope: StringMap<boolean>,
    objectName: string,
  ) {
    shadowObjectPropertyScopes([storeScope], objectName, false, storeScope);
    shadowObjectPropertyScopes([jsonStoreScope], objectName, false, jsonStoreScope);
  }

  function shadowVisibleFsSafeStoreObjectAliases(objectName: string) {
    shadowObjectPropertyScopes(fsSafeStoreScopes, objectName, false);
    shadowObjectPropertyScopes(fsSafeJsonStoreScopes, objectName, false);
  }

  function setFsSafeStoreObjectAlias(
    storeScope: StringMap<boolean>,
    jsonStoreScope: StringMap<boolean>,
    name: string,
    isStore: boolean,
    isJsonStore: boolean,
    conditionalWrite: boolean,
  ) {
    if (isStore) {
      storeScope.set(name, true);
    } else if (!conditionalWrite) {
      storeScope.set(name, false);
    }
    if (isJsonStore) {
      jsonStoreScope.set(name, true);
    } else if (!conditionalWrite) {
      jsonStoreScope.set(name, false);
    }
  }

  function copyFsSafeStoreObjectAliases(
    targetName: string,
    sourceName: string,
    storeScope: StringMap<boolean> = lastScope(fsSafeStoreScopes),
    jsonStoreScope: StringMap<boolean> = lastScope(fsSafeJsonStoreScopes),
  ) {
    const sourcePrefix = `${sourceName}.`;
    for (let index = fsSafeStoreScopes.length - 1; index >= 0; index--) {
      const sourceStoreScope = fsSafeStoreScopes[index]!;
      const sourceJsonStoreScope = fsSafeJsonStoreScopes[index]!;
      let copied = false;
      for (const [key, value] of sourceStoreScope) {
        if (key.startsWith(sourcePrefix)) {
          storeScope.set(`${targetName}.${key.slice(sourcePrefix.length)}`, value);
          copied = true;
        }
      }
      for (const [key, value] of sourceJsonStoreScope) {
        if (key.startsWith(sourcePrefix)) {
          jsonStoreScope.set(`${targetName}.${key.slice(sourcePrefix.length)}`, value);
          copied = true;
        }
      }
      if (copied || sourceStoreScope.has(sourceName) || sourceJsonStoreScope.has(sourceName)) {
        return;
      }
    }
  }

  function registerFsSafeStoreObjectAliases(
    objectName: string,
    initializer: ts.Expression,
    storeScope: StringMap<boolean> = lastScope(fsSafeStoreScopes),
    jsonStoreScope: StringMap<boolean> = lastScope(fsSafeJsonStoreScopes),
    conditionalWrite = false,
  ) {
    visitObjectLiteralProperties(
      objectName,
      initializer,
      (name, value) => {
        setFsSafeStoreObjectAlias(
          storeScope,
          jsonStoreScope,
          name,
          isFsSafeStoreExpression(value),
          expressionContainsFsSafeJsonStoreLegacyPath(value),
          conditionalWrite,
        );
        if (ts.isObjectLiteralExpression(unwrapExpression(value))) {
          registerFsSafeStoreObjectAliases(
            name,
            value,
            storeScope,
            jsonStoreScope,
            conditionalWrite,
          );
        }
      },
      (spreadExpression) => {
        if (ts.isIdentifier(spreadExpression)) {
          copyFsSafeStoreObjectAliases(
            objectName,
            spreadExpression.text,
            storeScope,
            jsonStoreScope,
          );
        } else if (ts.isObjectLiteralExpression(spreadExpression)) {
          registerFsSafeStoreObjectAliases(
            objectName,
            spreadExpression,
            storeScope,
            jsonStoreScope,
            conditionalWrite,
          );
        }
      },
    );
  }

  function setFsModuleObjectProperty(
    scope: StringMap<boolean>,
    name: string,
    isFsModule: boolean,
    conditionalWrite: boolean,
  ) {
    if (isFsModule) {
      scope.set(name, true);
    } else if (!conditionalWrite) {
      scope.set(name, false);
    }
  }

  function clearFsModuleObjectProperties(scope: StringMap<boolean>, objectName: string) {
    scope.set(objectName, false);
    shadowObjectPropertyScopes([scope], objectName, false, scope);
  }

  function registerFsModuleObjectProperties(
    objectName: string,
    initializer: ts.Expression,
    scope: StringMap<boolean> = lastScope(fsModulePropertyScopes),
    conditionalWrite = false,
  ) {
    visitObjectLiteralProperties(objectName, initializer, (name, value) => {
      setFsModuleObjectProperty(scope, name, isFsModuleExpression(value), conditionalWrite);
    });
  }

  function collectFsModuleBindingsFromBinding(node: ts.Node) {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isObjectBindingPattern(node.name) ||
      !node.initializer ||
      !isFsBindingExpression(node.initializer)
    ) {
      return;
    }
    for (const element of node.name.elements) {
      const propertyName = element.propertyName;
      const bindingName = element.name;
      const importedName = propertyName
        ? propertyNameText(propertyName)
        : ts.isIdentifier(bindingName)
          ? bindingName.text
          : null;
      if (importedName === "promises" && ts.isIdentifier(bindingName)) {
        lastScope(fsModuleBindingScopes).set(bindingName.text, true);
      }
    }
  }

  function isFsBindingExpression(expression: ts.Expression) {
    const initializer = unwrapExpression(expression);
    if (
      isFsRequireExpression(initializer, isNodeRequireName) ||
      isFsDynamicImportExpression(initializer)
    ) {
      return true;
    }
    if (ts.isIdentifier(initializer)) {
      return resolveFsModuleBinding(initializer.text);
    }
    return (
      ts.isPropertyAccessExpression(initializer) &&
      initializer.name.text === "promises" &&
      (isFsRequireExpression(initializer.expression, isNodeRequireName) ||
        isFsDynamicImportExpression(initializer.expression) ||
        (ts.isIdentifier(initializer.expression) &&
          resolveFsModuleBinding(initializer.expression.text)))
    );
  }

  function collectFsWriteAliasesFromBindingInto(
    node: ts.Node,
    aliases: StringMap<string | null>,
    isFsBinding: (expression: ts.Expression) => boolean = isFsBindingExpression,
  ) {
    if (
      !ts.isVariableDeclaration(node) ||
      !ts.isObjectBindingPattern(node.name) ||
      !node.initializer
    ) {
      return;
    }
    if (!isFsBinding(node.initializer)) {
      return;
    }
    collectFsWriteAliasesFromPattern(node.name, aliases);
  }

  function collectFsWriteAliasesFromPattern(
    pattern: ts.ObjectBindingPattern,
    aliases: StringMap<string | null>,
  ) {
    for (const element of pattern.elements) {
      const propertyName = element.propertyName;
      const bindingName = element.name;
      const importedName = propertyName
        ? propertyNameText(propertyName)
        : ts.isIdentifier(bindingName)
          ? bindingName.text
          : null;
      if (!importedName) {
        continue;
      }
      if (legacyWriteCallees.has(importedName) && ts.isIdentifier(bindingName)) {
        aliases.set(bindingName.text, importedName);
      }
      if (importedName === "promises" && ts.isObjectBindingPattern(bindingName)) {
        collectFsWriteAliasesFromPattern(bindingName, aliases);
      }
    }
  }

  function markArrayBindingPatternFromForOf(
    initializer: ts.ForInitializer,
    expression: ts.Expression,
  ) {
    if (!ts.isVariableDeclarationList(initializer)) {
      return;
    }
    const declaration = initializer.declarations[0];
    if (!declaration || !ts.isArrayBindingPattern(declaration.name)) {
      return;
    }
    const iterable = unwrapExpression(expression);
    if (!ts.isArrayLiteralExpression(iterable)) {
      return;
    }

    declaration.name.elements.forEach((bindingElement, index) => {
      if (ts.isOmittedExpression(bindingElement) || !ts.isIdentifier(bindingElement.name)) {
        return;
      }

      const elementsAtIndex = iterable.elements
        .map((element) => arrayLiteralElementAt(element, index))
        .filter((element): element is ts.Expression => element !== null);
      if (elementsAtIndex.length === 0) {
        return;
      }

      lastScope(legacyPathScopes).set(
        bindingElement.name.text,
        elementsAtIndex.some((element) => expressionContainsLegacyStore(element)),
      );
      lastScope(literalTextScopes).set(
        bindingElement.name.text,
        mergeExhaustiveLiteralTexts(
          [],
          elementsAtIndex.flatMap((element) => literalTextsFromExpression(element)),
        ),
      );
    });
  }

  function pathArgumentsForFsWrite(name: string, args: ts.Expression[]) {
    if (
      name === "appendRegularFile" ||
      name === "appendRegularFileSync" ||
      name === "replaceFileAtomic" ||
      name === "replaceFileAtomicSync"
    ) {
      const first = args[0];
      if (!first) {
        return [];
      }
      const objectArg = unwrapExpression(first);
      if (!ts.isObjectLiteralExpression(objectArg)) {
        return first ? [first] : [];
      }
      return objectArg.properties.flatMap((property) => {
        if (ts.isPropertyAssignment(property)) {
          const key = property.name;
          const propertyName =
            ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key)
              ? key.text
              : null;
          return propertyName === "filePath" ? [property.initializer] : [];
        }
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === "filePath") {
          return [property.name];
        }
        return [];
      });
    }
    if (
      name === "saveJsonFile" ||
      name === "writeJson" ||
      name === "writeJsonAtomic" ||
      name === "writeJsonFileAtomically" ||
      name === "writeJsonSync" ||
      name === "writeTextAtomic"
    ) {
      return args.slice(0, 1);
    }
    if (name === "copyFile" || name === "copyFileSync" || name === "cp" || name === "cpSync") {
      return args.slice(1, 2);
    }
    if (name === "rename" || name === "renameSync") {
      return args.slice(0, 2);
    }
    return args.slice(0, 1);
  }

  function openFlagsMayWrite(flags: ts.Expression | undefined) {
    if (!flags) {
      return false;
    }
    const unwrapped = unwrapExpression(flags);
    if (ts.isStringLiteralLike(unwrapped)) {
      return /[wa+]/u.test(unwrapped.text);
    }
    return true;
  }

  function fsWriteCallMayWrite(name: string, args: ts.Expression[]) {
    if (name === "open" || name === "openSync") {
      return openFlagsMayWrite(args[1]);
    }
    return true;
  }

  function propertyNameText(name: ts.PropertyName) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    if (ts.isComputedPropertyName(name)) {
      return elementAccessName(name.expression);
    }
    return null;
  }

  function isVarVariableDeclaration(node: ts.VariableDeclaration) {
    return (
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.BlockScoped) === 0
    );
  }

  function isAmbientVariableDeclaration(node: ts.VariableDeclaration) {
    let current: ts.Node | undefined = node.parent;
    while (current && !ts.isSourceFile(current)) {
      const modifiers = ts.canHaveModifiers(current) ? (ts.getModifiers(current) ?? []) : [];
      if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  function isTypeSyntaxNode(node: ts.Node) {
    return node.kind >= ts.SyntaxKind.FirstTypeNode && node.kind <= ts.SyntaxKind.LastTypeNode;
  }

  function objectLiteralPropertyLegacyValue(
    objectLiteral: ts.ObjectLiteralExpression,
    propertyName: string,
  ): boolean | null {
    let result: boolean | null = null;
    for (const property of objectLiteral.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spreadExpression = unwrapExpression(property.expression);
        if (ts.isIdentifier(spreadExpression)) {
          const propertyValue = lookupLegacyObjectProperty(spreadExpression.text, propertyName);
          if (propertyValue !== null) {
            result = propertyValue;
          }
          continue;
        }
        if (ts.isObjectLiteralExpression(spreadExpression)) {
          const propertyValue = objectLiteralPropertyLegacyValue(spreadExpression, propertyName);
          if (propertyValue !== null) {
            result = propertyValue;
          }
        }
        continue;
      }
      if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === propertyName) {
        result = expressionContainsLegacyStore(property.initializer);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
        result = expressionContainsLegacyStore(property.name);
      }
    }
    return result;
  }

  function objectLiteralPropertyContainsLegacyStore(
    objectLiteral: ts.ObjectLiteralExpression,
    propertyName: string,
  ) {
    return objectLiteralPropertyLegacyValue(objectLiteral, propertyName) === true;
  }

  function clearLegacyObjectProperties(scope: StringMap<LegacyPropertyValue>, objectName: string) {
    const prefix = `${objectName}.`;
    for (const key of scope.keys()) {
      if (key.startsWith(prefix)) {
        scope.delete(key);
      }
    }
  }

  function clearKnownLegacyObjectLiterals(scope: StringMap<boolean>, objectName: string) {
    const prefix = `${objectName}.`;
    for (const key of scope.keys()) {
      if (key.startsWith(prefix)) {
        scope.delete(key);
      }
    }
  }

  function legacyObjectPropertiesFromAssignment(
    objectName: string,
    initializer: ts.Expression,
    existingScope: StringMap<LegacyPropertyValue> = new Map(),
  ) {
    return legacyObjectPropertyRewriteValues(objectName, initializer, existingScope);
  }

  function legacyKnownObjectLiteralsFromAssignment(objectName: string, initializer: ts.Expression) {
    const knownObjectLiterals = new Map<string, boolean>();
    markLegacyObjectProperties(objectName, initializer, new Map(), knownObjectLiterals);
    return knownObjectLiterals;
  }

  function branchIdentifierAssignmentKey(index: number, name: string) {
    return `${index}:${name}`;
  }

  function branchPropertyAssignmentKey(index: number, objectName: string, propertyName: string) {
    return `${index}:${objectPropertyKey(objectName, propertyName)}`;
  }

  function branchWrapperAssignmentKey(index: number, name: string) {
    return `${index}:${name}`;
  }

  function recordBranchIdentifierAssignment(
    index: number,
    name: string,
    value: boolean,
    initializer: ts.Expression,
    literalTexts: string[],
    objectProperties: StringMap<LegacyPropertyValue> | null = null,
    knownUndefined = isKnownUndefinedExpression(initializer),
  ) {
    const effects = lastScope(branchEffectScopes);
    if (!effects) {
      return;
    }
    effects.identifierAssignments.set(branchIdentifierAssignmentKey(index, name), {
      index,
      knownUndefined,
      knownObjectLiteral: isKnownLegacyObjectLiteralExpression(initializer),
      knownObjectLiterals: legacyKnownObjectLiteralsFromAssignment(name, initializer),
      literalTexts,
      name,
      value,
      objectProperties: objectProperties ?? legacyObjectPropertiesFromAssignment(name, initializer),
    });
    const prefix = `${index}:${name}.`;
    for (const key of effects.propertyAssignments.keys()) {
      if (key.startsWith(prefix)) {
        effects.propertyAssignments.delete(key);
      }
    }
  }

  function recordBranchPropertyAssignment(
    index: number,
    objectName: string,
    propertyName: string,
    value: LegacyPropertyValue,
    knownObjectLiteral = false,
  ) {
    const effects = lastScope(branchEffectScopes);
    if (!effects) {
      return;
    }
    const identifierAssignment = effects.identifierAssignments.get(
      branchIdentifierAssignmentKey(index, objectName),
    );
    const propertyKey = objectPropertyKey(objectName, propertyName);
    if (identifierAssignment) {
      identifierAssignment.objectProperties.set(propertyKey, value);
      identifierAssignment.knownObjectLiterals.set(propertyKey, knownObjectLiteral);
      return;
    }
    effects.propertyAssignments.set(branchPropertyAssignmentKey(index, objectName, propertyName), {
      index,
      objectName,
      propertyName,
      value,
      knownObjectLiteral,
    });
  }

  function recordBranchWrapperAssignment(index: number, name: string, value: WrapperValue) {
    const effects = lastScope(branchEffectScopes);
    if (!effects) {
      return;
    }
    effects.wrapperAssignments.set(branchWrapperAssignmentKey(index, name), {
      index,
      name,
      value: cloneWrapperFunctionValue(value),
    });
  }

  function recordBranchWrapperObjectRewrite(
    index: number,
    objectName: string,
    initializer: ts.Expression,
  ) {
    const fact = factFromExpression(initializer);
    if (!fact.knownObject) {
      return;
    }
    const retained = new Set(
      [...fact.wrappers.keys()].map((key) => `${objectName}${key.slice(fact.root.length)}`),
    );
    const prefix = `${objectName}.`;
    for (const scope of wrapperFunctionScopes) {
      for (const name of scope.keys()) {
        if (name.startsWith(prefix) && !retained.has(name)) {
          recordBranchWrapperAssignment(index, name, null);
        }
      }
    }
  }

  function recordBranchFsIdentifierAssignment(
    index: number,
    name: string,
    moduleValue: boolean,
    writeAlias: string | null,
    fsSafeFactoryAlias: string | null,
    fsSafeStoreValue: boolean,
    fsSafeJsonStoreValue: boolean,
    requireAlias: boolean,
  ) {
    const effects = lastScope(branchEffectScopes);
    if (!effects) {
      return;
    }
    effects.fsIdentifierAssignments.set(branchIdentifierAssignmentKey(index, name), {
      fsSafeFactoryAlias,
      fsSafeJsonStoreValue,
      fsSafeStoreValue,
      index,
      moduleValue,
      name,
      requireAlias,
      writeAlias,
    });
  }

  function recordBranchFsSafePropertyAssignment(
    index: number,
    objectName: string,
    propertyName: string,
    storeValue: boolean,
    jsonStoreValue: boolean,
  ) {
    const effects = lastScope(branchEffectScopes);
    if (!effects) {
      return;
    }
    effects.fsSafePropertyAssignments.set(
      branchPropertyAssignmentKey(index, objectName, propertyName),
      {
        index,
        jsonStoreValue,
        objectName,
        propertyName,
        storeValue,
      },
    );
  }

  function recordBranchFsSafeObjectPropertyAssignment(
    index: number,
    objectName: string,
    propertyName: string,
    initializer: ts.Expression,
    storeValue: boolean,
    jsonStoreValue: boolean,
  ) {
    const assignmentRoot = objectPropertyKey(objectName, propertyName);
    const storeAssignments = new Map([[assignmentRoot, storeValue]]);
    const jsonStoreAssignments = new Map([[assignmentRoot, jsonStoreValue]]);
    const descendantPrefix = `${assignmentRoot}.`;
    for (const scope of fsSafeStoreScopes) {
      for (const key of scope.keys()) {
        if (key.startsWith(descendantPrefix)) {
          storeAssignments.set(key, false);
        }
      }
    }
    for (const scope of fsSafeJsonStoreScopes) {
      for (const key of scope.keys()) {
        if (key.startsWith(descendantPrefix)) {
          jsonStoreAssignments.set(key, false);
        }
      }
    }
    registerFsSafeStoreObjectAliases(
      assignmentRoot,
      initializer,
      storeAssignments,
      jsonStoreAssignments,
    );
    const assignmentKeys = new Set([...storeAssignments.keys(), ...jsonStoreAssignments.keys()]);
    for (const key of assignmentKeys) {
      recordBranchFsSafePropertyAssignment(
        index,
        objectName,
        key.slice(`${objectName}.`.length),
        storeAssignments.get(key) === true,
        jsonStoreAssignments.get(key) === true,
      );
    }
  }

  function mergeWrapperAssignmentValues(
    left: WrapperValue | undefined,
    right: WrapperValue | undefined,
  ) {
    const records = [
      ...wrapperRecords(left).map(cloneWrapperRecord),
      ...wrapperRecords(right).map(cloneWrapperRecord),
    ];
    if (records.length === 0) {
      return null;
    }
    return records.length === 1 ? (records[0] ?? null) : records;
  }

  function mergeExhaustiveBranchEffects(thenEffects: BranchEffects, elseEffects: BranchEffects) {
    const mergedIdentifierNames = new Set<string>();
    const parentEffect = lastScope(branchEffectScopes);
    const applyToTargetScopes = !lastScope(conditionalExecutionScopes) && !parentEffect;
    for (const [key, thenAssignment] of thenEffects.fsIdentifierAssignments) {
      const elseAssignment = elseEffects.fsIdentifierAssignments.get(key);
      if (!elseAssignment || thenAssignment.index >= legacyPathScopes.length) {
        continue;
      }
      const { index, name } = thenAssignment;
      const mergedModuleValue = thenAssignment.moduleValue || elseAssignment.moduleValue;
      const mergedWriteAlias = thenAssignment.writeAlias ?? elseAssignment.writeAlias;
      const mergedFsSafeFactoryAlias =
        thenAssignment.fsSafeFactoryAlias ?? elseAssignment.fsSafeFactoryAlias;
      const mergedFsSafeStoreValue =
        thenAssignment.fsSafeStoreValue || elseAssignment.fsSafeStoreValue;
      const mergedFsSafeJsonStoreValue =
        thenAssignment.fsSafeJsonStoreValue || elseAssignment.fsSafeJsonStoreValue;
      const mergedRequireAlias = thenAssignment.requireAlias || elseAssignment.requireAlias;
      if (applyToTargetScopes) {
        fsModuleBindingScopes[index]!.set(name, mergedModuleValue);
        fsWriteAliasScopes[index]!.set(name, mergedWriteAlias);
        fsSafeStoreFactoryAliasScopes[index]!.set(name, mergedFsSafeFactoryAlias);
        fsSafeStoreScopes[index]!.set(name, mergedFsSafeStoreValue);
        fsSafeJsonStoreScopes[index]!.set(name, mergedFsSafeJsonStoreValue);
        requireAliasScopes[index]!.set(name, mergedRequireAlias);
      }
      lastScope(fsModuleBindingScopes).set(name, mergedModuleValue);
      lastScope(fsWriteAliasScopes).set(name, mergedWriteAlias);
      lastScope(fsSafeStoreFactoryAliasScopes).set(name, mergedFsSafeFactoryAlias);
      lastScope(fsSafeStoreScopes).set(name, mergedFsSafeStoreValue);
      lastScope(fsSafeJsonStoreScopes).set(name, mergedFsSafeJsonStoreValue);
      lastScope(requireAliasScopes).set(name, mergedRequireAlias);
      if (parentEffect) {
        parentEffect.fsIdentifierAssignments.set(branchIdentifierAssignmentKey(index, name), {
          fsSafeFactoryAlias: mergedFsSafeFactoryAlias,
          fsSafeJsonStoreValue: mergedFsSafeJsonStoreValue,
          fsSafeStoreValue: mergedFsSafeStoreValue,
          index,
          moduleValue: mergedModuleValue,
          name,
          requireAlias: mergedRequireAlias,
          writeAlias: mergedWriteAlias,
        });
      }
    }
    for (const [key, thenAssignment] of thenEffects.identifierAssignments) {
      const elseAssignment = elseEffects.identifierAssignments.get(key);
      if (!elseAssignment || thenAssignment.index >= legacyPathScopes.length) {
        continue;
      }
      const { index, name } = thenAssignment;
      mergedIdentifierNames.add(branchIdentifierAssignmentKey(index, name));
      const merged = mergeLegacyPathBranchAssignments(thenAssignment, elseAssignment);
      if (applyToTargetScopes) {
        const pathScope = legacyPathScopes[index]!;
        const literalScope = literalTextScopes[index]!;
        const knownUndefinedScope = knownUndefinedScopes[index]!;
        const propertyScope = legacyObjectPropertyScopes[index]!;
        const knownObjectLiteralScope = legacyKnownObjectLiteralScopes[index]!;
        clearKnownLegacyObjectLiterals(knownObjectLiteralScope, name);
        knownObjectLiteralScope.set(name, merged.knownObjectLiteral);
        for (const [knownObjectLiteralKey, value] of merged.knownObjectLiterals) {
          knownObjectLiteralScope.set(knownObjectLiteralKey, value);
        }
        pathScope.set(name, merged.value);
        knownUndefinedScope.set(name, merged.knownUndefined);
        literalScope.set(name, merged.literalTexts);
        clearLegacyObjectProperties(propertyScope, name);
        for (const [propertyKey, value] of merged.objectProperties) {
          propertyScope.set(propertyKey, value);
        }
      }
      clearKnownLegacyObjectLiterals(lastScope(legacyKnownObjectLiteralScopes), name);
      lastScope(legacyKnownObjectLiteralScopes).set(name, merged.knownObjectLiteral);
      for (const [knownObjectLiteralKey, value] of merged.knownObjectLiterals) {
        lastScope(legacyKnownObjectLiteralScopes).set(knownObjectLiteralKey, value);
      }
      lastScope(legacyPathScopes).set(name, merged.value);
      lastScope(knownUndefinedScopes).set(name, merged.knownUndefined);
      lastScope(literalTextScopes).set(name, merged.literalTexts);
      clearLegacyObjectProperties(lastScope(legacyObjectPropertyScopes), name);
      for (const [propertyKey, value] of merged.objectProperties) {
        lastScope(legacyObjectPropertyScopes).set(propertyKey, value);
      }
      if (parentEffect) {
        parentEffect.identifierAssignments.set(branchIdentifierAssignmentKey(index, name), {
          index,
          ...merged,
          literalTexts: merged.literalTexts ?? [],
          name,
        });
      }
    }
    for (const [key, thenAssignment] of thenEffects.fsSafePropertyAssignments) {
      const elseAssignment = elseEffects.fsSafePropertyAssignments.get(key);
      if (!elseAssignment || thenAssignment.index >= legacyPathScopes.length) {
        continue;
      }
      const mergedStoreValue = thenAssignment.storeValue || elseAssignment.storeValue;
      const mergedJsonStoreValue = thenAssignment.jsonStoreValue || elseAssignment.jsonStoreValue;
      const propertyKey = objectPropertyKey(thenAssignment.objectName, thenAssignment.propertyName);
      if (applyToTargetScopes) {
        fsSafeStoreScopes[thenAssignment.index]!.set(propertyKey, mergedStoreValue);
        fsSafeJsonStoreScopes[thenAssignment.index]!.set(propertyKey, mergedJsonStoreValue);
      }
      lastScope(fsSafeStoreScopes).set(propertyKey, mergedStoreValue);
      lastScope(fsSafeJsonStoreScopes).set(propertyKey, mergedJsonStoreValue);
      if (parentEffect) {
        recordBranchFsSafePropertyAssignment(
          thenAssignment.index,
          thenAssignment.objectName,
          thenAssignment.propertyName,
          mergedStoreValue,
          mergedJsonStoreValue,
        );
      }
    }
    for (const [key, thenAssignment] of thenEffects.propertyAssignments) {
      const elseAssignment = elseEffects.propertyAssignments.get(key);
      if (!elseAssignment || thenAssignment.index >= legacyPathScopes.length) {
        continue;
      }
      const identifierKey = branchIdentifierAssignmentKey(
        thenAssignment.index,
        thenAssignment.objectName,
      );
      if (mergedIdentifierNames.has(identifierKey)) {
        continue;
      }
      const mergedValue = mergeLegacyObjectPropertyValues(
        thenAssignment.value,
        elseAssignment.value,
      );
      const mergedKnownObjectLiteral =
        thenAssignment.knownObjectLiteral && elseAssignment.knownObjectLiteral;
      const propertyKey = objectPropertyKey(thenAssignment.objectName, thenAssignment.propertyName);
      if (applyToTargetScopes) {
        legacyObjectPropertyScopes[thenAssignment.index]!.set(propertyKey, mergedValue);
        legacyKnownObjectLiteralScopes[thenAssignment.index]!.set(
          propertyKey,
          mergedKnownObjectLiteral,
        );
      }
      lastScope(legacyObjectPropertyScopes).set(propertyKey, mergedValue);
      lastScope(legacyKnownObjectLiteralScopes).set(propertyKey, mergedKnownObjectLiteral);
      if (parentEffect) {
        recordBranchPropertyAssignment(
          thenAssignment.index,
          thenAssignment.objectName,
          thenAssignment.propertyName,
          mergedValue,
          mergedKnownObjectLiteral,
        );
      }
    }
    for (const [key, thenAssignment] of thenEffects.wrapperAssignments) {
      const elseAssignment = elseEffects.wrapperAssignments.get(key);
      if (!elseAssignment || thenAssignment.index >= legacyPathScopes.length) {
        continue;
      }
      const { index, name } = thenAssignment;
      const mergedValue = mergeWrapperAssignmentValues(thenAssignment.value, elseAssignment.value);
      if (applyToTargetScopes) {
        wrapperFunctionScopes[index]!.set(name, cloneWrapperFunctionValue(mergedValue));
      }
      lastScope(wrapperFunctionScopes).set(name, cloneWrapperFunctionValue(mergedValue));
      if (parentEffect) {
        parentEffect.wrapperAssignments.set(branchWrapperAssignmentKey(index, name), {
          index,
          name,
          value: cloneWrapperFunctionValue(mergedValue),
        });
      }
    }
  }

  function markLegacyObjectProperties(
    objectName: string,
    initializer: ts.Expression,
    targetScope: StringMap<LegacyPropertyValue> = lastScope(legacyObjectPropertyScopes),
    knownObjectLiteralScope: StringMap<boolean> | null = lastScope(legacyKnownObjectLiteralScopes),
  ) {
    const objectLiteral = unwrapExpression(initializer);
    if (ts.isIdentifier(objectLiteral)) {
      copyLegacyObjectProperties(objectName, objectLiteral.text, targetScope);
      if (knownObjectLiteralScope) {
        copyKnownLegacyObjectLiterals(objectName, objectLiteral.text, knownObjectLiteralScope);
      }
      return;
    }
    if (!ts.isObjectLiteralExpression(objectLiteral)) {
      knownObjectLiteralScope?.set(objectName, false);
      return;
    }
    knownObjectLiteralScope?.set(objectName, true);
    for (const property of objectLiteral.properties) {
      if (ts.isPropertyAssignment(property)) {
        const resolvedNames = ts.isComputedPropertyName(property.name)
          ? elementAccessNames(property.name.expression)
          : [propertyNameText(property.name)].filter((name): name is string => name !== null);
        const names = resolvedNames.length > 0 ? resolvedNames : [unknownComputedPropertyName];
        for (const name of names) {
          const propertyKey = `${objectName}.${name}`;
          const unknownComputed = name === unknownComputedPropertyName;
          if (!unknownComputed) {
            clearLegacyObjectProperties(targetScope, propertyKey);
            if (knownObjectLiteralScope) {
              clearKnownLegacyObjectLiterals(knownObjectLiteralScope, propertyKey);
            }
          }
          const propertyValue = legacyObjectPropertyValueFromExpression(property.initializer);
          targetScope.set(
            propertyKey,
            unknownComputed
              ? targetScope.get(propertyKey) === true || propertyValue
              : propertyValue,
          );
          const propertyInitializer = unwrapExpression(property.initializer);
          if (ts.isIdentifier(propertyInitializer)) {
            copyLegacyObjectProperties(propertyKey, propertyInitializer.text, targetScope);
            if (knownObjectLiteralScope) {
              copyKnownLegacyObjectLiterals(
                propertyKey,
                propertyInitializer.text,
                knownObjectLiteralScope,
              );
            }
          } else {
            knownObjectLiteralScope?.set(
              propertyKey,
              isKnownLegacyObjectLiteralExpression(property.initializer),
            );
          }
          if (ts.isObjectLiteralExpression(propertyInitializer)) {
            markLegacyObjectProperties(
              propertyKey,
              property.initializer,
              targetScope,
              knownObjectLiteralScope,
            );
          }
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const propertyKey = `${objectName}.${property.name.text}`;
        targetScope.set(propertyKey, legacyObjectPropertyValueFromExpression(property.name));
        copyLegacyObjectProperties(propertyKey, property.name.text, targetScope);
        if (knownObjectLiteralScope) {
          copyKnownLegacyObjectLiterals(propertyKey, property.name.text, knownObjectLiteralScope);
        }
        continue;
      }
      if (ts.isSpreadAssignment(property)) {
        const spreadExpression = unwrapExpression(property.expression);
        if (ts.isIdentifier(spreadExpression)) {
          copyLegacyObjectProperties(objectName, spreadExpression.text, targetScope);
          if (knownObjectLiteralScope) {
            copyKnownLegacyObjectLiterals(
              objectName,
              spreadExpression.text,
              knownObjectLiteralScope,
            );
          }
        } else if (ts.isObjectLiteralExpression(spreadExpression)) {
          markLegacyObjectProperties(
            objectName,
            spreadExpression,
            targetScope,
            knownObjectLiteralScope,
          );
        } else {
          knownObjectLiteralScope?.set(objectName, false);
        }
      }
    }
  }

  function copyLegacyObjectProperties(
    targetName: string,
    sourceName: string,
    targetScope: StringMap<LegacyPropertyValue> = lastScope(legacyObjectPropertyScopes),
  ) {
    const sourcePrefix = `${sourceName}.`;
    for (let index = legacyObjectPropertyScopes.length - 1; index >= 0; index--) {
      const scope = legacyObjectPropertyScopes[index]!;
      const copiedEntries: Array<[string, LegacyPropertyValue]> = [];
      for (const [key, value] of scope) {
        if (key.startsWith(sourcePrefix)) {
          copiedEntries.push([`${targetName}.${key.slice(sourcePrefix.length)}`, value]);
        }
      }
      copiedEntries.sort((left, right) => left[0].length - right[0].length);
      for (const [key, value] of copiedEntries) {
        clearLegacyObjectProperties(targetScope, key);
        targetScope.set(key, value);
      }
      const copied = copiedEntries.length > 0;
      if (copied || legacyPathScopes[index]!.has(sourceName)) {
        return;
      }
    }
  }

  function copyKnownLegacyObjectLiterals(
    targetName: string,
    sourceName: string,
    targetScope: StringMap<boolean> = lastScope(legacyKnownObjectLiteralScopes),
  ) {
    targetScope.set(targetName, lookupKnownLegacyObjectLiteral(sourceName));
    const sourcePrefix = `${sourceName}.`;
    for (let index = legacyKnownObjectLiteralScopes.length - 1; index >= 0; index--) {
      const scope = legacyKnownObjectLiteralScopes[index]!;
      const copiedEntries: Array<[string, boolean]> = [];
      for (const [key, value] of scope) {
        if (key.startsWith(sourcePrefix)) {
          copiedEntries.push([`${targetName}.${key.slice(sourcePrefix.length)}`, value]);
        }
      }
      copiedEntries.sort((left, right) => left[0].length - right[0].length);
      for (const [key, value] of copiedEntries) {
        clearKnownLegacyObjectLiterals(targetScope, key);
        targetScope.set(key, value);
      }
      const copied = copiedEntries.length > 0;
      if (copied || scope.has(sourceName) || legacyPathScopes[index]!.has(sourceName)) {
        return;
      }
    }
  }

  function bindingPatternNames(name: ts.BindingName) {
    const names: string[] = [];
    function visitName(current: ts.BindingName) {
      if (ts.isIdentifier(current)) {
        names.push(current.text);
        return;
      }
      if (ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current)) {
        for (const element of current.elements) {
          if (ts.isBindingElement(element)) {
            visitName(element.name);
          }
        }
      }
    }
    visitName(name);
    return names;
  }

  function markFsSafeFactoryAliasesFromObjectBinding(
    bindingPattern: ts.ObjectBindingPattern,
    sourceName: string,
  ) {
    for (const element of bindingPattern.elements) {
      if (!ts.isIdentifier(element.name)) {
        continue;
      }
      const propertyName = element.propertyName
        ? propertyNameText(element.propertyName)
        : element.name.text;
      const factoryAlias = propertyName
        ? resolveFsSafeStoreFactoryAlias(`${sourceName}.${propertyName}`)
        : null;
      if (factoryAlias) {
        lastScope(fsSafeStoreFactoryAliasScopes).set(element.name.text, factoryAlias);
      }
    }
  }

  function registerTrackedObjectMethods({
    objectName,
    initializer,
    directSourceName = () => null,
    spreadSourceName = directSourceName,
    onAlias = () => {},
    onUnknownSpread = () => {},
    onSpread = onAlias,
    onPropertyName = () => {},
    onMethod,
    onIdentifier,
    onNested,
    onOther = () => {},
  }: TrackedObjectMethodsParams) {
    const objectLiteral = unwrapExpression(initializer);
    const directSource = directSourceName(objectLiteral);
    if (directSource) {
      onAlias(objectName, directSource);
      return;
    }
    if (!ts.isObjectLiteralExpression(objectLiteral)) {
      return;
    }

    for (const property of objectLiteral.properties) {
      if (ts.isSpreadAssignment(property)) {
        const sourceName = spreadSourceName(unwrapExpression(property.expression));
        if (sourceName) {
          onSpread(objectName, sourceName);
        } else {
          onUnknownSpread(objectName);
        }
        continue;
      }

      const propertyName = ts.isMethodDeclaration(property)
        ? propertyNameText(property.name)
        : ts.isPropertyAssignment(property)
          ? propertyNameText(property.name)
          : ts.isShorthandPropertyAssignment(property)
            ? property.name.text
            : null;
      if (!propertyName) {
        continue;
      }
      const key = `${objectName}.${propertyName}`;
      onPropertyName(propertyName, key);
      if (ts.isMethodDeclaration(property)) {
        onMethod(key, property);
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        onIdentifier(key, property.name.text, property.name);
        continue;
      }

      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      const propertyInitializer = unwrapExpression(property.initializer);
      if (ts.isFunctionExpression(propertyInitializer) || ts.isArrowFunction(propertyInitializer)) {
        onMethod(key, propertyInitializer);
        continue;
      }
      if (ts.isIdentifier(propertyInitializer)) {
        onIdentifier(key, propertyInitializer.text, property.initializer);
        continue;
      }
      const hasNestedObject = ts.isObjectLiteralExpression(propertyInitializer);
      if (hasNestedObject) {
        onNested(key, propertyInitializer);
      }
      onOther(key, property.initializer, hasNestedObject);
    }
  }

  function wrapperRecordForNode(node: WrapperNode) {
    return {
      environment: lexicalScopeStacks.map(([scopes]) => [...scopes]),
      node,
    };
  }

  function registerWrapperFunction(name: string, node: WrapperNode) {
    lastScope(wrapperFunctionScopes).set(name, wrapperRecordForNode(node));
  }

  function setWrapperFunctionValue(
    scope: StringMap<WrapperValue>,
    name: string,
    value: WrapperValue,
    conditionalWrite: boolean,
  ) {
    if (value) {
      if (conditionalWrite && scope.has(name)) {
        scope.set(name, [...wrapperRecords(scope.get(name)), ...wrapperRecords(value)]);
      } else {
        scope.set(name, value);
      }
    } else if (!conditionalWrite) {
      scope.set(name, null);
    }
  }

  function clearWrapperObjectMethods(scope: StringMap<WrapperValue>, objectName: string) {
    shadowObjectPropertyScopes([scope], objectName, null, scope);
  }

  function clearWrapperObjectMethod(scope: StringMap<WrapperValue>, methodName: string) {
    scope.set(methodName, null);
    clearWrapperObjectMethods(scope, methodName);
  }

  function shadowVisibleWrapperObjectMethods(objectName: string) {
    shadowObjectPropertyScopes(wrapperFunctionScopes, objectName, null);
  }

  function copyWrapperObjectMethods(
    targetName: string,
    sourceName: string,
    scope: StringMap<WrapperValue> = lastScope(wrapperFunctionScopes),
    conditionalWrite = false,
  ) {
    const sourcePrefix = `${sourceName}.`;
    let copiedCount = 0;
    const visibleScopeIndexes: number[] = [];
    for (let index = wrapperFunctionScopes.length - 1; index >= 0; index--) {
      visibleScopeIndexes.push(index);
      if (
        wrapperFunctionScopes[index]!.has(sourceName) ||
        legacyPathScopes[index]!.has(sourceName)
      ) {
        break;
      }
    }
    for (const index of visibleScopeIndexes.toReversed()) {
      const sourceScope = wrapperFunctionScopes[index]!;
      for (const [name, value] of sourceScope) {
        if (!name.startsWith(sourcePrefix)) {
          continue;
        }
        setWrapperFunctionValue(
          scope,
          `${targetName}.${name.slice(sourcePrefix.length)}`,
          cloneWrapperFunctionValue(value),
          conditionalWrite,
        );
        copiedCount += 1;
      }
    }
    return copiedCount;
  }

  function registerWrapperObjectMethods(
    objectName: string,
    initializer: ts.Expression,
    scope: StringMap<WrapperValue> = lastScope(wrapperFunctionScopes),
    conditionalWrite = false,
  ) {
    const seenProperties = new Set<string>();
    const remember = (key: string, value: WrapperValue): void =>
      setWrapperFunctionValue(scope, key, value, conditionalWrite);
    const copy = (targetName: string, sourceName: string): number =>
      copyWrapperObjectMethods(targetName, sourceName, scope, conditionalWrite);

    registerTrackedObjectMethods({
      objectName,
      initializer,
      onUnknownSpread: () => clearWrapperObjectMethods(scope, objectName),
      onSpread: (targetName, sourceName) => {
        if (copy(targetName, sourceName) === 0 && !lookupKnownLegacyObjectLiteral(sourceName)) {
          clearWrapperObjectMethods(scope, targetName);
        }
      },
      spreadSourceName: (expression) =>
        ts.isIdentifier(expression) ? expression.text : callExpressionName(expression),
      onPropertyName: (propertyName, key) => {
        if (seenProperties.has(propertyName)) {
          clearWrapperObjectMethod(scope, key);
        }
        seenProperties.add(propertyName);
      },
      onMethod: (key, method) => remember(key, wrapperRecordForNode(method)),
      onIdentifier: (key, identifier) => {
        const wrapper = resolveWrapperFunction(identifier);
        if (wrapper) {
          remember(key, cloneWrapperFunctionValue(wrapper));
        }
        copy(key, identifier);
      },
      onNested: (key, nested) => registerWrapperObjectMethods(key, nested, scope, conditionalWrite),
      onOther: (key, value) => {
        const wrapper = resolveWrapperExpression(value);
        if (wrapper) {
          remember(key, cloneWrapperFunctionValue(wrapper));
        }
      },
    });
  }
  function wrapperRecords(value: WrapperValue | undefined) {
    if (!value) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  }

  function cloneWrapperRecord(record: WrapperRecord) {
    return {
      environment: record.environment.map((scopes) => [...scopes]),
      node: record.node,
    };
  }

  function cloneWrapperFunctionValue(value: WrapperValue | undefined) {
    if (!value) {
      return null;
    }
    const records = wrapperRecords(value).map(cloneWrapperRecord);
    return Array.isArray(value) ? records : (records[0] ?? null);
  }

  function registerHoistedWrapperFunctions(statements: readonly ts.Statement[]) {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        bindIdentifierFact(statement.name.text, undefinedFact());
        registerWrapperFunction(statement.name.text, statement);
        continue;
      }
      if (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0
      ) {
        for (const declaration of statement.declarationList.declarations) {
          for (const name of bindingPatternNames(declaration.name)) {
            bindIdentifierFact(name, undefinedFact());
          }
        }
      }
    }
  }

  function resolveWrapperFunction(name: string) {
    for (let index = wrapperFunctionScopes.length - 1; index >= 0; index--) {
      const wrapperScope = wrapperFunctionScopes[index]!;
      if (wrapperScope.has(name)) {
        return wrapperScope.get(name) ?? null;
      }
      if (legacyPathScopes[index]!.has(name)) {
        return null;
      }
    }
    return null;
  }

  function resolveWrapperExpression(expression: ts.Expression) {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      return resolveWrapperFunction(unwrapped.text);
    }
    const name = callExpressionName(unwrapped);
    return name ? resolveWrapperFunction(name) : null;
  }

  function pathArgumentContainsLegacyStore(argument: ts.Expression) {
    return expressionContainsLegacyStore(argument);
  }

  function isUndefinedExpression(expression: ts.Expression) {
    const unwrapped = unwrapExpression(expression);
    return (
      (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") ||
      ts.isVoidExpression(unwrapped)
    );
  }

  function isKnownUndefinedExpression(expression: ts.Expression) {
    const unwrapped = unwrapExpression(expression);
    return (
      isUndefinedExpression(unwrapped) ||
      (ts.isIdentifier(unwrapped) && resolveKnownUndefinedIdentifier(unwrapped.text))
    );
  }

  function callExpressionName(expression: ts.Expression) {
    const callee = unwrapExpression(expression);
    const pathParts = propertyAccessPath(callee);
    return pathParts ? pathParts.join(".") : null;
  }

  function rootedPropertyAccessPath(expression: ts.Expression) {
    const access = rootedPropertyAccessCandidates(expression);
    const onlyPath = access?.propertyPaths[0];
    if (
      !access ||
      access.propertyPaths.length !== 1 ||
      !onlyPath ||
      !onlyPath.every((property): property is string => property !== null)
    ) {
      return null;
    }
    return { rootName: access.rootName, properties: onlyPath };
  }

  function rootedPropertyAccessCandidates(expression: ts.Node) {
    if (!ts.isExpression(expression)) {
      return null;
    }
    const properties: Array<Array<string | null>> = [];
    let current = unwrapExpression(expression);
    while (true) {
      if (ts.isPropertyAccessExpression(current)) {
        properties.unshift([current.name.text]);
        current = unwrapExpression(current.expression);
        continue;
      }
      if (ts.isElementAccessExpression(current)) {
        const propertyNames = elementAccessNames(current.argumentExpression);
        properties.unshift(propertyNames.length > 0 ? propertyNames : [null]);
        current = unwrapExpression(current.expression);
        continue;
      }
      break;
    }
    if (!ts.isIdentifier(current)) {
      return null;
    }
    let propertyPaths: Array<Array<string | null>> = [[]];
    let truncated = false;
    for (const names of properties) {
      const nextPaths: Array<Array<string | null>> = [];
      outer: for (const propertyPath of propertyPaths) {
        for (const name of names) {
          if (nextPaths.length === 31) {
            truncated = true;
            break outer;
          }
          nextPaths.push([...propertyPath, name]);
        }
      }
      propertyPaths = nextPaths;
    }
    if (truncated) {
      propertyPaths.push(properties.map(() => null));
    }
    return { rootName: current.text, propertyPaths };
  }

  function lookupLegacyObjectPropertyCandidates({
    rootName,
    propertyPaths,
  }: NonNullable<ReturnType<typeof rootedPropertyAccessCandidates>>) {
    let unresolved = false;
    for (const propertyPath of propertyPaths) {
      if (!propertyPath.includes(null)) {
        let foundPrefix = false;
        for (let length = propertyPath.length; length > 0; length--) {
          const entry = lookupLegacyObjectPropertyEntry(
            rootName,
            propertyPath.slice(0, length).join("."),
          );
          if (entry.found) {
            foundPrefix = true;
            if (entry.value === true) {
              return true;
            }
            break;
          }
        }
        unresolved ||= !foundPrefix && resolveLegacyPathIdentifier(rootName);
        continue;
      }
      const prefix = `${rootName}.`;
      let rootIsLegacy = false;
      for (let length = propertyPath.length; length > 0; length--) {
        const candidate = propertyPath.slice(0, length);
        const seen = new Set<string>();
        let matched = false;
        for (let index = legacyObjectPropertyScopes.length - 1; index >= 0; index--) {
          for (const [key, value] of legacyObjectPropertyScopes[index]!) {
            if (!key.startsWith(prefix) || seen.has(key)) {
              continue;
            }
            const parts = key.slice(prefix.length).split(".");
            if (
              parts.length === candidate.length &&
              candidate.every((part, partIndex) => part === null || part === parts[partIndex])
            ) {
              seen.add(key);
              matched = true;
              if (value === true) {
                return true;
              }
            }
          }
          if (legacyPathScopes[index]!.has(rootName)) {
            rootIsLegacy ||= legacyPathScopes[index]!.get(rootName) === true;
            break;
          }
        }
        if (matched) {
          break;
        }
      }
      unresolved ||= rootIsLegacy;
    }
    return unresolved ? null : false;
  }

  function copyFactEntries<Value>(
    target: StringMap<Value>,
    source: StringMap<Value>,
    fromRoot: string,
    toRoot: string,
  ) {
    for (const [key, value] of source) {
      if (key === fromRoot || key.startsWith(`${fromRoot}.`)) {
        target.set(`${toRoot}${key.slice(fromRoot.length)}`, value);
      }
    }
  }

  function expressionProducesLegacyPath(expression: ts.Expression): boolean {
    const node = unwrapExpression(expression);
    if (ts.isIdentifier(node)) {
      return resolveLegacyPathIdentifier(node.text);
    }
    if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
      return false;
    }
    if (ts.isConditionalExpression(node)) {
      return (
        expressionProducesLegacyPath(node.whenTrue) || expressionProducesLegacyPath(node.whenFalse)
      );
    }
    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.CommaToken ||
        (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment)
      ) {
        return expressionProducesLegacyPath(node.right);
      }
      if (
        operator !== ts.SyntaxKind.BarBarToken &&
        operator !== ts.SyntaxKind.QuestionQuestionToken &&
        operator !== ts.SyntaxKind.PlusToken
      ) {
        return false;
      }
      return (
        expressionTextContainsLegacyStore(node) ||
        expressionProducesLegacyPath(node.left) ||
        expressionProducesLegacyPath(node.right)
      );
    }
    const access = rootedPropertyAccessCandidates(node);
    if (access?.propertyPaths.some((propertyPath) => propertyPath.length > 0)) {
      const value = lookupLegacyObjectPropertyCandidates(access);
      return value ?? resolveLegacyPathIdentifier(access.rootName);
    }
    if (ts.isTemplateExpression(node)) {
      return (
        expressionTextContainsLegacyStore(node) ||
        node.templateSpans.some((span) => expressionProducesLegacyPath(span.expression))
      );
    }
    if (ts.isCallExpression(node)) {
      const receiver =
        ts.isPropertyAccessExpression(node.expression) ||
        ts.isElementAccessExpression(node.expression)
          ? node.expression.expression
          : null;
      return (
        expressionTextContainsLegacyStore(node) ||
        (receiver ? expressionProducesLegacyPath(receiver) : false) ||
        [...node.arguments].some(expressionProducesLegacyPath)
      );
    }
    return expressionTextContainsLegacyStore(node);
  }

  function factExpressionAlternatives(expression: ts.Expression): ts.Expression[] {
    const unwrapped = unwrapExpression(expression);
    if (ts.isSatisfiesExpression(unwrapped) || ts.isAwaitExpression(unwrapped)) {
      return factExpressionAlternatives(unwrapped.expression);
    }
    if (ts.isConditionalExpression(unwrapped)) {
      return [unwrapped.whenTrue, unwrapped.whenFalse].flatMap(factExpressionAlternatives);
    }
    if (ts.isBinaryExpression(unwrapped)) {
      const operator = unwrapped.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.CommaToken ||
        (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment)
      ) {
        return factExpressionAlternatives(unwrapped.right);
      }
      if (
        [
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.QuestionQuestionToken,
        ].includes(operator)
      ) {
        return [unwrapped.left, unwrapped.right].flatMap(factExpressionAlternatives);
      }
    }
    if (
      ts.isCallExpression(unwrapped) &&
      callExpressionName(unwrapped.expression) === "Promise.resolve" &&
      unwrapped.arguments[0]
    ) {
      return factExpressionAlternatives(unwrapped.arguments[0]!);
    }
    if (ts.isNewExpression(unwrapped) && unwrapped.arguments?.length) {
      return unwrapped.arguments.flatMap(factExpressionAlternatives);
    }
    return [unwrapped];
  }

  function mergeExpressionFacts(facts: ExpressionFact[], expression: ts.Expression | null) {
    const mergeMap = <Value,>(
      select: (fact: ExpressionFact) => StringMap<Value>,
      merge: (left: Value, right: Value) => Value,
    ) => {
      const result = new Map<string, Value>();
      for (const fact of facts) {
        for (const [key, value] of select(fact)) {
          const previous = result.get(key);
          result.set(key, previous === undefined ? value : merge(previous, value));
        }
      }
      return result;
    };
    const properties = new Map<string, LegacyPropertyValue>();
    const propertyKeys = new Set(facts.flatMap((fact) => [...fact.properties.keys()]));
    for (const key of propertyKeys) {
      for (const fact of facts) {
        const value = fact.properties.has(key)
          ? fact.properties.get(key)
          : fact.knownObject
            ? explicitUndefinedLegacyObjectPropertyValue
            : fact.legacyPath
              ? true
              : undefined;
        if (value !== undefined) {
          properties.set(
            key,
            properties.has(key)
              ? mergeLegacyObjectPropertyValues(properties.get(key), value)
              : value,
          );
        }
      }
    }
    return {
      root: "<argument>",
      expression,
      fsModule: facts.some((fact) => fact.fsModule),
      fsModules: mergeMap(
        (fact) => fact.fsModules,
        (left, right) => left || right,
      ),
      fsSafeFactory: facts.find((fact) => fact.fsSafeFactory)?.fsSafeFactory ?? null,
      fsWrite: facts.find((fact) => fact.fsWrite)?.fsWrite ?? null,
      fsWrites: mergeMap(
        (fact) => fact.fsWrites,
        (left, right) => left ?? right,
      ),
      jsonStore: facts.some((fact) => fact.jsonStore),
      jsonStores: mergeMap(
        (fact) => fact.jsonStores,
        (left, right) => left || right,
      ),
      knownObject: facts.every((fact) => fact.knownObject),
      knownObjects: mergeMap(
        (fact) => fact.knownObjects,
        (left, right) => left && right,
      ),
      knownUndefined: facts.every((fact) => fact.knownUndefined),
      legacyPath: facts.some((fact) => fact.legacyPath),
      literalTexts: [...new Set(facts.flatMap((fact) => fact.literalTexts))],
      properties,
      requireAlias: facts.some((fact) => fact.requireAlias),
      store: facts.some((fact) => fact.store),
      stores: mergeMap(
        (fact) => fact.stores,
        (left, right) => left || right,
      ),
      wrapper: facts.map((fact) => fact.wrapper).reduce(mergeWrapperAssignmentValues, null),
      wrappers: mergeMap((fact) => fact.wrappers, mergeWrapperAssignmentValues),
      possiblyUndefined: facts.some((fact) => fact.possiblyUndefined ?? fact.knownUndefined),
    } satisfies ExpressionFact;
  }

  function factFromExpression(expression: ts.Expression): ExpressionFact {
    const alternatives = factExpressionAlternatives(expression);
    const bounded = alternatives.length > 32 ? alternatives.slice(0, 31) : alternatives;
    const facts = bounded.map(atomicFactFromExpression);
    if (bounded.length !== alternatives.length) {
      const discarded = alternatives.slice(31);
      facts.push(mergeExpressionFacts(discarded.map(atomicFactFromExpression), expression));
    }
    return facts.length === 1 && alternatives[0] === expression
      ? facts[0]!
      : mergeExpressionFacts(facts, expression);
  }

  function atomicFactFromExpression(expression: ts.Expression): ExpressionFact {
    const root = "<argument>";
    const properties = new Map<string, LegacyPropertyValue>();
    const knownObjects = new Map<string, boolean>();
    const fsWrites = new Map<string, string | null>();
    const stores = new Map<string, boolean>();
    const jsonStores = new Map<string, boolean>();
    const fsModules = new Map<string, boolean>();
    const wrappers = new Map<string, WrapperValue>();
    markLegacyObjectProperties(root, expression, properties, knownObjects);
    registerFsWriteObjectAliases(root, expression, fsWrites);
    registerFsSafeStoreObjectAliases(root, expression, stores, jsonStores);
    registerFsModuleObjectProperties(root, expression, fsModules);
    const unwrapped = unwrapExpression(expression);
    const sourceName = callExpressionName(unwrapped);
    if (sourceName) {
      copyLegacyObjectProperties(root, sourceName, properties);
      copyKnownLegacyObjectLiterals(root, sourceName, knownObjects);
      copyFsSafeStoreObjectAliases(root, sourceName, stores, jsonStores);
    }
    registerWrapperObjectMethods(root, expression, wrappers);
    if (sourceName) {
      copyWrapperObjectMethods(root, sourceName, wrappers);
    }
    return {
      root,
      expression,
      fsModule: isFsBindingExpression(expression),
      fsModules,
      fsSafeFactory: fsSafeStoreFactoryAliasName(expression),
      fsWrite: legacyFsWriteName(expression),
      fsWrites,
      jsonStore: expressionContainsFsSafeJsonStoreLegacyPath(expression),
      jsonStores,
      knownObject: knownObjects.get(root) === true,
      knownObjects,
      knownUndefined: isKnownUndefinedExpression(expression),
      legacyPath: expressionProducesLegacyPath(expression),
      literalTexts: ts.isIdentifier(unwrapped)
        ? resolveLiteralTextIdentifier(unwrapped.text)
        : literalTextsFromExpression(expression),
      properties,
      requireAlias: isRequireAliasExpression(expression),
      store: isFsSafeStoreExpression(expression),
      stores,
      wrapper:
        ts.isFunctionExpression(unwrapped) || ts.isArrowFunction(unwrapped)
          ? wrapperRecordForNode(unwrapped)
          : cloneWrapperFunctionValue(resolveWrapperExpression(expression)),
      wrappers,
    };
  }

  function propertyFact(fact: ExpressionFact, propertyName: string) {
    const root = `${fact.root}.${propertyName}`;
    const value = fact.properties.get(root);
    const missing =
      value === undefined &&
      !fact.wrappers.has(root) &&
      !fact.fsWrites.has(root) &&
      !fact.fsModules.has(root) &&
      !fact.stores.has(root) &&
      !fact.jsonStores.has(root) &&
      !fact.knownObjects.has(root);
    if (missing && fact.knownObject) {
      return undefinedFact();
    }
    const result = undefinedFact();
    result.root = root;
    result.knownUndefined = value === explicitUndefinedLegacyObjectPropertyValue;
    if (missing) {
      result.knownUndefined = false;
    }
    result.legacyPath = value === true || (missing && !fact.knownObject && fact.legacyPath);
    result.knownObject = fact.knownObjects.get(root) === true;
    result.fsModule =
      fact.fsModules.get(root) === true || (fact.fsModule && propertyName === "promises");
    result.fsWrite =
      fact.fsWrites.get(root) ??
      (fact.fsModule && legacyWriteCallees.has(propertyName) ? propertyName : null);
    result.store = fact.stores.get(root) === true;
    result.jsonStore = fact.jsonStores.get(root) === true;
    result.wrapper = cloneWrapperFunctionValue(fact.wrappers.get(root));
    result.fsModules = fact.fsModules;
    result.fsWrites = fact.fsWrites;
    result.stores = fact.stores;
    result.jsonStores = fact.jsonStores;
    result.knownObjects = fact.knownObjects;
    result.properties = fact.properties;
    result.wrappers = fact.wrappers;
    return result;
  }

  function bindObjectPatternFact(pattern: ts.ObjectBindingPattern, sourceFact: ExpressionFact) {
    for (const element of pattern.elements) {
      const propertyName = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (!propertyName) {
        continue;
      }
      let nextFact = propertyFact(sourceFact, propertyName);
      if (nextFact.knownUndefined && element.initializer) {
        visit(element.initializer);
        nextFact = factFromExpression(element.initializer);
      }
      if (ts.isIdentifier(element.name)) {
        bindIdentifierFact(element.name.text, nextFact);
      } else if (ts.isObjectBindingPattern(element.name)) {
        bindObjectPatternFact(element.name, nextFact);
      }
    }
  }

  function bindIdentifierFact(name: string, fact: ExpressionFact, type?: ts.TypeNode) {
    shadowObjectPropertyScopes(fsModulePropertyScopes, name, false);
    shadowObjectPropertyScopes(fsWriteAliasScopes, name, null);
    shadowObjectPropertyScopes(fsSafeStoreScopes, name, false);
    shadowObjectPropertyScopes(fsSafeJsonStoreScopes, name, false);
    shadowObjectPropertyScopes(wrapperFunctionScopes, name, null);
    if (createRequireBindings.has(name)) {
      lastScope(createRequireShadowScopes).add(name);
    }
    lastScope(fsModuleBindingScopes).set(name, fact.fsModule);
    lastScope(fsModulePropertyScopes).set(name, false);
    copyFactEntries(lastScope(fsModulePropertyScopes), fact.fsModules, fact.root, name);
    registerFsModuleTypeProperties(ts.factory.createIdentifier(name), type);
    lastScope(fsWriteAliasScopes).set(name, fact.fsWrite);
    copyFactEntries(lastScope(fsWriteAliasScopes), fact.fsWrites, fact.root, name);
    lastScope(fsSafeStoreFactoryAliasScopes).set(name, fact.fsSafeFactory);
    lastScope(fsSafeStoreScopes).set(name, fact.store);
    lastScope(fsSafeJsonStoreScopes).set(name, fact.jsonStore);
    copyFactEntries(lastScope(fsSafeStoreScopes), fact.stores, fact.root, name);
    copyFactEntries(lastScope(fsSafeJsonStoreScopes), fact.jsonStores, fact.root, name);
    lastScope(requireAliasScopes).set(name, fact.requireAlias);
    lastScope(legacyPathScopes).set(name, fact.legacyPath);
    lastScope(literalTextScopes).set(name, fact.literalTexts);
    lastScope(staticExpressionScopes).set(name, fact.expression);
    lastScope(knownUndefinedScopes).set(name, fact.knownUndefined);
    lastScope(legacyKnownObjectLiteralScopes).set(name, fact.knownObject);
    copyFactEntries(lastScope(legacyKnownObjectLiteralScopes), fact.knownObjects, fact.root, name);
    copyFactEntries(lastScope(legacyObjectPropertyScopes), fact.properties, fact.root, name);
    lastScope(wrapperFunctionScopes).set(name, cloneWrapperFunctionValue(fact.wrapper));
    copyFactEntries(lastScope(wrapperFunctionScopes), fact.wrappers, fact.root, name);
  }

  function bindParameter(parameter: ts.ParameterDeclaration, fact: ExpressionFact) {
    if (ts.isIdentifier(parameter.name)) {
      bindIdentifierFact(parameter.name.text, fact, parameter.type);
      return;
    }
    if (ts.isObjectBindingPattern(parameter.name)) {
      bindObjectPatternFact(parameter.name, fact);
      return;
    }
    for (const name of bindingPatternNames(parameter.name)) {
      bindIdentifierFact(name, undefinedFact());
    }
    if (ts.isArrayBindingPattern(parameter.name)) {
      const array = fact.expression ? unwrapExpression(fact.expression) : null;
      if (array && ts.isArrayLiteralExpression(array)) {
        parameter.name.elements.forEach((element, elementIndex) => {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) {
            return;
          }
          const value = array.elements[elementIndex];
          if (value && !ts.isOmittedExpression(value) && !ts.isSpreadElement(value)) {
            bindIdentifierFact(element.name.text, factFromExpression(value));
          }
        });
      }
    }
  }

  function withWrapperEnvironment<Result>(record: WrapperRecord, run: () => Result) {
    const savedScopes = lexicalScopeStacks.map(([scopes]) => [...scopes]);
    for (let index = 0; index < lexicalScopeStacks.length; index++) {
      const scopes = lexicalScopeStacks[index]![0];
      scopes.splice(0, scopes.length, ...(record.environment[index] ?? []));
    }
    branchEffectScopes.push(null);
    try {
      return run();
    } finally {
      for (let index = 0; index < lexicalScopeStacks.length; index++) {
        const scopes = lexicalScopeStacks[index]![0];
        scopes.splice(0, scopes.length, ...(savedScopes[index] ?? []));
      }
      branchEffectScopes.pop();
    }
  }

  function spreadArgumentFacts(
    expression: ts.Expression,
    seen: Set<string> = new Set(),
  ): ExpressionFact[] | null {
    const unwrapped = unwrapExpression(expression);
    if (ts.isSatisfiesExpression(unwrapped) || ts.isAwaitExpression(unwrapped)) {
      return spreadArgumentFacts(unwrapped.expression, seen);
    }
    if (ts.isIdentifier(unwrapped)) {
      const resolved = !seen.has(unwrapped.text) && resolveStaticExpression(unwrapped.text);
      return resolved ? spreadArgumentFacts(resolved, new Set([...seen, unwrapped.text])) : null;
    }
    if (ts.isConditionalExpression(unwrapped)) {
      const left: ExpressionFact[] | null = spreadArgumentFacts(unwrapped.whenTrue, seen);
      const right: ExpressionFact[] | null = spreadArgumentFacts(unwrapped.whenFalse, seen);
      return left && right
        ? Array.from({ length: Math.max(left.length, right.length) }, (_, index) =>
            mergeExpressionFacts(
              [left[index] ?? undefinedFact(), right[index] ?? undefinedFact()],
              expression,
            ),
          )
        : null;
    }
    if (!ts.isArrayLiteralExpression(unwrapped)) {
      return null;
    }
    const facts: ExpressionFact[] = [];
    for (const element of unwrapped.elements) {
      if (ts.isOmittedExpression(element)) {
        facts.push(undefinedFact());
      } else if (ts.isSpreadElement(element)) {
        const nested: ExpressionFact[] | null = spreadArgumentFacts(element.expression, seen);
        if (!nested) {
          return null;
        }
        facts.push(...nested);
      } else {
        facts.push(factFromExpression(element));
      }
    }
    return facts;
  }

  function wrapperArgumentFacts(call: ts.CallExpression, parameterCount: number) {
    const facts: ExpressionFact[] = [];
    let ambiguous = false;
    let ambiguousStart = 0;
    for (const argument of call.arguments) {
      const expanded = ts.isSpreadElement(argument)
        ? spreadArgumentFacts(argument.expression)
        : [factFromExpression(argument)];
      if (!expanded) {
        ambiguousStart = ambiguous ? ambiguousStart : facts.length;
        ambiguous = true;
      }
      const next = expanded ?? [
        factFromExpression(ts.isSpreadElement(argument) ? argument.expression : argument),
      ];
      if (!ambiguous) {
        facts.push(...next);
        continue;
      }
      for (let index = ambiguousStart; index < parameterCount; index++) {
        facts[index] = mergeExpressionFacts([facts[index] ?? undefinedFact(), ...next], argument);
      }
    }
    return facts;
  }

  function executeWrapper(record: WrapperRecord, call: ts.CallExpression) {
    if (activeWrapperNodes.has(record.node)) {
      return;
    }
    const argumentFacts = wrapperArgumentFacts(call, record.node.parameters.length);
    activeWrapperNodes.add(record.node);
    wrapperCallSites.push(call.expression);
    try {
      withWrapperEnvironment(record, () =>
        withLexicalScope(false, () => {
          wrapperExecutionScopeIndexes.push(wrapperFunctionScopes.length - 1);
          try {
            if (record.node.name && ts.isIdentifier(record.node.name)) {
              bindIdentifierFact(record.node.name.text, {
                ...undefinedFact(),
                knownUndefined: false,
                wrapper: record,
              });
            }
            record.node.parameters.forEach((parameter, index) => {
              const supplied: ExpressionFact = argumentFacts[index] ?? undefinedFact();
              const possiblyUndefined = supplied.possiblyUndefined ?? supplied.knownUndefined;
              if (possiblyUndefined && parameter.initializer) {
                visit(parameter.initializer);
              }
              const fact =
                possiblyUndefined && parameter.initializer
                  ? supplied.knownUndefined
                    ? factFromExpression(parameter.initializer)
                    : mergeExpressionFacts(
                        [supplied, factFromExpression(parameter.initializer)],
                        supplied.expression,
                      )
                  : supplied;
              bindParameter(parameter, fact);
            });
            if (record.node.body) {
              visit(record.node.body);
            }
          } finally {
            wrapperExecutionScopeIndexes.pop();
          }
        }),
      );
    } finally {
      wrapperCallSites.pop();
      activeWrapperNodes.delete(record.node);
    }
  }

  function promoteVarBinding(name: string) {
    const targetIndex = lastScope(wrapperExecutionScopeIndexes);
    if (targetIndex === undefined || targetIndex === wrapperFunctionScopes.length - 1) {
      return;
    }
    for (const [scopes] of lexicalScopeStacks) {
      if (scopes === wrapperFunctionScopes) {
        continue;
      }
      const source = lastScope(scopes);
      const target = scopes[targetIndex];
      if (!(source instanceof Map) || !(target instanceof Map)) {
        continue;
      }
      for (const [key, value] of source) {
        if (key !== name && !key.startsWith(`${name}.`)) {
          continue;
        }
        if (scopes === fsWriteAliasScopes || scopes === fsSafeStoreFactoryAliasScopes) {
          target.set(key, target.get(key) ?? value);
        } else if (
          scopes === fsModuleBindingScopes ||
          scopes === fsSafeStoreScopes ||
          scopes === fsSafeJsonStoreScopes ||
          scopes === requireAliasScopes ||
          scopes === legacyPathScopes
        ) {
          target.set(key, target.get(key) === true || value === true);
        } else {
          target.set(key, value);
        }
      }
    }
    const wrapperSource = lastScope(wrapperFunctionScopes);
    const wrapperTarget = wrapperFunctionScopes[targetIndex]!;
    for (const [key, value] of wrapperSource) {
      if (key === name || key.startsWith(`${name}.`)) {
        wrapperTarget.set(key, mergeWrapperAssignmentValues(wrapperTarget.get(key), value));
      }
    }
  }

  function visitInConditionalExecution(node: ts.Node, branchEffects: BranchEffects | null = null) {
    withLexicalScope(true, () => {
      branchEffectScopes.push(branchEffects);
      try {
        visit(node);
      } finally {
        branchEffectScopes.pop();
      }
    });
  }

  function visit(node: ts.Node) {
    if (isTypeSyntaxNode(node)) {
      return;
    }
    if (node === sourceFile) {
      registerHoistedWrapperFunctions(sourceFile.statements);
    }

    if (ts.isIfStatement(node)) {
      visit(node.expression);
      const thenEffects = node.elseStatement ? createBranchEffects() : null;
      const elseEffects = node.elseStatement ? createBranchEffects() : null;
      visitInConditionalExecution(node.thenStatement, thenEffects);
      if (node.elseStatement && thenEffects && elseEffects) {
        visitInConditionalExecution(node.elseStatement, elseEffects);
        mergeExhaustiveBranchEffects(thenEffects, elseEffects);
      }
      return;
    }

    if (ts.isWhileStatement(node)) {
      visit(node.expression);
      visitInConditionalExecution(node.statement);
      return;
    }

    if (ts.isDoStatement(node)) {
      visitInConditionalExecution(node.statement);
      visit(node.expression);
      return;
    }

    if (ts.isForStatement(node)) {
      withLexicalScope(false, () => {
        if (node.initializer) {
          visit(node.initializer);
        }
        if (node.condition) {
          visit(node.condition);
        }
        if (node.incrementor) {
          visitInConditionalExecution(node.incrementor);
        }
        visitInConditionalExecution(node.statement);
      });
      return;
    }

    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      visit(node.expression);
      withLexicalScope(true, () => {
        visit(node.initializer);
        if (ts.isForOfStatement(node)) {
          markArrayBindingPatternFromForOf(node.initializer, node.expression);
        }
        visit(node.statement);
      });
      return;
    }

    if (isWrapperNode(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        registerWrapperFunction(node.name.text, node);
      }
      if (wrapperCallSites.length === 0) {
        visitFunctionLike(node);
      }
      return;
    }

    if (ts.isCallExpression(node)) {
      const callback = dynamicFsImportThenCallback(node);
      if (callback) {
        visitFunctionLike(callback, new Set([0]));
        for (const argument of node.arguments.slice(1)) {
          visit(argument);
        }
        return;
      }
    }

    if (
      ts.isBlock(node) ||
      ts.isModuleBlock(node) ||
      ts.isCaseBlock(node) ||
      ts.isCatchClause(node)
    ) {
      visitWithChildScope(node);
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const fact = node.initializer ? factFromExpression(node.initializer) : undefinedFact();
      if (node.initializer) {
        fact.legacyPath = expressionContainsLegacyStore(node.initializer);
      } else {
        fact.knownUndefined = !isAmbientVariableDeclaration(node);
      }
      bindIdentifierFact(node.name.text, fact, node.type);
    }
    if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name)) {
      const isFsAliasBinding =
        node.initializer &&
        ts.isObjectBindingPattern(node.name) &&
        isFsBindingExpression(node.initializer);
      collectFsModuleBindingsFromBinding(node);
      collectFsWriteAliasesFromBinding(node);
      markFsSafeStoreShadows(node.name);
      if (!isFsAliasBinding) {
        markFsWriteAliasShadows(node.name);
        markFsModuleBindingShadows(node.name);
        markFsModulePropertyShadows(node.name);
        markCreateRequireShadows(node.name);
      }
      for (const name of bindingPatternNames(node.name)) {
        lastScope(fsSafeStoreFactoryAliasScopes).set(name, null);
        lastScope(fsSafeStoreScopes).set(name, false);
        lastScope(fsSafeJsonStoreScopes).set(name, false);
        lastScope(requireAliasScopes).set(name, false);
        lastScope(legacyPathScopes).set(name, false);
        lastScope(legacyKnownObjectLiteralScopes).set(name, false);
        lastScope(knownUndefinedScopes).set(name, false);
        lastScope(literalTextScopes).set(name, null);
        lastScope(wrapperFunctionScopes).set(name, null);
      }
      if (ts.isObjectBindingPattern(node.name) && node.initializer) {
        bindObjectPatternFact(node.name, factFromExpression(node.initializer));
      }
      if (
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer)
      ) {
        markFsSafeFactoryAliasesFromObjectBinding(node.name, node.initializer.text);
      } else if (
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        (rootedPropertyAccessPath(node.initializer)?.properties.length ?? 0) > 0
      ) {
        const propertyAccess = rootedPropertyAccessPath(node.initializer)!;
        const sourceName = objectPropertyKey(
          propertyAccess.rootName,
          propertyAccess.properties.join("."),
        );
        markFsSafeFactoryAliasesFromObjectBinding(node.name, sourceName);
      }
    }
    if (ts.isVariableDeclaration(node) && isVarVariableDeclaration(node)) {
      for (const name of bindingPatternNames(node.name)) {
        promoteVarBinding(name);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const { index, pathScope, propertyScope, wrapperScope } = legacyIdentifierWriteScopes(
        node.left.text,
      );
      const nextPathValue = expressionContainsLegacyStore(node.right);
      const nextLiteralTexts = literalTextsFromExpression(node.right);
      const nextKnownUndefined = isKnownUndefinedExpression(node.right);
      const nextFsModuleValue = isFsBindingExpression(node.right);
      const nextFsWriteAlias = legacyFsWriteName(node.right);
      const nextFsSafeFactoryAlias = fsSafeStoreFactoryAliasName(node.right);
      const nextFsSafeStoreValue = isFsSafeStoreExpression(node.right);
      const nextFsSafeJsonStoreValue = expressionContainsFsSafeJsonStoreLegacyPath(node.right);
      const nextRequireAlias = isRequireAliasExpression(node.right);
      const conditionalWrite =
        lastScope(conditionalExecutionScopes) && !conditionalExecutionScopes[index];
      pathScope.set(
        node.left.text,
        conditionalWrite ? pathScope.get(node.left.text) === true || nextPathValue : nextPathValue,
      );
      const literalScope = scopeForWrite(literalTextScopes, node.left.text);
      literalScope.set(
        node.left.text,
        conditionalWrite
          ? mergeConditionalLiteralTexts(literalScope.get(node.left.text), nextLiteralTexts)
          : nextLiteralTexts,
      );
      scopeForWrite(staticExpressionScopes, node.left.text).set(
        node.left.text,
        conditionalWrite ? null : node.right,
      );
      const knownUndefinedScope = scopeForWrite(knownUndefinedScopes, node.left.text);
      knownUndefinedScope.set(
        node.left.text,
        conditionalWrite
          ? knownUndefinedScope.get(node.left.text) === true || nextKnownUndefined
          : nextKnownUndefined,
      );
      if (conditionalWrite) {
        const nextPropertyScope = legacyObjectPropertyRewriteValues(
          node.left.text,
          node.right,
          propertyScope,
        );
        recordBranchIdentifierAssignment(
          index,
          node.left.text,
          nextPathValue,
          node.right,
          nextLiteralTexts,
          nextPropertyScope,
        );
        for (const [key, value] of nextPropertyScope) {
          const mergedValue = mergeConditionalLegacyObjectPropertyValue(
            propertyScope.get(key),
            value,
          );
          if (mergedValue !== null) {
            propertyScope.set(key, mergedValue);
          }
        }
        legacyKnownObjectLiteralScopes[index]!.set(
          node.left.text,
          legacyKnownObjectLiteralScopes[index]!.get(node.left.text) === true &&
            isKnownLegacyObjectLiteralExpression(node.right),
        );
        lastScope(legacyPathScopes).set(node.left.text, nextPathValue);
        markKnownLegacyObjectLiteral(node.left.text, node.right);
        clearLegacyObjectProperties(lastScope(legacyObjectPropertyScopes), node.left.text);
        markLegacyObjectProperties(
          node.left.text,
          node.right,
          lastScope(legacyObjectPropertyScopes),
        );
      } else {
        scopeForWrite(fsModuleBindingScopes, node.left.text).set(node.left.text, nextFsModuleValue);
        scopeForWrite(fsWriteAliasScopes, node.left.text).set(node.left.text, nextFsWriteAlias);
        scopeForWrite(fsSafeStoreFactoryAliasScopes, node.left.text).set(
          node.left.text,
          nextFsSafeFactoryAlias,
        );
        scopeForWrite(fsSafeStoreScopes, node.left.text).set(node.left.text, nextFsSafeStoreValue);
        scopeForWrite(fsSafeJsonStoreScopes, node.left.text).set(
          node.left.text,
          nextFsSafeJsonStoreValue,
        );
        const requireAliasTarget = requireAliasWriteTarget(node.left.text);
        requireAliasTarget.scope.set(node.left.text, nextRequireAlias);
        markFsModulePropertyShadows(node.left);
        clearLegacyObjectProperties(propertyScope, node.left.text);
        markKnownLegacyObjectLiteral(
          node.left.text,
          node.right,
          legacyKnownObjectLiteralScopes[index]!,
        );
        markLegacyObjectProperties(
          node.left.text,
          node.right,
          propertyScope,
          legacyKnownObjectLiteralScopes[index]!,
        );
        clearFsWriteObjectAliases(fsWriteAliasScopes[index]!, node.left.text);
        registerFsWriteObjectAliases(node.left.text, node.right, fsWriteAliasScopes[index]!);
        clearFsSafeStoreObjectAliases(
          fsSafeStoreScopes[index]!,
          fsSafeJsonStoreScopes[index]!,
          node.left.text,
        );
        registerFsSafeStoreObjectAliases(
          node.left.text,
          node.right,
          fsSafeStoreScopes[index]!,
          fsSafeJsonStoreScopes[index]!,
        );
        registerFsModuleObjectProperties(
          node.left.text,
          node.right,
          fsModulePropertyScopes[index]!,
        );
        clearWrapperObjectMethods(wrapperScope, node.left.text);
        registerWrapperObjectMethods(node.left.text, node.right, wrapperScope);
      }
      if (conditionalWrite) {
        const fsModuleScope = fsModuleBindingScopes[index]!;
        const fsWriteScope = fsWriteAliasScopes[index]!;
        const fsSafeFactoryAliasScope = fsSafeStoreFactoryAliasScopes[index]!;
        const fsSafeStoreScope = fsSafeStoreScopes[index]!;
        const fsSafeJsonStoreScope = fsSafeJsonStoreScopes[index]!;
        fsModuleScope.set(
          node.left.text,
          fsModuleScope.get(node.left.text) === true || nextFsModuleValue,
        );
        fsWriteScope.set(node.left.text, fsWriteScope.get(node.left.text) ?? nextFsWriteAlias);
        fsSafeFactoryAliasScope.set(
          node.left.text,
          fsSafeFactoryAliasScope.get(node.left.text) ?? nextFsSafeFactoryAlias,
        );
        fsSafeStoreScope.set(
          node.left.text,
          fsSafeStoreScope.get(node.left.text) === true || nextFsSafeStoreValue,
        );
        fsSafeJsonStoreScope.set(
          node.left.text,
          fsSafeJsonStoreScope.get(node.left.text) === true || nextFsSafeJsonStoreValue,
        );
        requireAliasScopes[index]!.set(
          node.left.text,
          requireAliasScopes[index]!.get(node.left.text) === true || nextRequireAlias,
        );
        lastScope(fsModuleBindingScopes).set(node.left.text, nextFsModuleValue);
        lastScope(fsWriteAliasScopes).set(node.left.text, nextFsWriteAlias);
        lastScope(fsSafeStoreFactoryAliasScopes).set(node.left.text, nextFsSafeFactoryAlias);
        lastScope(fsSafeStoreScopes).set(node.left.text, nextFsSafeStoreValue);
        lastScope(fsSafeJsonStoreScopes).set(node.left.text, nextFsSafeJsonStoreValue);
        lastScope(requireAliasScopes).set(node.left.text, nextRequireAlias);
        recordBranchFsIdentifierAssignment(
          index,
          node.left.text,
          nextFsModuleValue,
          nextFsWriteAlias,
          nextFsSafeFactoryAlias,
          nextFsSafeStoreValue,
          nextFsSafeJsonStoreValue,
          nextRequireAlias,
        );
        registerFsWriteObjectAliases(node.left.text, node.right, fsWriteAliasScopes[index]!, true);
        registerFsSafeStoreObjectAliases(
          node.left.text,
          node.right,
          fsSafeStoreScopes[index]!,
          fsSafeJsonStoreScopes[index]!,
          true,
        );
        registerFsModuleObjectProperties(
          node.left.text,
          node.right,
          fsModulePropertyScopes[index]!,
          true,
        );
        shadowVisibleFsWriteObjectAliases(node.left.text);
        registerFsWriteObjectAliases(node.left.text, node.right);
        registerFsSafeStoreObjectAliases(node.left.text, node.right);
        registerFsModuleObjectProperties(node.left.text, node.right);
        registerWrapperObjectMethods(node.left.text, node.right, wrapperScope, true);
        recordBranchWrapperObjectRewrite(index, node.left.text, node.right);
        shadowVisibleWrapperObjectMethods(node.left.text);
        registerWrapperObjectMethods(node.left.text, node.right);
      }
      const assignedWrapper =
        ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right)
          ? wrapperRecordForNode(node.right)
          : cloneWrapperFunctionValue(resolveWrapperExpression(node.right));
      if (conditionalWrite) {
        recordBranchWrapperAssignment(index, node.left.text, assignedWrapper);
      }
      setWrapperFunctionValue(wrapperScope, node.left.text, assignedWrapper, conditionalWrite);
      const wrapperObjectSource = callExpressionName(node.right);
      if (wrapperObjectSource) {
        copyWrapperObjectMethods(
          node.left.text,
          wrapperObjectSource,
          wrapperScope,
          conditionalWrite,
        );
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (rootedPropertyAccessPath(node.left)?.properties.length ?? 0) > 0
    ) {
      const propertyAccess = rootedPropertyAccessPath(node.left)!;
      const propertyName = propertyAccess.properties.join(".");
      const target = legacyObjectPropertyWriteTarget(propertyAccess.rootName, propertyName);
      const key = objectPropertyKey(propertyAccess.rootName, propertyName);
      const nextValue = legacyObjectPropertyValueFromExpression(node.right);
      const nextKnownObjectLiteral = isKnownLegacyObjectLiteralExpression(node.right);
      const rewriteValues = legacyObjectPropertyRewriteValues(key, node.right, target.scope);
      const conditionalPropertyWrite =
        lastScope(conditionalExecutionScopes) && !conditionalExecutionScopes[target.index];
      if (conditionalPropertyWrite) {
        const previousKnownObjectLiteral = lookupKnownLegacyObjectLiteral(key);
        clearKnownLegacyObjectLiterals(legacyKnownObjectLiteralScopes[target.index]!, key);
        legacyKnownObjectLiteralScopes[target.index]!.set(
          key,
          previousKnownObjectLiteral && nextKnownObjectLiteral,
        );
        const previousValue = target.scope.has(key)
          ? target.scope.get(key)
          : lookupKnownLegacyObjectLiteral(propertyAccess.rootName)
            ? explicitUndefinedLegacyObjectPropertyValue
            : undefined;
        const mergedValue = mergeConditionalLegacyObjectPropertyValue(previousValue, nextValue);
        if (mergedValue !== null) {
          target.scope.set(key, mergedValue);
        }
      } else {
        target.scope.set(key, nextValue);
        clearKnownLegacyObjectLiterals(legacyKnownObjectLiteralScopes[target.index]!, key);
        legacyKnownObjectLiteralScopes[target.index]!.set(key, nextKnownObjectLiteral);
      }
      if (!conditionalPropertyWrite) {
        clearLegacyObjectProperties(target.scope, key);
        for (const [propertyKey, value] of rewriteValues) {
          target.scope.set(propertyKey, value);
        }
      }
      if (conditionalPropertyWrite) {
        for (const [propertyKey, value] of rewriteValues) {
          const mergedValue = mergeConditionalLegacyObjectPropertyValue(
            target.scope.get(propertyKey),
            value,
          );
          if (mergedValue !== null) {
            target.scope.set(propertyKey, mergedValue);
            recordBranchPropertyAssignment(
              target.index,
              propertyAccess.rootName,
              propertyKey.slice(`${propertyAccess.rootName}.`.length),
              value,
            );
          }
        }
        lastScope(legacyObjectPropertyScopes).set(key, nextValue);
        clearKnownLegacyObjectLiterals(lastScope(legacyKnownObjectLiteralScopes), key);
        lastScope(legacyKnownObjectLiteralScopes).set(key, nextKnownObjectLiteral);
        clearLegacyObjectProperties(lastScope(legacyObjectPropertyScopes), key);
        for (const [propertyKey, value] of rewriteValues) {
          lastScope(legacyObjectPropertyScopes).set(propertyKey, value);
        }
        recordBranchPropertyAssignment(
          target.index,
          propertyAccess.rootName,
          propertyName,
          nextValue,
          nextKnownObjectLiteral,
        );
      }
      const wrapperTarget = legacyIdentifierWriteScopes(propertyAccess.rootName);
      const conditionalWrapperWrite =
        lastScope(conditionalExecutionScopes) && !conditionalExecutionScopes[wrapperTarget.index];
      setFsWriteObjectAlias(
        fsWriteAliasScopes[wrapperTarget.index]!,
        key,
        legacyFsWriteName(node.right),
        conditionalWrapperWrite,
      );
      setFsModuleObjectProperty(
        fsModulePropertyScopes[wrapperTarget.index]!,
        key,
        isFsModuleExpression(node.right),
        conditionalWrapperWrite,
      );
      if (!conditionalWrapperWrite) {
        clearFsSafeStoreObjectAliases(
          fsSafeStoreScopes[wrapperTarget.index]!,
          fsSafeJsonStoreScopes[wrapperTarget.index]!,
          key,
        );
      }
      setFsSafeStoreObjectAlias(
        fsSafeStoreScopes[wrapperTarget.index]!,
        fsSafeJsonStoreScopes[wrapperTarget.index]!,
        key,
        isFsSafeStoreExpression(node.right),
        expressionContainsFsSafeJsonStoreLegacyPath(node.right),
        conditionalWrapperWrite,
      );
      if (!conditionalWrapperWrite) {
        registerFsSafeStoreObjectAliases(
          key,
          node.right,
          fsSafeStoreScopes[wrapperTarget.index]!,
          fsSafeJsonStoreScopes[wrapperTarget.index]!,
        );
      }
      if (conditionalWrapperWrite) {
        lastScope(fsWriteAliasScopes).set(key, legacyFsWriteName(node.right));
        lastScope(fsModulePropertyScopes).set(key, isFsModuleExpression(node.right));
        shadowVisibleFsSafeStoreObjectAliases(key);
        lastScope(fsSafeStoreScopes).set(key, isFsSafeStoreExpression(node.right));
        lastScope(fsSafeJsonStoreScopes).set(
          key,
          expressionContainsFsSafeJsonStoreLegacyPath(node.right),
        );
        registerFsSafeStoreObjectAliases(key, node.right);
        recordBranchFsSafeObjectPropertyAssignment(
          wrapperTarget.index,
          propertyAccess.rootName,
          propertyName,
          node.right,
          isFsSafeStoreExpression(node.right),
          expressionContainsFsSafeJsonStoreLegacyPath(node.right),
        );
      }
      const assignedWrapper =
        ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right)
          ? wrapperRecordForNode(node.right)
          : cloneWrapperFunctionValue(resolveWrapperExpression(node.right));
      if (conditionalWrapperWrite) {
        lastScope(wrapperFunctionScopes).set(key, assignedWrapper);
        recordBranchWrapperAssignment(wrapperTarget.index, key, assignedWrapper);
        recordBranchWrapperObjectRewrite(wrapperTarget.index, key, node.right);
      } else {
        clearWrapperObjectMethods(wrapperTarget.wrapperScope, key);
      }
      setWrapperFunctionValue(
        wrapperTarget.wrapperScope,
        key,
        assignedWrapper,
        conditionalWrapperWrite,
      );
      registerWrapperObjectMethods(
        key,
        node.right,
        wrapperTarget.wrapperScope,
        conditionalWrapperWrite,
      );
    }

    if (ts.isCallExpression(node)) {
      const fsWriteName = legacyFsWriteName(node.expression);
      const filePathOptionsWrite =
        fsWriteName === "appendRegularFile" ||
        fsWriteName === "appendRegularFileSync" ||
        fsWriteName === "replaceFileAtomic" ||
        fsWriteName === "replaceFileAtomicSync";
      if (
        fsWriteName &&
        fsWriteCallMayWrite(fsWriteName, [...node.arguments]) &&
        (filePathOptionsWrite
          ? node.arguments[0] && objectFilePathContainsLegacyStore(node.arguments[0])
          : pathArgumentsForFsWrite(fsWriteName, [...node.arguments]).some((argument) =>
              pathArgumentContainsLegacyStore(argument),
            ))
      ) {
        addViolation(node.expression, "legacy store filesystem write");
      }
      if (
        fsSafeStoreWritePathArguments(node).some((argument) =>
          pathArgumentContainsLegacyStore(argument),
        )
      ) {
        addViolation(node.expression, "legacy store filesystem write");
      }
      if (fsSafeJsonStoreWriteContainsLegacyStore(node)) {
        addViolation(node.expression, "legacy store filesystem write");
      }
      const wrapperName = callExpressionName(node.expression);
      const wrapperRecord = wrapperName ? resolveWrapperFunction(wrapperName) : null;
      if (!intrinsicWrapperCalls.has(node) || wrapperCallSites.length === 0) {
        const violationCount = violations.length;
        for (const record of wrapperRecords(wrapperRecord)) {
          executeWrapper(record, node);
        }
        if (definitionScanDepth > 0 && violations.length > violationCount) {
          intrinsicWrapperCalls.add(node);
        }
      }
    }

    if (
      (ts.isStringLiteralLike(node) || ts.isIdentifier(node) || ts.isTemplateExpression(node)) &&
      bridgeMarkerPattern.test(node.getText(sourceFile))
    ) {
      addViolation(node, "legacy transcript bridge marker");
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

/**
 * Runs the database-first legacy-store guard.
 */
export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const sourceRoots = databaseFirstLegacyStoreSourceRoots.map((root) => path.join(repoRoot, root));
  const files = await collectDatabaseFirstLegacyStoreSourceFiles(sourceRoots);
  const nativeSourceRoots = databaseFirstNativeSourceRoots.map((root) => path.join(repoRoot, root));
  const nativeFiles = (await Promise.all(nativeSourceRoots.map(collectNativeSourceFiles))).flat();
  const violations = [];
  for (const filePath of files) {
    const relativePath = path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
    const content = await fs.readFile(filePath, "utf8");
    for (const violation of collectDatabaseFirstLegacyStoreViolations(content, relativePath)) {
      violations.push(`${relativePath}:${violation.line} ${violation.kind}`);
    }
  }
  for (const filePath of nativeFiles) {
    const relativePath = path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
    const content = await fs.readFile(filePath, "utf8");
    for (const violation of collectDatabaseFirstNativeLegacyStoreViolations(
      content,
      relativePath,
    )) {
      violations.push(`${relativePath}:${violation.line} ${violation.kind}`);
    }
  }

  if (violations.length === 0) {
    console.log("Database-first legacy-store guard passed.");
    return;
  }

  console.error("Found database-first legacy-store guard violations:");
  for (const violation of violations.toSorted()) {
    console.error(`- ${violation}`);
  }
  console.error(
    "Runtime state/cache writes must use the shared or per-agent SQLite stores. Keep legacy file import/removal under doctor or migration owners.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
