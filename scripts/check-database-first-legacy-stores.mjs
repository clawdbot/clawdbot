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
} from "./lib/legacy-store-path-domain.mjs";
import { resolveRepoRoot, runAsScript, toLine, unwrapExpression } from "./lib/ts-guard-utils.mjs";

const databaseFirstLegacyStoreSourceRoots = ["src", "extensions", "packages"];

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
  /(?:^|\/)(?:fs-safe|json-files|json-store|private-file-store|replace-file)(?:\.[cm]?[jt]s)?$/u;
const fsSafePackageModulePattern = /^@openclaw\/fs-safe(?:\/(?:root|store))?$/u;

const bridgeMarkerPattern = /\btranscriptLocator\b|sqlite-transcript:\/\//u;

const legacyStorePatterns = [
  /\bsessions\.json\b/u,
  /\.trajectory\.jsonl\b/u,
  /\.acp-stream\.jsonl\b/u,
  /\bacp\/event-ledger\.json\b/u,
  /\bcache\/[^"'`]*\.json\b/u,
  /\bagents\/[^"'`]+\/agent\/(?:auth|models)\.json\b/u,
  /\b(?:credentials\/oauth|github-copilot\.token|openrouter-models|auth-profiles|auth-state|exec-approvals|workspace-state)\.json\b/u,
  /\bcron\/(?:runs\/[^"'`]+\.jsonl|jobs\.json|jobs-state\.json)\b/u,
  /\b(?:process-leases|session-toggles|known-users|msteams-conversations|msteams-polls|msteams-sso-tokens|bot-storage|sync-store|thread-bindings|inbound-dedupe|startup-verification|storage-meta|crypto-idb-snapshot|command-deploy-cache|plugin-binding-approvals|plugins\/installs|config-health|port-guard|restart-sentinel|gateway-restart-intent|gateway-supervisor-restart-handoff)\.json\b/u,
  /\b(?:calls|ref-index|audit\/file-transfer|audit\/crestodian)\.jsonl\b/u,
  /\b(?:reply-cache|sent-echoes|events|claims)\.jsonl\b/u,
  /\bplugin-state\/state\.sqlite\b/u,
  /\btasks\/(?:runs\.sqlite|flows\/registry\.sqlite)\b/u,
  /\bopenclaw-state\.sqlite\b/u,
];

const allowedRuntimeMigrationPaths = [
  "src/commands/doctor/",
  "src/infra/session-state-migration.ts",
  "src/infra/state-migrations.ts",
  "src/commands/session-state-migration.ts",
  "src/commands/doctor-state-migrations.test.ts",
];

const allowedFixturePaths = new Set([
  "extensions/qa-lab/src/providers/shared/auth-store.ts",
  "extensions/qa-matrix/src/runners/contract/scenario-runtime-e2ee-destructive.ts",
]);

const allowedCurrentLegacyWriteViolations = [
  "extensions/memory-wiki/src/compile.ts:legacy store filesystem write:root.write(relativePath, content)",
];

const sourceFileExtensions = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".tsx"]);

const sourceTestSuffixes = [
  ".e2e-harness.js",
  ".e2e-harness.mjs",
  ".e2e-harness.ts",
  ".test-fixtures.js",
  ".test-fixtures.mjs",
  ".test-fixtures.ts",
  ".test-helper.js",
  ".test-helper.mjs",
  ".test-helper.ts",
  ".test-helpers.js",
  ".test-helpers.mjs",
  ".test-helpers.ts",
  ".test-harness.js",
  ".test-harness.mjs",
  ".test-harness.ts",
  ".test-mocks.js",
  ".test-mocks.mjs",
  ".test-mocks.ts",
  ".test-support.js",
  ".test-support.mjs",
  ".test-support.ts",
  ".test-utils.js",
  ".test-utils.mjs",
  ".test-utils.ts",
  ".test.js",
  ".test.mjs",
  ".test.ts",
  "test-fixtures.js",
  "test-fixtures.mjs",
  "test-fixtures.ts",
  "test-helper.js",
  "test-helper.mjs",
  "test-helper.ts",
  "test-helpers.js",
  "test-helpers.mjs",
  "test-helpers.ts",
  "test-harness.js",
  "test-harness.mjs",
  "test-harness.ts",
  "test-mocks.js",
  "test-mocks.mjs",
  "test-mocks.ts",
  "test-support.js",
  "test-support.mjs",
  "test-support.ts",
  "test-utils.js",
  "test-utils.mjs",
  "test-utils.ts",
];

function isAllowedLegacyOwnerPath(relativePath) {
  return (
    allowedFixturePaths.has(relativePath) ||
    allowedRuntimeMigrationPaths.some((allowed) => relativePath.startsWith(allowed)) ||
    /^extensions\/[^/]+\/(?:doctor-contract-api|legacy-state-migrations-api)\.ts$/u.test(
      relativePath,
    )
  );
}

function normalizedSourceText(sourceFile, node) {
  return node.getText(sourceFile).replace(/\s+/gu, " ");
}

function currentLegacyWriteViolationAllowances(relativePath = null) {
  const allowances = new Map();
  const relativePrefix = typeof relativePath === "string" ? relativePath.concat(":") : null;
  for (const fingerprint of allowedCurrentLegacyWriteViolations) {
    if (relativePrefix !== null && !fingerprint.startsWith(relativePrefix)) {
      continue;
    }
    allowances.set(fingerprint, (allowances.get(fingerprint) ?? 0) + 1);
  }
  return allowances;
}

function currentLegacyWriteViolationPath(fingerprint) {
  const marker = ":legacy store filesystem write:";
  const markerIndex = fingerprint.indexOf(marker);
  return markerIndex === -1 ? null : fingerprint.slice(0, markerIndex);
}

function consumeAllowedCurrentLegacyViolation(
  allowances,
  relativePath,
  sourceFile,
  fingerprintNode,
  kind,
) {
  const fingerprint = `${relativePath}:${kind}:${normalizedSourceText(sourceFile, fingerprintNode)}`;
  const remaining = allowances.get(fingerprint) ?? 0;
  if (remaining === 0) {
    return false;
  }
  if (remaining === 1) {
    allowances.delete(fingerprint);
  } else {
    allowances.set(fingerprint, remaining - 1);
  }
  return true;
}

function isSourceFile(filePath) {
  return sourceFileExtensions.has(path.extname(filePath));
}

function isGeneratedAssetSourceFile(filePath) {
  const normalized = filePath.replaceAll(path.sep, "/");
  return (
    /(?:^|\/)extensions\/[^/]+\/(?:assets|dist)\/.+\.[cm]?js$/u.test(normalized) ||
    /(?:^|\/)packages\/[^/]+\/dist\/.+\.[cm]?js$/u.test(normalized)
  );
}

function isGeneratedAssetSourcePath(filePath) {
  return (
    /(?:^|\/)extensions\/[^/]+\/(?:assets|dist)(?:\/|$)/u.test(
      filePath.replaceAll(path.sep, "/"),
    ) || /(?:^|\/)packages\/[^/]+\/dist(?:\/|$)/u.test(filePath.replaceAll(path.sep, "/"))
  );
}

function isTestLikeSourceFile(filePath) {
  return sourceTestSuffixes.some((suffix) => filePath.endsWith(suffix));
}

async function collectSourceFiles(targetPath) {
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
    return isSourceFile(targetPath) &&
      !isTestLikeSourceFile(targetPath) &&
      !isGeneratedAssetSourceFile(targetPath)
      ? [targetPath]
      : [];
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") {
      continue;
    }
    const entryPath = path.join(targetPath, entry.name);
    if (isGeneratedAssetSourcePath(entryPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(entryPath)));
      continue;
    }
    if (
      entry.isFile() &&
      isSourceFile(entryPath) &&
      !isTestLikeSourceFile(entryPath) &&
      !isGeneratedAssetSourceFile(entryPath)
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

export async function collectDatabaseFirstLegacyStoreSourceFiles(sourceRoots) {
  return (await Promise.all(sourceRoots.map((root) => collectSourceFiles(root)))).flat();
}

function importSource(node) {
  const moduleSpecifier = node.moduleSpecifier;
  return ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : "";
}

function isHelperWriteModuleSource(source) {
  return (
    source === "openclaw/plugin-sdk/file-access-runtime" ||
    source === "openclaw/plugin-sdk/security-runtime" ||
    fsSafePackageModulePattern.test(source) ||
    helperWriteModulePattern.test(source)
  );
}

function collectCreateRequireBindings(sourceFile) {
  const bindings = new Set();
  function visit(node) {
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

function isFsRequireExpression(expression, isRequireName = (name) => name === "require") {
  const call = unwrapExpression(expression);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(unwrapExpression(call.expression))) {
    return false;
  }
  const requireName = unwrapExpression(call.expression).text;
  const [specifier] = call.arguments;
  return (
    isRequireName(requireName) &&
    specifier &&
    ts.isStringLiteralLike(specifier) &&
    fsModuleSpecifiers.has(specifier.text)
  );
}

function unwrapAwaitExpression(expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isAwaitExpression(unwrapped) ? unwrapExpression(unwrapped.expression) : unwrapped;
}

function isFsDynamicImportExpression(expression) {
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

function collectFsBindings(sourceFile) {
  const fsModuleBindings = new Set();
  const fsWriteAliases = new Map();
  const fsSafeStoreFactoryAliases = new Map();

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

function templateCandidateText(current) {
  let text = current.head.text;
  for (const span of current.templateSpans) {
    text += `*${span.literal.text}`;
  }
  return text || "*";
}

function legacyCandidateTexts(sourceFile, node) {
  const candidates = node.pos >= 0 && node.end >= 0 ? [node.getText(sourceFile)] : [];
  const stringSegments = [];

  function binaryExpressionCandidateText(current) {
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

  function pathSegmentCandidateText(current) {
    const unwrapped = unwrapExpression(current);
    if (ts.isStringLiteralLike(unwrapped)) {
      return unwrapped.text;
    }
    if (ts.isTemplateExpression(unwrapped)) {
      return templateCandidateText(unwrapped);
    }
    if (ts.isBinaryExpression(unwrapped)) {
      return binaryExpressionCandidateText(unwrapped);
    }
    return "*";
  }

  if (candidates.length === 0) {
    const syntheticPathSegment = pathSegmentCandidateText(node);
    if (syntheticPathSegment !== "*") {
      candidates.push(syntheticPathSegment);
    }
  }

  function maybeAddCallPathCandidate(current) {
    if (!ts.isCallExpression(current) || current.arguments.length < 2) {
      return;
    }
    const segments = current.arguments.map((argument) => pathSegmentCandidateText(argument));
    if (!segments.some((segment) => segment !== "*")) {
      return;
    }
    candidates.push(segments.join("/"));
  }

  function visit(current) {
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
  content,
  relativePath = "source.ts",
  scanOptions = {},
) {
  if (isAllowedLegacyOwnerPath(relativePath)) {
    return [];
  }

  const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true);
  const currentLegacyWriteAllowances =
    scanOptions.currentLegacyWriteAllowances ?? currentLegacyWriteViolationAllowances(relativePath);
  const createRequireBindings = collectCreateRequireBindings(sourceFile);
  const { fsModuleBindings, fsWriteAliases, fsSafeStoreFactoryAliases } =
    collectFsBindings(sourceFile);
  const violations = [];
  const seenViolations = new Set();
  const fsModuleBindingScopes = [new Map([...fsModuleBindings].map((name) => [name, true]))];
  const fsModulePropertyScopes = [new Map()];
  const fsWriteAliasScopes = [fsWriteAliases];
  const fsSafeStoreFactoryAliasScopes = [fsSafeStoreFactoryAliases];
  const fsSafeStoreScopes = [new Map()];
  const fsSafeJsonStoreScopes = [new Map()];
  const requireAliasScopes = [new Map([["require", true]])];
  const requireShadowScopes = [new Set()];
  const createRequireShadowScopes = [new Set()];
  const legacyPathScopes = [new Map()];
  const literalTextScopes = [new Map()];
  const knownUndefinedScopes = [new Map()];
  const legacyKnownObjectLiteralScopes = [new Map()];
  const legacyObjectPropertyScopes = [new Map()];
  const wrapperFunctionScopes = [new Map()];
  const conditionalExecutionScopes = [false];
  const branchEffectScopes = [];

  function addViolation(node, kind, fingerprintNode = node) {
    const line = toLine(sourceFile, node);
    if (
      consumeAllowedCurrentLegacyViolation(
        currentLegacyWriteAllowances,
        relativePath,
        sourceFile,
        fingerprintNode,
        kind,
      )
    ) {
      return;
    }
    const key = `${line}:${kind}`;
    if (seenViolations.has(key)) {
      return;
    }
    seenViolations.add(key);
    violations.push({ kind, line });
  }

  function currentLegacyPathScope() {
    return legacyPathScopes[legacyPathScopes.length - 1];
  }

  function currentLiteralTextScope() {
    return literalTextScopes[literalTextScopes.length - 1];
  }

  function currentKnownUndefinedScope() {
    return knownUndefinedScopes[knownUndefinedScopes.length - 1];
  }

  function currentFsWriteAliasScope() {
    return fsWriteAliasScopes[fsWriteAliasScopes.length - 1];
  }

  function currentFsModuleBindingScope() {
    return fsModuleBindingScopes[fsModuleBindingScopes.length - 1];
  }

  function currentFsModulePropertyScope() {
    return fsModulePropertyScopes[fsModulePropertyScopes.length - 1];
  }

  function currentRequireShadowScope() {
    return requireShadowScopes[requireShadowScopes.length - 1];
  }

  function currentRequireAliasScope() {
    return requireAliasScopes[requireAliasScopes.length - 1];
  }

  function resolveRequireAlias(name) {
    for (let index = requireAliasScopes.length - 1; index >= 0; index--) {
      const scope = requireAliasScopes[index];
      if (scope.has(name)) {
        return scope.get(name) === true;
      }
    }
    return false;
  }

  function isNodeRequireName(name) {
    return resolveRequireAlias(name);
  }

  function isCreateRequireShadowed(name) {
    return createRequireShadowScopes.some((scope) => scope.has(name));
  }

  function isCreateRequireExpression(expression) {
    const call = unwrapExpression(expression);
    return (
      ts.isCallExpression(call) &&
      ts.isIdentifier(unwrapExpression(call.expression)) &&
      createRequireBindings.has(unwrapExpression(call.expression).text) &&
      !isCreateRequireShadowed(unwrapExpression(call.expression).text)
    );
  }

  function isRequireAliasExpression(expression) {
    const value = unwrapExpression(expression);
    return (
      isCreateRequireExpression(value) ||
      (ts.isIdentifier(value) && resolveRequireAlias(value.text))
    );
  }

  function resolveFsModuleBinding(name) {
    for (let index = fsModuleBindingScopes.length - 1; index >= 0; index--) {
      const scope = fsModuleBindingScopes[index];
      if (scope.has(name)) {
        return scope.get(name) === true;
      }
    }
    return false;
  }

  function resolveFsModuleProperty(pathParts) {
    const fullPath = pathParts.join(".");
    const prefixes = pathParts.map((_, index) => pathParts.slice(0, index + 1).join("."));
    for (let index = fsModulePropertyScopes.length - 1; index >= 0; index--) {
      const scope = fsModulePropertyScopes[index];
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

  function visibleFsModuleBindings() {
    const bindings = new Map();
    for (const scope of fsModuleBindingScopes) {
      for (const [name, value] of scope) {
        bindings.set(name, value);
      }
    }
    return bindings;
  }

  function visibleFsModuleProperties() {
    const properties = new Map();
    for (const scope of fsModulePropertyScopes) {
      for (const [name, value] of scope) {
        properties.set(name, value);
      }
    }
    return properties;
  }

  function resolveFsWriteAlias(name) {
    for (let index = fsWriteAliasScopes.length - 1; index >= 0; index--) {
      const scope = fsWriteAliasScopes[index];
      if (scope.has(name)) {
        return scope.get(name) ?? null;
      }
    }
    return null;
  }

  function resolveFsSafeStoreFactoryAlias(name) {
    for (let index = fsSafeStoreFactoryAliasScopes.length - 1; index >= 0; index--) {
      const scope = fsSafeStoreFactoryAliasScopes[index];
      if (scope.has(name)) {
        return scope.get(name) ?? null;
      }
    }
    return null;
  }

  function resolveFsSafeStore(name) {
    const value = lookupFsSafeStore(name);
    return value === true;
  }

  function lookupFsSafeStore(name) {
    for (let index = fsSafeStoreScopes.length - 1; index >= 0; index--) {
      const scope = fsSafeStoreScopes[index];
      if (scope.has(name)) {
        return scope.get(name) === true;
      }
    }
    return null;
  }

  function resolveFsSafeJsonStore(name) {
    const value = lookupFsSafeJsonStore(name);
    return value === true;
  }

  function lookupFsSafeJsonStore(name) {
    for (let index = fsSafeJsonStoreScopes.length - 1; index >= 0; index--) {
      const scope = fsSafeJsonStoreScopes[index];
      if (scope.has(name)) {
        return scope.get(name) === true;
      }
    }
    return null;
  }

  function visibleFsWriteAliases() {
    const aliases = new Map();
    for (const scope of fsWriteAliasScopes) {
      for (const [name, value] of scope) {
        aliases.set(name, value);
      }
    }
    return aliases;
  }

  function visibleRequireAliasSnapshot(maxScopeIndex = requireAliasScopes.length - 1) {
    const aliases = new Map();
    const sourceScopes = new Map();
    for (let index = 0; index <= maxScopeIndex; index++) {
      const scope = requireAliasScopes[index];
      if (!scope) {
        continue;
      }
      for (const [name, value] of scope) {
        aliases.set(name, value);
        sourceScopes.set(name, index);
      }
    }
    return { aliases, sourceScopes };
  }

  function visibleCreateRequireShadows() {
    const shadows = new Set();
    for (const scope of createRequireShadowScopes) {
      for (const name of scope) {
        shadows.add(name);
      }
    }
    return shadows;
  }

  function fsModuleBindingWriteScope(name) {
    for (let index = fsModuleBindingScopes.length - 1; index >= 0; index--) {
      const scope = fsModuleBindingScopes[index];
      if (scope.has(name)) {
        return scope;
      }
    }
    return currentFsModuleBindingScope();
  }

  function fsWriteAliasWriteScope(name) {
    for (let index = fsWriteAliasScopes.length - 1; index >= 0; index--) {
      const scope = fsWriteAliasScopes[index];
      if (scope.has(name)) {
        return scope;
      }
    }
    return currentFsWriteAliasScope();
  }

  function fsSafeStoreWriteScope(name) {
    for (let index = fsSafeStoreScopes.length - 1; index >= 0; index--) {
      const scope = fsSafeStoreScopes[index];
      if (scope.has(name)) {
        return scope;
      }
    }
    return currentFsSafeStoreScope();
  }

  function fsSafeStoreFactoryAliasWriteScope(name) {
    for (let index = fsSafeStoreFactoryAliasScopes.length - 1; index >= 0; index--) {
      const scope = fsSafeStoreFactoryAliasScopes[index];
      if (scope.has(name)) {
        return scope;
      }
    }
    return currentFsSafeStoreFactoryAliasScope();
  }

  function fsSafeJsonStoreWriteScope(name) {
    for (let index = fsSafeJsonStoreScopes.length - 1; index >= 0; index--) {
      const scope = fsSafeJsonStoreScopes[index];
      if (scope.has(name)) {
        return scope;
      }
    }
    return currentFsSafeJsonStoreScope();
  }

  function currentLegacyObjectPropertyScope() {
    return legacyObjectPropertyScopes[legacyObjectPropertyScopes.length - 1];
  }

  function currentLegacyKnownObjectLiteralScope() {
    return legacyKnownObjectLiteralScopes[legacyKnownObjectLiteralScopes.length - 1];
  }

  function lookupKnownLegacyObjectLiteral(name) {
    for (let index = legacyKnownObjectLiteralScopes.length - 1; index >= 0; index--) {
      const scope = legacyKnownObjectLiteralScopes[index];
      if (scope.has(name)) {
        return scope.get(name) === true;
      }
      if (legacyPathScopes[index].has(name)) {
        return false;
      }
    }
    return false;
  }

  function isKnownLegacyObjectLiteralExpression(expression) {
    const unwrapped = unwrapExpression(expression);
    return (
      ts.isObjectLiteralExpression(unwrapped) ||
      (ts.isIdentifier(unwrapped) && lookupKnownLegacyObjectLiteral(unwrapped.text))
    );
  }

  function markKnownLegacyObjectLiteral(
    name,
    initializer,
    targetScope = currentLegacyKnownObjectLiteralScope(),
  ) {
    targetScope.set(name, isKnownLegacyObjectLiteralExpression(initializer));
  }

  function currentFsSafeStoreFactoryAliasScope() {
    return fsSafeStoreFactoryAliasScopes[fsSafeStoreFactoryAliasScopes.length - 1];
  }

  function currentFsSafeStoreScope() {
    return fsSafeStoreScopes[fsSafeStoreScopes.length - 1];
  }

  function currentFsSafeJsonStoreScope() {
    return fsSafeJsonStoreScopes[fsSafeJsonStoreScopes.length - 1];
  }

  function currentWrapperFunctionScope() {
    return wrapperFunctionScopes[wrapperFunctionScopes.length - 1];
  }

  function currentConditionalExecutionScope() {
    return conditionalExecutionScopes[conditionalExecutionScopes.length - 1];
  }

  function currentBranchEffectScope() {
    return branchEffectScopes[branchEffectScopes.length - 1] ?? null;
  }

  function createBranchEffects() {
    return {
      fsIdentifierAssignments: new Map(),
      fsSafePropertyAssignments: new Map(),
      identifierAssignments: new Map(),
      propertyAssignments: new Map(),
      wrapperAssignments: new Map(),
    };
  }

  function objectPropertyKey(objectName, propertyName) {
    return `${objectName}.${propertyName}`;
  }

  function resolveLegacyPathIdentifier(name) {
    for (let index = legacyPathScopes.length - 1; index >= 0; index--) {
      const scope = legacyPathScopes[index];
      if (scope.has(name)) {
        return scope.get(name) === true;
      }
    }
    return false;
  }

  function resolveLiteralTextIdentifier(name) {
    for (let index = literalTextScopes.length - 1; index >= 0; index--) {
      const scope = literalTextScopes[index];
      if (scope.has(name)) {
        return scope.get(name) ?? [];
      }
    }
    return [];
  }

  function literalTextWriteScope(name) {
    for (let index = literalTextScopes.length - 1; index >= 0; index--) {
      const scope = literalTextScopes[index];
      if (scope.has(name)) {
        return scope;
      }
    }
    return currentLiteralTextScope();
  }

  function resolveKnownUndefinedIdentifier(name) {
    for (let index = knownUndefinedScopes.length - 1; index >= 0; index--) {
      const scope = knownUndefinedScopes[index];
      if (scope.has(name)) {
        return scope.get(name) === true;
      }
    }
    return false;
  }

  function knownUndefinedWriteScope(name) {
    for (let index = knownUndefinedScopes.length - 1; index >= 0; index--) {
      const scope = knownUndefinedScopes[index];
      if (scope.has(name)) {
        return scope;
      }
    }
    return currentKnownUndefinedScope();
  }

  function requireAliasWriteTarget(name) {
    for (let index = requireAliasScopes.length - 1; index >= 0; index--) {
      const scope = requireAliasScopes[index];
      if (scope.has(name)) {
        return { index, scope };
      }
    }
    return { index: requireAliasScopes.length - 1, scope: currentRequireAliasScope() };
  }

  function expressionLiteralCandidateTexts(node) {
    const candidates = legacyCandidateTexts(sourceFile, node);
    const segmentOptions = [];

    function combineSegmentOptions(left, right) {
      const joined = left.flatMap((leftOption) =>
        right.map((rightOption) => `${leftOption}${rightOption}`),
      );
      return joined.length > 32 ? joined.slice(0, 32) : joined;
    }

    function expressionSegmentOptions(current) {
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

    function maybeAddCallLiteralCandidate(current) {
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

    function visitCandidate(current) {
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

  function expressionTextContainsLegacyStore(node) {
    return expressionLiteralCandidateTexts(node).some((text) =>
      legacyStorePatterns.some((pattern) => pattern.test(text)),
    );
  }

  function literalTextsFromExpression(expression) {
    const unwrapped = unwrapExpression(expression);
    if (ts.isStringLiteralLike(unwrapped)) {
      return [unwrapped.text];
    }
    return [];
  }

  function arrayLiteralElementAt(expression, index) {
    const unwrapped = unwrapExpression(expression);
    if (!ts.isArrayLiteralExpression(unwrapped)) {
      return null;
    }
    const element = unwrapped.elements[index];
    return element && !ts.isSpreadElement(element) ? element : null;
  }

  function legacyObjectPropertyRewriteValues(objectName, initializer, existingScope) {
    const values = new Map();
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
    objectName,
    propertyName,
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
    objectName,
    propertyName,
    maxScopeIndex = legacyObjectPropertyScopes.length - 1,
  ) {
    const key = objectPropertyKey(objectName, propertyName);
    for (
      let index = Math.min(maxScopeIndex, legacyObjectPropertyScopes.length - 1);
      index >= 0;
      index--
    ) {
      const propertyScope = legacyObjectPropertyScopes[index];
      if (propertyScope.has(key)) {
        return { found: true, value: propertyScope.get(key) };
      }
      if (legacyPathScopes[index].has(objectName)) {
        return {
          found: false,
          objectKnown: true,
          objectValue: legacyPathScopes[index].get(objectName) === true,
        };
      }
    }
    return { found: false, objectKnown: false, objectValue: false };
  }

  function lookupScopedLegacyObjectPropertyEntry(
    objectName,
    propertyPath,
    propertyScope,
    knownObjectLiteralScope,
  ) {
    const propertyName = propertyPath.join(".");
    const key = objectPropertyKey(objectName, propertyName);
    if (propertyScope.has(key)) {
      return { found: true, value: propertyScope.get(key) };
    }
    const parentPath = propertyPath.slice(0, -1).join(".");
    const parentKey = parentPath ? objectPropertyKey(objectName, parentPath) : objectName;
    if (knownObjectLiteralScope.get(parentKey) === true) {
      return { found: false, objectKnown: true, objectValue: false };
    }
    return { found: false, objectKnown: false, objectValue: false };
  }

  function legacyObjectPropertyValueFromExpression(expression) {
    return isKnownUndefinedExpression(expression)
      ? explicitUndefinedLegacyObjectPropertyValue
      : expressionContainsLegacyStore(expression);
  }

  function elementAccessName(expression) {
    const argument = unwrapExpression(expression);
    return ts.isStringLiteral(argument) || ts.isNumericLiteral(argument) ? argument.text : null;
  }

  function propertyAccessPath(expression) {
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

  function namedObjectPropertyAccess(expression) {
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      return {
        objectName: expression.expression.text,
        propertyName: expression.name.text,
      };
    }
    if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const propertyName = elementAccessName(expression.argumentExpression);
      return propertyName
        ? {
            objectName: expression.expression.text,
            propertyName,
          }
        : null;
    }
    return null;
  }

  function legacyObjectPropertyWriteTarget(objectName, propertyName) {
    const key = objectPropertyKey(objectName, propertyName);
    for (let index = legacyObjectPropertyScopes.length - 1; index >= 0; index--) {
      const propertyScope = legacyObjectPropertyScopes[index];
      if (propertyScope.has(key) || legacyPathScopes[index].has(objectName)) {
        return { index, scope: propertyScope };
      }
    }
    return {
      index: legacyObjectPropertyScopes.length - 1,
      scope: currentLegacyObjectPropertyScope(),
    };
  }

  function legacyIdentifierWriteScopes(name) {
    for (let index = legacyPathScopes.length - 1; index >= 0; index--) {
      if (legacyPathScopes[index].has(name)) {
        return {
          index,
          pathScope: legacyPathScopes[index],
          propertyScope: legacyObjectPropertyScopes[index],
          wrapperScope: wrapperFunctionScopes[index],
        };
      }
    }
    return {
      index: legacyPathScopes.length - 1,
      pathScope: currentLegacyPathScope(),
      propertyScope: currentLegacyObjectPropertyScope(),
      wrapperScope: currentWrapperFunctionScope(),
    };
  }

  function isConditionallyExecutedScope(node) {
    const parent = node.parent;
    return Boolean(
      (ts.isBlock(node) &&
        parent &&
        ((ts.isIfStatement(parent) &&
          (parent.thenStatement === node || parent.elseStatement === node)) ||
          (ts.isIterationStatement(parent, false) && parent.statement === node) ||
          (ts.isTryStatement(parent) && parent.tryBlock === node))) ||
      ts.isCaseBlock(node) ||
      ts.isCatchClause(node),
    );
  }

  function expressionContainsLegacyStore(node) {
    if (expressionTextContainsLegacyStore(node)) {
      return true;
    }
    let found = false;
    function visitExpression(current) {
      if (found) {
        return;
      }
      if (ts.isIdentifier(current) && resolveLegacyPathIdentifier(current.text)) {
        found = true;
        return;
      }
      const propertyAccess = rootedPropertyAccessPath(current);
      if (propertyAccess?.properties.length > 0) {
        const propertyValue = lookupLegacyObjectProperty(
          propertyAccess.rootName,
          propertyAccess.properties.join("."),
        );
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

  function visitWithChildScope(node) {
    fsWriteAliasScopes.push(new Map());
    fsSafeStoreFactoryAliasScopes.push(new Map());
    fsSafeStoreScopes.push(new Map());
    fsSafeJsonStoreScopes.push(new Map());
    fsModuleBindingScopes.push(new Map());
    fsModulePropertyScopes.push(new Map());
    requireAliasScopes.push(new Map());
    requireShadowScopes.push(new Set());
    createRequireShadowScopes.push(new Set());
    legacyPathScopes.push(new Map());
    literalTextScopes.push(new Map());
    knownUndefinedScopes.push(new Map());
    legacyKnownObjectLiteralScopes.push(new Map());
    legacyObjectPropertyScopes.push(new Map());
    wrapperFunctionScopes.push(new Map());
    conditionalExecutionScopes.push(
      currentConditionalExecutionScope() || isConditionallyExecutedScope(node),
    );
    if ("statements" in node) {
      registerHoistedWrapperFunctions(node.statements);
    }
    ts.forEachChild(node, visit);
    conditionalExecutionScopes.pop();
    wrapperFunctionScopes.pop();
    legacyObjectPropertyScopes.pop();
    legacyKnownObjectLiteralScopes.pop();
    knownUndefinedScopes.pop();
    literalTextScopes.pop();
    legacyPathScopes.pop();
    fsModulePropertyScopes.pop();
    fsModuleBindingScopes.pop();
    fsSafeJsonStoreScopes.pop();
    fsSafeStoreScopes.pop();
    fsSafeStoreFactoryAliasScopes.pop();
    fsWriteAliasScopes.pop();
    createRequireShadowScopes.pop();
    requireShadowScopes.pop();
    requireAliasScopes.pop();
  }

  function registerFsBindingParameter(name) {
    if (ts.isIdentifier(name)) {
      currentFsModuleBindingScope().set(name.text, true);
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
          currentFsModuleBindingScope().set(element.name.text, true);
        } else if (ts.isObjectBindingPattern(element.name)) {
          registerFsPromisesBindingParameter(element.name);
        }
      }
      if (importedName && legacyWriteCallees.has(importedName) && ts.isIdentifier(element.name)) {
        currentFsWriteAliasScope().set(element.name.text, importedName);
      }
    }
  }

  function registerFsPromisesBindingParameter(name) {
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
        currentFsWriteAliasScope().set(element.name.text, importedName);
      }
      if (ts.isObjectBindingPattern(element.name)) {
        registerFsPromisesBindingParameter(element.name);
      }
    }
  }

  function visitFunctionLike(node, fsBindingParameterIndexes = new Set()) {
    fsWriteAliasScopes.push(new Map());
    fsSafeStoreFactoryAliasScopes.push(new Map());
    fsSafeStoreScopes.push(new Map());
    fsSafeJsonStoreScopes.push(new Map());
    fsModuleBindingScopes.push(new Map());
    fsModulePropertyScopes.push(new Map());
    requireAliasScopes.push(new Map());
    requireShadowScopes.push(new Set());
    createRequireShadowScopes.push(new Set());
    legacyPathScopes.push(new Map());
    literalTextScopes.push(new Map());
    knownUndefinedScopes.push(new Map());
    legacyKnownObjectLiteralScopes.push(new Map());
    legacyObjectPropertyScopes.push(new Map());
    wrapperFunctionScopes.push(new Map());
    conditionalExecutionScopes.push(false);
    node.parameters.forEach((parameter, index) => {
      for (const name of bindingPatternNames(parameter.name)) {
        currentLegacyPathScope().set(name, false);
        currentLegacyKnownObjectLiteralScope().set(name, false);
        currentKnownUndefinedScope().set(name, false);
        currentLiteralTextScope().set(name, null);
        currentWrapperFunctionScope().set(name, null);
        currentRequireAliasScope().set(name, false);
      }
      markFsWriteAliasShadows(parameter.name);
      markFsSafeStoreShadows(parameter.name);
      markFsModuleBindingShadows(parameter.name);
      markFsModulePropertyShadows(parameter.name);
      markRequireShadows(parameter.name);
      markCreateRequireShadows(parameter.name);
      registerFsModuleTypeProperties(parameter.name, parameter.type);
      if (fsBindingParameterIndexes.has(index)) {
        registerFsBindingParameter(parameter.name);
      }
    });
    ts.forEachChild(node, visit);
    conditionalExecutionScopes.pop();
    wrapperFunctionScopes.pop();
    legacyObjectPropertyScopes.pop();
    legacyKnownObjectLiteralScopes.pop();
    knownUndefinedScopes.pop();
    literalTextScopes.pop();
    legacyPathScopes.pop();
    fsModulePropertyScopes.pop();
    fsModuleBindingScopes.pop();
    fsSafeJsonStoreScopes.pop();
    fsSafeStoreScopes.pop();
    fsSafeStoreFactoryAliasScopes.pop();
    fsWriteAliasScopes.pop();
    createRequireShadowScopes.pop();
    requireShadowScopes.pop();
    requireAliasScopes.pop();
  }

  function dynamicFsImportThenCallback(node) {
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

  function isFsModuleExpression(expression) {
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
    return (
      ts.isPropertyAccessExpression(receiver) &&
      receiver.name.text === "promises" &&
      (isFsRequireExpression(receiver.expression, isNodeRequireName) ||
        isFsDynamicImportExpression(receiver.expression) ||
        (ts.isIdentifier(receiver.expression) &&
          resolveFsModuleBinding(receiver.expression.text)) ||
        (propertyAccessPath(receiver.expression) &&
          resolveFsModuleProperty(propertyAccessPath(receiver.expression))))
    );
  }

  function legacyFsWriteName(expression, aliases = null) {
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
      ? aliases.get(callee.text)
      : resolveFsWriteAlias(callee.text);
  }

  function fsSafeStoreFactoryAliasName(expression) {
    const callee = unwrapExpression(expression);
    if (ts.isIdentifier(callee)) {
      return resolveFsSafeStoreFactoryAlias(callee.text);
    }
    const name = callExpressionName(callee);
    return name ? resolveFsSafeStoreFactoryAlias(name) : null;
  }

  function isFsSafeStoreFactoryCall(expression) {
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

  function isFsSafeStoreExpression(expression) {
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

  function objectFilePathContainsLegacyStore(expression) {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      return lookupLegacyObjectProperty(unwrapped.text, "filePath") === true;
    }
    if (!ts.isObjectLiteralExpression(unwrapped)) {
      return expressionContainsLegacyStore(unwrapped);
    }
    return objectLiteralPropertyContainsLegacyStore(unwrapped, "filePath");
  }

  function expressionContainsFsSafeJsonStoreLegacyPath(expression) {
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

  function fsSafeJsonStoreWriteContainsLegacyStore(call) {
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

  function fsSafeStoreWritePathArguments(call) {
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

  function markFsWriteAliasShadows(name) {
    for (const bindingName of bindingPatternNames(name)) {
      if (resolveFsWriteAlias(bindingName)) {
        currentFsWriteAliasScope().set(bindingName, null);
      }
      shadowVisibleFsWriteObjectAliases(bindingName);
    }
  }

  function markFsSafeStoreShadows(name) {
    for (const bindingName of bindingPatternNames(name)) {
      if (resolveFsSafeStoreFactoryAlias(bindingName)) {
        currentFsSafeStoreFactoryAliasScope().set(bindingName, null);
      }
      const prefix = `${bindingName}.`;
      for (const scope of fsSafeStoreFactoryAliasScopes) {
        for (const alias of scope.keys()) {
          if (alias.startsWith(prefix)) {
            currentFsSafeStoreFactoryAliasScope().set(alias, null);
          }
        }
      }
      if (resolveFsSafeStore(bindingName)) {
        currentFsSafeStoreScope().set(bindingName, false);
      }
      if (resolveFsSafeJsonStore(bindingName)) {
        currentFsSafeJsonStoreScope().set(bindingName, false);
      }
      const storePrefix = `${bindingName}.`;
      for (const scope of fsSafeStoreScopes) {
        for (const alias of scope.keys()) {
          if (alias.startsWith(storePrefix)) {
            currentFsSafeStoreScope().set(alias, false);
          }
        }
      }
      for (const scope of fsSafeJsonStoreScopes) {
        for (const alias of scope.keys()) {
          if (alias.startsWith(storePrefix)) {
            currentFsSafeJsonStoreScope().set(alias, false);
          }
        }
      }
    }
  }

  function markFsModuleBindingShadows(name) {
    for (const bindingName of bindingPatternNames(name)) {
      if (resolveFsModuleBinding(bindingName)) {
        currentFsModuleBindingScope().set(bindingName, false);
      }
    }
  }

  function markFsModulePropertyShadows(name) {
    for (const bindingName of bindingPatternNames(name)) {
      clearFsModuleObjectProperties(currentFsModulePropertyScope(), bindingName);
    }
  }

  function markRequireShadows(name) {
    if (bindingPatternNames(name).includes("require")) {
      currentRequireShadowScope().add("require");
    }
  }

  function markCreateRequireShadows(name) {
    for (const bindingName of bindingPatternNames(name)) {
      if (createRequireBindings.has(bindingName)) {
        createRequireShadowScopes[createRequireShadowScopes.length - 1].add(bindingName);
      }
    }
  }

  function isFsModuleTypeNode(type) {
    return Boolean(
      type &&
      /\btypeof\s+import\s*\(\s*["'](?:node:fs|node:fs\/promises|fs|fs\/promises)["']\s*\)/u.test(
        type.getText(sourceFile),
      ),
    );
  }

  function fsModulePropertyPathsFromType(type) {
    const paths = [];
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

  function registerFsModuleTypeProperties(name, type) {
    if (!ts.isIdentifier(name) || !type) {
      return;
    }
    if (isFsModuleTypeNode(type)) {
      currentFsModuleBindingScope().set(name.text, true);
    }
    for (const pathParts of fsModulePropertyPathsFromType(type)) {
      currentFsModulePropertyScope().set([name.text, ...pathParts].join("."), true);
    }
  }

  function collectFsWriteAliasesFromBinding(node) {
    collectFsWriteAliasesFromBindingInto(node, currentFsWriteAliasScope());
  }

  function clearFsWriteObjectAliases(scope, objectName) {
    const prefix = `${objectName}.`;
    for (const name of scope.keys()) {
      if (name.startsWith(prefix)) {
        scope.set(name, null);
      }
    }
  }

  function shadowVisibleFsWriteObjectAliases(objectName) {
    const prefix = `${objectName}.`;
    const currentScope = currentFsWriteAliasScope();
    for (const scope of fsWriteAliasScopes) {
      for (const name of scope.keys()) {
        if (name.startsWith(prefix)) {
          currentScope.set(name, null);
        }
      }
    }
  }

  function setFsWriteObjectAlias(scope, name, writeName, conditionalWrite) {
    if (writeName) {
      scope.set(name, writeName);
    } else if (!conditionalWrite) {
      scope.set(name, null);
    }
  }

  function registerFsWriteObjectAliases(
    objectName,
    initializer,
    scope = currentFsWriteAliasScope(),
    conditionalWrite = false,
  ) {
    const objectLiteral = unwrapExpression(initializer);
    if (!ts.isObjectLiteralExpression(objectLiteral)) {
      return;
    }
    for (const property of objectLiteral.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyNameText(property.name);
        if (name) {
          setFsWriteObjectAlias(
            scope,
            `${objectName}.${name}`,
            legacyFsWriteName(property.initializer),
            conditionalWrite,
          );
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        setFsWriteObjectAlias(
          scope,
          `${objectName}.${property.name.text}`,
          resolveFsWriteAlias(property.name.text),
          conditionalWrite,
        );
      }
    }
  }

  function clearFsSafeStoreObjectAliases(storeScope, jsonStoreScope, objectName) {
    const prefix = `${objectName}.`;
    for (const name of storeScope.keys()) {
      if (name.startsWith(prefix)) {
        storeScope.set(name, false);
      }
    }
    for (const name of jsonStoreScope.keys()) {
      if (name.startsWith(prefix)) {
        jsonStoreScope.set(name, false);
      }
    }
  }

  function shadowVisibleFsSafeStoreObjectAliases(objectName) {
    const prefix = `${objectName}.`;
    const currentStoreScope = currentFsSafeStoreScope();
    const currentJsonStoreScope = currentFsSafeJsonStoreScope();
    for (const scope of fsSafeStoreScopes) {
      for (const name of scope.keys()) {
        if (name.startsWith(prefix)) {
          currentStoreScope.set(name, false);
        }
      }
    }
    for (const scope of fsSafeJsonStoreScopes) {
      for (const name of scope.keys()) {
        if (name.startsWith(prefix)) {
          currentJsonStoreScope.set(name, false);
        }
      }
    }
  }

  function setFsSafeStoreObjectAlias(
    storeScope,
    jsonStoreScope,
    name,
    isStore,
    isJsonStore,
    conditionalWrite,
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
    targetName,
    sourceName,
    storeScope = currentFsSafeStoreScope(),
    jsonStoreScope = currentFsSafeJsonStoreScope(),
  ) {
    const sourcePrefix = `${sourceName}.`;
    for (let index = fsSafeStoreScopes.length - 1; index >= 0; index--) {
      const sourceStoreScope = fsSafeStoreScopes[index];
      const sourceJsonStoreScope = fsSafeJsonStoreScopes[index];
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
    objectName,
    initializer,
    storeScope = currentFsSafeStoreScope(),
    jsonStoreScope = currentFsSafeJsonStoreScope(),
    conditionalWrite = false,
  ) {
    const objectLiteral = unwrapExpression(initializer);
    if (!ts.isObjectLiteralExpression(objectLiteral)) {
      return;
    }
    for (const property of objectLiteral.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyNameText(property.name);
        if (name) {
          setFsSafeStoreObjectAlias(
            storeScope,
            jsonStoreScope,
            `${objectName}.${name}`,
            isFsSafeStoreExpression(property.initializer),
            expressionContainsFsSafeJsonStoreLegacyPath(property.initializer),
            conditionalWrite,
          );
          if (ts.isObjectLiteralExpression(unwrapExpression(property.initializer))) {
            registerFsSafeStoreObjectAliases(
              `${objectName}.${name}`,
              property.initializer,
              storeScope,
              jsonStoreScope,
              conditionalWrite,
            );
          }
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        setFsSafeStoreObjectAlias(
          storeScope,
          jsonStoreScope,
          `${objectName}.${property.name.text}`,
          resolveFsSafeStore(property.name.text),
          resolveFsSafeJsonStore(property.name.text),
          conditionalWrite,
        );
        continue;
      }
      if (ts.isSpreadAssignment(property)) {
        const spreadExpression = unwrapExpression(property.expression);
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
      }
    }
  }

  function setFsModuleObjectProperty(scope, name, isFsModule, conditionalWrite) {
    if (isFsModule) {
      scope.set(name, true);
    } else if (!conditionalWrite) {
      scope.set(name, false);
    }
  }

  function clearFsModuleObjectProperties(scope, objectName) {
    const prefix = `${objectName}.`;
    scope.set(objectName, false);
    for (const name of scope.keys()) {
      if (name.startsWith(prefix)) {
        scope.set(name, false);
      }
    }
  }

  function registerFsModuleObjectProperties(
    objectName,
    initializer,
    scope = currentFsModulePropertyScope(),
    conditionalWrite = false,
  ) {
    const objectLiteral = unwrapExpression(initializer);
    if (!ts.isObjectLiteralExpression(objectLiteral)) {
      return;
    }
    for (const property of objectLiteral.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = propertyNameText(property.name);
        if (name) {
          setFsModuleObjectProperty(
            scope,
            `${objectName}.${name}`,
            isFsModuleExpression(property.initializer),
            conditionalWrite,
          );
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        setFsModuleObjectProperty(
          scope,
          `${objectName}.${property.name.text}`,
          resolveFsModuleBinding(property.name.text),
          conditionalWrite,
        );
      }
    }
  }

  function collectFsModuleBindingsFromBinding(node) {
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
        currentFsModuleBindingScope().set(bindingName.text, true);
      }
    }
  }

  function isFsBindingExpression(expression) {
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
    node,
    aliases,
    isFsBinding = isFsBindingExpression,
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

  function collectFsWriteAliasesFromPattern(pattern, aliases) {
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

  function markArrayBindingPatternFromForOf(initializer, expression) {
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
        .filter(Boolean);
      if (elementsAtIndex.length === 0) {
        return;
      }

      currentLegacyPathScope().set(
        bindingElement.name.text,
        elementsAtIndex.some((element) => expressionContainsLegacyStore(element)),
      );
      currentLiteralTextScope().set(
        bindingElement.name.text,
        mergeExhaustiveLiteralTexts(
          [],
          elementsAtIndex.flatMap((element) => literalTextsFromExpression(element)),
        ),
      );
    });
  }

  function pathArgumentsForFsWrite(name, args) {
    if (
      name === "appendRegularFile" ||
      name === "appendRegularFileSync" ||
      name === "replaceFileAtomic" ||
      name === "replaceFileAtomicSync"
    ) {
      const first = args[0];
      if (!first || !ts.isObjectLiteralExpression(unwrapExpression(first))) {
        return first ? [first] : [];
      }
      const objectArg = unwrapExpression(first);
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

  function openFlagsMayWrite(flags) {
    if (!flags) {
      return false;
    }
    const unwrapped = unwrapExpression(flags);
    if (ts.isStringLiteralLike(unwrapped)) {
      return /[wa+]/u.test(unwrapped.text);
    }
    return true;
  }

  function fsWriteCallMayWrite(name, args) {
    if (name === "open" || name === "openSync") {
      return openFlagsMayWrite(args[1]);
    }
    return true;
  }

  function propertyNameText(name) {
    return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
      ? name.text
      : null;
  }

  const unknownObjectLiteralPropertyInitializer = Symbol(
    "unknown object literal property initializer",
  );
  const explicitUndefinedNestedWrapperValue = Symbol("explicit undefined nested wrapper value");
  const knownObjectLiteralNestedWrapperValue = Symbol("known object literal nested wrapper value");
  const unknownNestedWrapperObjectValue = Symbol("unknown nested wrapper object value");

  function isVarVariableDeclaration(node) {
    return (
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.BlockScoped) === 0
    );
  }

  function isAmbientVariableDeclaration(node) {
    let current = node.parent;
    while (current && !ts.isSourceFile(current)) {
      const modifiers = ts.canHaveModifiers(current) ? (ts.getModifiers(current) ?? []) : [];
      if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  function isTypeSyntaxNode(node) {
    return node.kind >= ts.SyntaxKind.FirstTypeNode && node.kind <= ts.SyntaxKind.LastTypeNode;
  }

  function objectLiteralPropertyLegacyValue(objectLiteral, propertyName) {
    let result = null;
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

  function objectLiteralPropertyInitializerState(
    objectLiteral,
    propertyName,
    resolveSpreadProperty = null,
  ) {
    let result = { kind: "missing" };
    for (const property of objectLiteral.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spreadExpression = unwrapExpression(property.expression);
        if (ts.isIdentifier(spreadExpression) && resolveSpreadProperty) {
          const spreadResult = resolveSpreadProperty(spreadExpression.text, propertyName);
          if (spreadResult.kind !== "missing") {
            result = spreadResult;
          }
          continue;
        }
        if (ts.isObjectLiteralExpression(spreadExpression)) {
          const spreadResult = objectLiteralPropertyInitializerState(
            spreadExpression,
            propertyName,
            resolveSpreadProperty,
          );
          if (spreadResult.kind !== "missing") {
            result = spreadResult;
          }
          continue;
        }
        result = { kind: "unknown" };
        continue;
      }
      if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === propertyName) {
        result = isKnownUndefinedExpression(property.initializer)
          ? { kind: "undefined" }
          : { kind: "initializer", initializer: property.initializer };
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
        result = isKnownUndefinedExpression(property.name)
          ? { kind: "undefined" }
          : { kind: "initializer", initializer: property.name };
      }
    }
    return result;
  }

  function objectLiteralPropertyInitializer(objectLiteral, propertyName) {
    const result = objectLiteralPropertyInitializerState(objectLiteral, propertyName);
    if (result.kind === "missing" || result.kind === "undefined") {
      return null;
    }
    if (result.kind === "unknown") {
      return unknownObjectLiteralPropertyInitializer;
    }
    return result.initializer;
  }

  function objectLiteralPropertyContainsLegacyStore(objectLiteral, propertyName) {
    return objectLiteralPropertyLegacyValue(objectLiteral, propertyName) === true;
  }

  function clearLegacyObjectProperties(scope, objectName) {
    const prefix = `${objectName}.`;
    for (const key of scope.keys()) {
      if (key.startsWith(prefix)) {
        scope.delete(key);
      }
    }
  }

  function clearKnownLegacyObjectLiterals(scope, objectName) {
    const prefix = `${objectName}.`;
    for (const key of scope.keys()) {
      if (key.startsWith(prefix)) {
        scope.delete(key);
      }
    }
  }

  function legacyObjectPropertiesFromAssignment(
    objectName,
    initializer,
    existingScope = new Map(),
  ) {
    return legacyObjectPropertyRewriteValues(objectName, initializer, existingScope);
  }

  function legacyKnownObjectLiteralsFromAssignment(objectName, initializer) {
    const knownObjectLiterals = new Map();
    markLegacyObjectProperties(objectName, initializer, new Map(), knownObjectLiterals);
    return knownObjectLiterals;
  }

  function branchIdentifierAssignmentKey(index, name) {
    return `${index}:${name}`;
  }

  function branchPropertyAssignmentKey(index, objectName, propertyName) {
    return `${index}:${objectPropertyKey(objectName, propertyName)}`;
  }

  function branchWrapperAssignmentKey(index, name) {
    return `${index}:${name}`;
  }

  function recordBranchIdentifierAssignment(
    index,
    name,
    value,
    initializer,
    literalTexts,
    objectProperties = null,
    knownUndefined = isKnownUndefinedExpression(initializer),
  ) {
    const effects = currentBranchEffectScope();
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
    index,
    objectName,
    propertyName,
    value,
    knownObjectLiteral = false,
  ) {
    const effects = currentBranchEffectScope();
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

  function recordBranchWrapperAssignment(index, name, value) {
    const effects = currentBranchEffectScope();
    if (!effects) {
      return;
    }
    effects.wrapperAssignments.set(branchWrapperAssignmentKey(index, name), {
      index,
      name,
      value: cloneWrapperFunctionValue(value),
    });
  }

  function recordBranchFsIdentifierAssignment(
    index,
    name,
    moduleValue,
    writeAlias,
    fsSafeFactoryAlias,
    fsSafeStoreValue,
    fsSafeJsonStoreValue,
    requireAlias,
  ) {
    const effects = currentBranchEffectScope();
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
    index,
    objectName,
    propertyName,
    storeValue,
    jsonStoreValue,
  ) {
    const effects = currentBranchEffectScope();
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
    index,
    objectName,
    propertyName,
    initializer,
    storeValue,
    jsonStoreValue,
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

  function mergeWrapperAssignmentValues(left, right) {
    const records = [
      ...wrapperRecords(left).map(cloneWrapperRecord),
      ...wrapperRecords(right).map(cloneWrapperRecord),
    ];
    if (records.length === 0) {
      return null;
    }
    return records.length === 1 ? records[0] : records;
  }

  function mergeExhaustiveBranchEffects(thenEffects, elseEffects) {
    const mergedIdentifierNames = new Set();
    const parentEffect = currentBranchEffectScope();
    const applyToTargetScopes = !currentConditionalExecutionScope() && !parentEffect;
    for (const [key, thenAssignment] of thenEffects.fsIdentifierAssignments) {
      const elseAssignment = elseEffects.fsIdentifierAssignments.get(key);
      if (!elseAssignment) {
        continue;
      }
      const { index, name } = thenAssignment;
      const mergedModuleValue =
        thenAssignment.moduleValue === true || elseAssignment.moduleValue === true;
      const mergedWriteAlias = thenAssignment.writeAlias ?? elseAssignment.writeAlias;
      const mergedFsSafeFactoryAlias =
        thenAssignment.fsSafeFactoryAlias ?? elseAssignment.fsSafeFactoryAlias;
      const mergedFsSafeStoreValue =
        thenAssignment.fsSafeStoreValue === true || elseAssignment.fsSafeStoreValue === true;
      const mergedFsSafeJsonStoreValue =
        thenAssignment.fsSafeJsonStoreValue === true ||
        elseAssignment.fsSafeJsonStoreValue === true;
      const mergedRequireAlias =
        thenAssignment.requireAlias === true || elseAssignment.requireAlias === true;
      if (applyToTargetScopes) {
        fsModuleBindingScopes[index].set(name, mergedModuleValue);
        fsWriteAliasScopes[index].set(name, mergedWriteAlias);
        fsSafeStoreFactoryAliasScopes[index].set(name, mergedFsSafeFactoryAlias);
        fsSafeStoreScopes[index].set(name, mergedFsSafeStoreValue);
        fsSafeJsonStoreScopes[index].set(name, mergedFsSafeJsonStoreValue);
        requireAliasScopes[index].set(name, mergedRequireAlias);
      }
      currentFsModuleBindingScope().set(name, mergedModuleValue);
      currentFsWriteAliasScope().set(name, mergedWriteAlias);
      currentFsSafeStoreFactoryAliasScope().set(name, mergedFsSafeFactoryAlias);
      currentFsSafeStoreScope().set(name, mergedFsSafeStoreValue);
      currentFsSafeJsonStoreScope().set(name, mergedFsSafeJsonStoreValue);
      currentRequireAliasScope().set(name, mergedRequireAlias);
      refreshCurrentWrapperFunctionAliases();
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
      if (!elseAssignment) {
        continue;
      }
      const { index, name } = thenAssignment;
      mergedIdentifierNames.add(branchIdentifierAssignmentKey(index, name));
      const merged = mergeLegacyPathBranchAssignments(thenAssignment, elseAssignment);
      if (applyToTargetScopes) {
        const pathScope = legacyPathScopes[index];
        const literalScope = literalTextScopes[index];
        const knownUndefinedScope = knownUndefinedScopes[index];
        const propertyScope = legacyObjectPropertyScopes[index];
        const knownObjectLiteralScope = legacyKnownObjectLiteralScopes[index];
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
      clearKnownLegacyObjectLiterals(currentLegacyKnownObjectLiteralScope(), name);
      currentLegacyKnownObjectLiteralScope().set(name, merged.knownObjectLiteral);
      for (const [knownObjectLiteralKey, value] of merged.knownObjectLiterals) {
        currentLegacyKnownObjectLiteralScope().set(knownObjectLiteralKey, value);
      }
      currentLegacyPathScope().set(name, merged.value);
      currentKnownUndefinedScope().set(name, merged.knownUndefined);
      currentLiteralTextScope().set(name, merged.literalTexts);
      clearLegacyObjectProperties(currentLegacyObjectPropertyScope(), name);
      for (const [propertyKey, value] of merged.objectProperties) {
        currentLegacyObjectPropertyScope().set(propertyKey, value);
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
      if (!elseAssignment) {
        continue;
      }
      const mergedStoreValue =
        thenAssignment.storeValue === true || elseAssignment.storeValue === true;
      const mergedJsonStoreValue =
        thenAssignment.jsonStoreValue === true || elseAssignment.jsonStoreValue === true;
      const propertyKey = objectPropertyKey(thenAssignment.objectName, thenAssignment.propertyName);
      if (applyToTargetScopes) {
        fsSafeStoreScopes[thenAssignment.index].set(propertyKey, mergedStoreValue);
        fsSafeJsonStoreScopes[thenAssignment.index].set(propertyKey, mergedJsonStoreValue);
      }
      currentFsSafeStoreScope().set(propertyKey, mergedStoreValue);
      currentFsSafeJsonStoreScope().set(propertyKey, mergedJsonStoreValue);
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
      if (!elseAssignment) {
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
        legacyObjectPropertyScopes[thenAssignment.index].set(propertyKey, mergedValue);
        legacyKnownObjectLiteralScopes[thenAssignment.index].set(
          propertyKey,
          mergedKnownObjectLiteral,
        );
      }
      currentLegacyObjectPropertyScope().set(propertyKey, mergedValue);
      currentLegacyKnownObjectLiteralScope().set(propertyKey, mergedKnownObjectLiteral);
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
      if (!elseAssignment) {
        continue;
      }
      const { index, name } = thenAssignment;
      const mergedValue = mergeWrapperAssignmentValues(thenAssignment.value, elseAssignment.value);
      if (applyToTargetScopes) {
        wrapperFunctionScopes[index].set(name, cloneWrapperFunctionValue(mergedValue));
      }
      currentWrapperFunctionScope().set(name, cloneWrapperFunctionValue(mergedValue));
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
    objectName,
    initializer,
    targetScope = currentLegacyObjectPropertyScope(),
    knownObjectLiteralScope = currentLegacyKnownObjectLiteralScope(),
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
        const name = propertyNameText(property.name);
        if (name) {
          const propertyKey = `${objectName}.${name}`;
          clearLegacyObjectProperties(targetScope, propertyKey);
          if (knownObjectLiteralScope) {
            clearKnownLegacyObjectLiterals(knownObjectLiteralScope, propertyKey);
          }
          targetScope.set(
            propertyKey,
            legacyObjectPropertyValueFromExpression(property.initializer),
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
    targetName,
    sourceName,
    targetScope = currentLegacyObjectPropertyScope(),
  ) {
    const sourcePrefix = `${sourceName}.`;
    for (let index = legacyObjectPropertyScopes.length - 1; index >= 0; index--) {
      const scope = legacyObjectPropertyScopes[index];
      const copiedEntries = [];
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
      if (copied || legacyPathScopes[index].has(sourceName)) {
        return;
      }
    }
  }

  function copyKnownLegacyObjectLiterals(
    targetName,
    sourceName,
    targetScope = currentLegacyKnownObjectLiteralScope(),
  ) {
    targetScope.set(targetName, lookupKnownLegacyObjectLiteral(sourceName));
    const sourcePrefix = `${sourceName}.`;
    for (let index = legacyKnownObjectLiteralScopes.length - 1; index >= 0; index--) {
      const scope = legacyKnownObjectLiteralScopes[index];
      const copiedEntries = [];
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
      if (copied || scope.has(sourceName) || legacyPathScopes[index].has(sourceName)) {
        return;
      }
    }
  }

  function copyScopedLegacyObjectProperties(targetName, sourceName, sourceScope) {
    const sourcePrefix = `${sourceName}.`;
    const copiedEntries = [];
    for (const [key, value] of sourceScope) {
      if (key.startsWith(sourcePrefix)) {
        copiedEntries.push([`${targetName}.${key.slice(sourcePrefix.length)}`, value]);
      }
    }
    copiedEntries.sort((left, right) => left[0].length - right[0].length);
    for (const [key, value] of copiedEntries) {
      clearLegacyObjectProperties(currentLegacyObjectPropertyScope(), key);
      currentLegacyObjectPropertyScope().set(key, value);
    }
  }

  function copyScopedKnownLegacyObjectLiterals(targetName, sourceName, sourceScope) {
    currentLegacyKnownObjectLiteralScope().set(targetName, sourceScope.get(sourceName) === true);
    const sourcePrefix = `${sourceName}.`;
    const copiedEntries = [];
    for (const [key, value] of sourceScope) {
      if (key.startsWith(sourcePrefix)) {
        copiedEntries.push([`${targetName}.${key.slice(sourcePrefix.length)}`, value]);
      }
    }
    copiedEntries.sort((left, right) => left[0].length - right[0].length);
    for (const [key, value] of copiedEntries) {
      clearKnownLegacyObjectLiterals(currentLegacyKnownObjectLiteralScope(), key);
      currentLegacyKnownObjectLiteralScope().set(key, value);
    }
  }

  function collectPathPropertyUses(
    expression,
    fsWriteName,
    resolveParameterIndex,
    resolveDestructuredParameterProperty,
    resolveParameterPropertyUse = null,
    resolveDestructuredParameterPropertyUses = null,
  ) {
    function appendUses(uses, value) {
      if (!value) {
        return;
      }
      if (Array.isArray(value)) {
        uses.push(...value);
        return;
      }
      uses.push(value);
    }

    function isPathLikeWrapperPropertyName(propertyName) {
      const normalized = propertyName.toLowerCase();
      return (
        normalized === "path" ||
        normalized === "store" ||
        normalized === "file" ||
        normalized.endsWith("path") ||
        normalized.endsWith("dir")
      );
    }

    const uses = [];
    function visitExpression(current) {
      if (
        ts.isIdentifier(current) &&
        usesFilePathOptionsObject(fsWriteName) &&
        resolveParameterIndex(current.text) !== null
      ) {
        const propertyUse = resolveParameterPropertyUse?.(current.text, "filePath");
        if (propertyUse !== null) {
          appendUses(
            uses,
            propertyUse ?? { index: resolveParameterIndex(current.text), propertyName: "filePath" },
          );
        }
        return;
      }
      const propertyAccess = rootedPropertyAccessPath(current);
      if (propertyAccess?.properties.length > 0) {
        const index = resolveParameterIndex(propertyAccess.rootName);
        if (index !== null) {
          for (let length = propertyAccess.properties.length; length > 0; length--) {
            const lastPropertyName = propertyAccess.properties[length - 1];
            if (
              length !== propertyAccess.properties.length &&
              !isPathLikeWrapperPropertyName(lastPropertyName)
            ) {
              continue;
            }
            const propertyName = propertyAccess.properties.slice(0, length).join(".");
            const propertyUse = resolveParameterPropertyUse?.(
              propertyAccess.rootName,
              propertyName,
            );
            if (propertyUse !== null) {
              appendUses(uses, propertyUse ?? { index, propertyName });
            }
          }
        }
        return;
      }
      if (ts.isIdentifier(current)) {
        const destructuredUses = resolveDestructuredParameterPropertyUses?.(current.text);
        if (destructuredUses) {
          appendUses(uses, destructuredUses);
        } else if (resolveDestructuredParameterProperty(current.text)) {
          uses.push(resolveDestructuredParameterProperty(current.text));
        } else {
          const index = resolveParameterIndex(current.text);
          if (index !== null) {
            uses.push({ index, propertyName: null });
          }
        }
      }
      ts.forEachChild(current, visitExpression);
    }
    visitExpression(expression);
    return uses;
  }

  function usesFilePathOptionsObject(name) {
    return (
      name === "appendRegularFile" ||
      name === "appendRegularFileSync" ||
      name === "replaceFileAtomic" ||
      name === "replaceFileAtomicSync"
    );
  }

  function parameterPropertyBindings(parameter, index) {
    if (!ts.isObjectBindingPattern(parameter.name)) {
      return new Map();
    }
    return objectBindingParameterProperties(parameter.name, index);
  }

  function bindingPatternNames(name) {
    const names = [];
    function visitName(current) {
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

  function isParameterPropertyDestructure(node, parameterIndexes) {
    return (
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      parameterIndexes.has(node.initializer.text)
    );
  }

  function objectBindingParameterProperties(bindingPattern, index, propertyPath = []) {
    const bindings = new Map();
    for (const element of bindingPattern.elements) {
      const propertyName = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (!propertyName) {
        continue;
      }
      const nextPath = [...propertyPath, propertyName];
      if (ts.isIdentifier(element.name)) {
        bindings.set(element.name.text, { index, propertyName: nextPath.join(".") });
        continue;
      }
      if (ts.isObjectBindingPattern(element.name)) {
        for (const [name, binding] of objectBindingParameterProperties(
          element.name,
          index,
          nextPath,
        )) {
          bindings.set(name, binding);
        }
      }
    }
    return bindings;
  }

  function markLegacyPathsFromObjectBinding(bindingPattern, sourceName, propertyPath = []) {
    for (const element of bindingPattern.elements) {
      const propertyName = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (!propertyName) {
        continue;
      }
      const nextPath = [...propertyPath, propertyName];
      if (ts.isIdentifier(element.name)) {
        const trackedPropertyEntry = lookupLegacyObjectPropertyEntry(
          sourceName,
          nextPath.join("."),
        );
        const usesDefaultInitializer = trackedPropertyEntry.found
          ? trackedPropertyEntry.value === explicitUndefinedLegacyObjectPropertyValue
          : trackedPropertyEntry.objectKnown;
        const trackedPropertyValue = trackedPropertyEntry.found
          ? trackedPropertyEntry.value === explicitUndefinedLegacyObjectPropertyValue
            ? null
            : trackedPropertyEntry.value === true
          : null;
        const propertyValue =
          trackedPropertyValue === null
            ? element.initializer
              ? expressionContainsLegacyStore(element.initializer)
              : false
            : trackedPropertyValue;
        currentLegacyPathScope().set(element.name.text, propertyValue);
        currentKnownUndefinedScope().set(
          element.name.text,
          usesDefaultInitializer
            ? element.initializer
              ? isKnownUndefinedExpression(element.initializer)
              : true
            : false,
        );
        const sourcePropertyName = `${sourceName}.${nextPath.join(".")}`;
        copyLegacyObjectProperties(element.name.text, sourcePropertyName);
        copyKnownLegacyObjectLiterals(element.name.text, sourcePropertyName);
        currentWrapperFunctionScope().set(
          element.name.text,
          cloneWrapperFunctionValue(resolveWrapperFunction(sourcePropertyName)),
        );
        continue;
      }
      if (ts.isObjectBindingPattern(element.name)) {
        markLegacyPathsFromObjectBinding(element.name, sourceName, nextPath);
      }
    }
  }

  function markLegacyPathsFromInlineObjectBinding(bindingPattern, initializer, propertyPath = []) {
    const sourceName = "<inline-object-binding>";
    const propertyScope = new Map();
    const knownObjectLiteralScope = new Map();
    markLegacyObjectProperties(sourceName, initializer, propertyScope, knownObjectLiteralScope);
    function visitBinding(currentBindingPattern, currentPath) {
      for (const element of currentBindingPattern.elements) {
        const propertyName = element.propertyName
          ? propertyNameText(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null;
        if (!propertyName) {
          continue;
        }
        const nextPath = [...currentPath, propertyName];
        if (ts.isIdentifier(element.name)) {
          const trackedPropertyEntry = lookupScopedLegacyObjectPropertyEntry(
            sourceName,
            nextPath,
            propertyScope,
            knownObjectLiteralScope,
          );
          const usesDefaultInitializer = trackedPropertyEntry.found
            ? trackedPropertyEntry.value === explicitUndefinedLegacyObjectPropertyValue
            : trackedPropertyEntry.objectKnown;
          const propertyValue = trackedPropertyEntry.found
            ? trackedPropertyEntry.value === explicitUndefinedLegacyObjectPropertyValue
              ? element.initializer
                ? expressionContainsLegacyStore(element.initializer)
                : false
              : trackedPropertyEntry.value === true
            : trackedPropertyEntry.objectKnown && element.initializer
              ? expressionContainsLegacyStore(element.initializer)
              : false;
          currentLegacyPathScope().set(element.name.text, propertyValue);
          currentKnownUndefinedScope().set(
            element.name.text,
            usesDefaultInitializer
              ? element.initializer
                ? isKnownUndefinedExpression(element.initializer)
                : true
              : false,
          );
          const sourcePropertyName = objectPropertyKey(sourceName, nextPath.join("."));
          copyScopedLegacyObjectProperties(element.name.text, sourcePropertyName, propertyScope);
          copyScopedKnownLegacyObjectLiterals(
            element.name.text,
            sourcePropertyName,
            knownObjectLiteralScope,
          );
          continue;
        }
        if (ts.isObjectBindingPattern(element.name)) {
          visitBinding(element.name, nextPath);
        }
      }
    }
    visitBinding(bindingPattern, propertyPath);
  }

  function markFsSafeStoresFromObjectBinding(bindingPattern, sourceName, propertyPath = []) {
    for (const element of bindingPattern.elements) {
      const propertyName = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (!propertyName) {
        continue;
      }
      const nextPath = [...propertyPath, propertyName];
      if (ts.isIdentifier(element.name)) {
        const key = `${sourceName}.${nextPath.join(".")}`;
        const trackedStore = lookupFsSafeStore(key);
        const trackedJsonStore = lookupFsSafeJsonStore(key);
        currentFsSafeStoreScope().set(
          element.name.text,
          trackedStore ??
            (element.initializer ? isFsSafeStoreExpression(element.initializer) : false),
        );
        currentFsSafeJsonStoreScope().set(
          element.name.text,
          trackedJsonStore ??
            (element.initializer
              ? expressionContainsFsSafeJsonStoreLegacyPath(element.initializer)
              : false),
        );
        continue;
      }
      if (ts.isObjectBindingPattern(element.name)) {
        markFsSafeStoresFromObjectBinding(element.name, sourceName, nextPath);
      }
    }
  }

  function markFsSafeFactoryAliasesFromObjectBinding(bindingPattern, sourceName) {
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
        currentFsSafeStoreFactoryAliasScope().set(element.name.text, factoryAlias);
      }
    }
  }

  function collectLegacyPathPropertyParameters(
    node,
    baseFsWriteAliases,
    baseFsModuleBindings,
    baseFsModuleProperties,
    baseRequireAliases,
    baseCreateRequireShadows,
    activeWrapperNodes = new Set(),
    baseNestedWrapperFunctions = null,
  ) {
    if (activeWrapperNodes.has(node)) {
      return new Map();
    }
    activeWrapperNodes.add(node);
    const parameterIndexes = new Map();
    const bodyFsWriteAliasScopes = [new Map(baseFsWriteAliases)];
    const bodyFsModuleBindingScopes = [new Map(baseFsModuleBindings)];
    const bodyFsModulePropertyScopes = [new Map(baseFsModuleProperties)];
    const bodyRequireAliasScopes = [new Map(baseRequireAliases)];
    const wrapperCreateRequireShadowScopes = [new Set(baseCreateRequireShadows)];
    const destructuredParameterPropertyScopes = [new Map()];
    const destructuredParameterPropertyMergeScopes = [new Map()];
    const parameterObjectBindingScopes = [new Map()];
    const parameterPropertyUseScopes = [new Map()];
    const conditionalDestructuredParameterPropertyScopes = [new Map()];
    const conditionalParameterObjectScopes = [new Map()];
    const conditionalParameterPropertyUseScopes = [new Map()];
    const conditionalWrapperBodyScopes = [false];
    const parameterObjectAssignmentShadowScopes = [new Set()];
    const shadowScopes = [new Set()];
    const fsAliasShadowScopes = [new Set()];
    const fsModuleShadowScopes = [new Set()];
    const wrapperRequireShadowScopes = [new Set()];
    const parameterObjectShadowScopes = [new Set()];
    const wrapperBranchEffectScopes = [];
    const rootNestedWrapperFunctionScope = new Map(baseNestedWrapperFunctions ?? []);
    const nestedWrapperFunctionScopes = [rootNestedWrapperFunctionScope];
    const nestedWrapperFunctionScopeParents = new Map([[rootNestedWrapperFunctionScope, null]]);

    function currentBodyFsWriteAliasScope() {
      return bodyFsWriteAliasScopes[bodyFsWriteAliasScopes.length - 1];
    }

    function visibleBodyFsWriteAliases() {
      const aliases = new Map();
      for (const scope of bodyFsWriteAliasScopes) {
        for (const [name, value] of scope) {
          aliases.set(name, value);
        }
      }
      return aliases;
    }

    function currentBodyFsModuleBindingScope() {
      return bodyFsModuleBindingScopes[bodyFsModuleBindingScopes.length - 1];
    }

    function visibleBodyFsModuleBindings() {
      const bindings = new Map();
      for (const scope of bodyFsModuleBindingScopes) {
        for (const [name, value] of scope) {
          bindings.set(name, value);
        }
      }
      return bindings;
    }

    function currentBodyFsModulePropertyScope() {
      return bodyFsModulePropertyScopes[bodyFsModulePropertyScopes.length - 1];
    }

    function visibleBodyFsModuleProperties() {
      const properties = new Map();
      for (const scope of bodyFsModulePropertyScopes) {
        for (const [name, value] of scope) {
          properties.set(name, value);
        }
      }
      return properties;
    }

    function currentBodyRequireAliasScope() {
      return bodyRequireAliasScopes[bodyRequireAliasScopes.length - 1];
    }

    function visibleBodyRequireAliasSnapshot() {
      const aliases = new Map();
      const sourceScopes = new Map();
      bodyRequireAliasScopes.forEach((scope, index) => {
        for (const [name, value] of scope) {
          aliases.set(name, value);
          sourceScopes.set(name, index);
        }
      });
      return { aliases, sourceScopes };
    }

    function currentDestructuredParameterPropertyScope() {
      return destructuredParameterPropertyScopes[destructuredParameterPropertyScopes.length - 1];
    }

    function currentDestructuredParameterPropertyMergeScope() {
      return destructuredParameterPropertyMergeScopes[
        destructuredParameterPropertyMergeScopes.length - 1
      ];
    }

    function currentParameterObjectBindingScope() {
      return parameterObjectBindingScopes[parameterObjectBindingScopes.length - 1];
    }

    function currentParameterPropertyUseScope() {
      return parameterPropertyUseScopes[parameterPropertyUseScopes.length - 1];
    }

    function currentConditionalDestructuredParameterPropertyScope() {
      return conditionalDestructuredParameterPropertyScopes[
        conditionalDestructuredParameterPropertyScopes.length - 1
      ];
    }

    function currentConditionalParameterObjectScope() {
      return conditionalParameterObjectScopes[conditionalParameterObjectScopes.length - 1];
    }

    function currentConditionalParameterPropertyUseScope() {
      return conditionalParameterPropertyUseScopes[
        conditionalParameterPropertyUseScopes.length - 1
      ];
    }

    function currentConditionalWrapperBodyScope() {
      return conditionalWrapperBodyScopes[conditionalWrapperBodyScopes.length - 1];
    }

    function currentShadowScope() {
      return shadowScopes[shadowScopes.length - 1];
    }

    function currentFsAliasShadowScope() {
      return fsAliasShadowScopes[fsAliasShadowScopes.length - 1];
    }

    function currentFsModuleShadowScope() {
      return fsModuleShadowScopes[fsModuleShadowScopes.length - 1];
    }

    function currentWrapperCreateRequireShadowScope() {
      return wrapperCreateRequireShadowScopes[wrapperCreateRequireShadowScopes.length - 1];
    }

    function visibleWrapperCreateRequireShadows() {
      const shadows = new Set();
      for (const scope of wrapperCreateRequireShadowScopes) {
        for (const name of scope) {
          shadows.add(name);
        }
      }
      return shadows;
    }

    function currentNestedWrapperFunctionScope() {
      return nestedWrapperFunctionScopes[nestedWrapperFunctionScopes.length - 1];
    }

    function currentParameterObjectShadowScope() {
      return parameterObjectShadowScopes[parameterObjectShadowScopes.length - 1];
    }

    function currentParameterObjectAssignmentShadowScope() {
      return parameterObjectAssignmentShadowScopes[
        parameterObjectAssignmentShadowScopes.length - 1
      ];
    }

    function currentWrapperBranchEffectScope() {
      return wrapperBranchEffectScopes[wrapperBranchEffectScopes.length - 1] ?? null;
    }

    function createWrapperBranchEffects() {
      return {
        destructuredAssignments: new Map(),
        fsIdentifierAssignments: new Map(),
        nestedWrapperAssignments: new Map(),
        nestedWrapperAssignmentScopes: new Map(),
        parameterObjectAssignments: new Map(),
        parameterPropertyAssignments: new Map(),
      };
    }

    function bindingUses(binding) {
      return binding === null || binding === undefined ? [] : [binding];
    }

    function recordWrapperBranchParameterObjectAssignment(name, objectIndex) {
      const effects = currentWrapperBranchEffectScope();
      if (effects) {
        effects.parameterObjectAssignments.set(name, bindingUses(objectIndex));
      }
    }

    function recordWrapperBranchParameterPropertyAssignment(key, binding) {
      const effects = currentWrapperBranchEffectScope();
      if (effects) {
        effects.parameterPropertyAssignments.set(key, bindingUses(binding));
      }
    }

    function recordWrapperBranchDestructuredAssignment(name, binding) {
      const effects = currentWrapperBranchEffectScope();
      if (effects) {
        effects.destructuredAssignments.set(name, bindingUses(binding));
      }
    }

    function recordWrapperBranchNestedWrapperAssignment(name, value, targetScope) {
      const effects = currentWrapperBranchEffectScope();
      if (effects) {
        clearBranchNestedWrapperObjectAssignments(effects, name);
        effects.nestedWrapperAssignments.set(name, cloneWrapperFunctionValue(value));
        effects.nestedWrapperAssignmentScopes.set(name, targetScope);
      }
    }

    function recordWrapperBranchFsIdentifierAssignment(
      name,
      moduleValue,
      writeAlias,
      requireAlias,
      moduleScope,
      writeAliasScope,
      requireAliasScope,
    ) {
      const effects = currentWrapperBranchEffectScope();
      if (effects) {
        effects.fsIdentifierAssignments.set(name, {
          moduleScope,
          moduleValue,
          name,
          requireAlias,
          requireAliasScope,
          writeAlias,
          writeAliasScope,
        });
      }
    }

    function clearBranchNestedWrapperObjectAssignments(effects, objectName) {
      const prefix = `${objectName}.`;
      for (const name of effects.nestedWrapperAssignments.keys()) {
        if (name.startsWith(prefix)) {
          effects.nestedWrapperAssignments.delete(name);
          effects.nestedWrapperAssignmentScopes.delete(name);
        }
      }
    }

    function wrapperAssignmentMergeOrder(left, right) {
      return left.split(".").length - right.split(".").length;
    }

    function mergeBindingUses(left, right) {
      return [...left, ...right];
    }

    function applyMergedParameterPropertyAssignment(key, uses) {
      currentParameterPropertyUseScope().set(key, null);
      for (const use of uses) {
        appendConditionalUse(currentConditionalParameterPropertyUseScope(), key, use);
      }
      recordWrapperBranchParameterPropertyAssignment(key, uses[0] ?? null);
      const parentEffect = currentWrapperBranchEffectScope();
      if (parentEffect && uses.length > 1) {
        parentEffect.parameterPropertyAssignments.set(key, uses);
      }
    }

    function applyMergedDestructuredAssignment(name, uses) {
      currentDestructuredParameterPropertyScope().set(name, null);
      currentDestructuredParameterPropertyMergeScope().set(name, null);
      for (const use of uses) {
        appendConditionalUse(currentConditionalDestructuredParameterPropertyScope(), name, use);
      }
      recordWrapperBranchDestructuredAssignment(name, uses[0] ?? null);
      const parentEffect = currentWrapperBranchEffectScope();
      if (parentEffect && uses.length > 1) {
        parentEffect.destructuredAssignments.set(name, uses);
      }
    }

    function applyMergedParameterObjectAssignment(name, uses) {
      if (uses.length === 0) {
        currentParameterObjectShadowScope().add(name);
        currentParameterObjectAssignmentShadowScope().add(name);
      } else {
        currentParameterObjectBindingScope().set(name, uses[0]);
        for (const use of uses.slice(1)) {
          appendConditionalUse(currentConditionalParameterObjectScope(), name, use);
        }
      }
      const parentEffect = currentWrapperBranchEffectScope();
      if (parentEffect) {
        parentEffect.parameterObjectAssignments.set(name, uses);
      }
    }

    function applyMergedNestedWrapperAssignment(name, value, targetScope = null) {
      const resolvedTargetScope = targetScope ?? nestedWrapperFunctionWriteScope(name);
      if (!resolvedTargetScope) {
        return;
      }
      clearNestedWrapperObjectMethods(resolvedTargetScope, name);
      resolvedTargetScope.set(name, cloneWrapperFunctionValue(value));
      const parentEffect = currentWrapperBranchEffectScope();
      if (parentEffect) {
        parentEffect.nestedWrapperAssignments.set(name, cloneWrapperFunctionValue(value));
        parentEffect.nestedWrapperAssignmentScopes.set(name, resolvedTargetScope);
      }
    }

    function applyMergedFsIdentifierAssignment(thenAssignment, elseAssignment) {
      const { name } = thenAssignment;
      const moduleScope =
        thenAssignment.moduleScope === elseAssignment.moduleScope
          ? thenAssignment.moduleScope
          : null;
      const writeAliasScope =
        thenAssignment.writeAliasScope === elseAssignment.writeAliasScope
          ? thenAssignment.writeAliasScope
          : null;
      const requireAliasScope =
        thenAssignment.requireAliasScope === elseAssignment.requireAliasScope
          ? thenAssignment.requireAliasScope
          : null;
      const moduleValue =
        thenAssignment.moduleValue === true || elseAssignment.moduleValue === true;
      const writeAlias = thenAssignment.writeAlias ?? elseAssignment.writeAlias;
      const requireAlias =
        thenAssignment.requireAlias === true || elseAssignment.requireAlias === true;
      if (moduleScope && bodyFsModuleBindingScopes.includes(moduleScope)) {
        moduleScope.set(name, moduleValue);
      }
      if (writeAliasScope && bodyFsWriteAliasScopes.includes(writeAliasScope)) {
        writeAliasScope.set(name, writeAlias);
      }
      if (requireAliasScope && bodyRequireAliasScopes.includes(requireAliasScope)) {
        requireAliasScope.set(name, requireAlias);
      }
      refreshCurrentNestedWrapperFunctionAliases();
      const parentEffect = currentWrapperBranchEffectScope();
      if (parentEffect) {
        parentEffect.fsIdentifierAssignments.set(name, {
          moduleScope,
          moduleValue,
          name,
          requireAlias,
          requireAliasScope,
          writeAlias,
          writeAliasScope,
        });
      }
    }

    function mergeExhaustiveWrapperBranchEffects(thenEffects, elseEffects) {
      for (const [name, thenAssignment] of thenEffects.fsIdentifierAssignments) {
        const elseAssignment = elseEffects.fsIdentifierAssignments.get(name);
        if (elseAssignment) {
          applyMergedFsIdentifierAssignment(thenAssignment, elseAssignment);
        }
      }
      for (const [key, thenUses] of thenEffects.parameterPropertyAssignments) {
        const elseUses = elseEffects.parameterPropertyAssignments.get(key);
        if (elseUses) {
          applyMergedParameterPropertyAssignment(key, mergeBindingUses(thenUses, elseUses));
        }
      }
      for (const [name, thenUses] of thenEffects.destructuredAssignments) {
        const elseUses = elseEffects.destructuredAssignments.get(name);
        if (elseUses) {
          applyMergedDestructuredAssignment(name, mergeBindingUses(thenUses, elseUses));
        }
      }
      for (const [name, thenUses] of thenEffects.parameterObjectAssignments) {
        const elseUses = elseEffects.parameterObjectAssignments.get(name);
        if (elseUses) {
          applyMergedParameterObjectAssignment(name, mergeBindingUses(thenUses, elseUses));
        }
      }
      const nestedWrapperAssignmentNames = new Set([
        ...thenEffects.nestedWrapperAssignments.keys(),
        ...elseEffects.nestedWrapperAssignments.keys(),
      ]);
      for (const name of [...nestedWrapperAssignmentNames].toSorted(wrapperAssignmentMergeOrder)) {
        const thenScope = thenEffects.nestedWrapperAssignmentScopes.get(name);
        const elseScope = elseEffects.nestedWrapperAssignmentScopes.get(name);
        const targetScope = thenScope ?? elseScope;
        if (
          targetScope === undefined ||
          (thenScope !== undefined && elseScope !== undefined && thenScope !== elseScope) ||
          !nestedWrapperFunctionScopes.includes(targetScope)
        ) {
          continue;
        }
        const previousValue = targetScope.get(name);
        applyMergedNestedWrapperAssignment(
          name,
          mergeWrapperAssignmentValues(
            thenEffects.nestedWrapperAssignments.has(name)
              ? thenEffects.nestedWrapperAssignments.get(name)
              : previousValue,
            elseEffects.nestedWrapperAssignments.has(name)
              ? elseEffects.nestedWrapperAssignments.get(name)
              : previousValue,
          ),
          targetScope,
        );
      }
    }

    function resolveParameterIndex(name) {
      for (let index = parameterObjectShadowScopes.length - 1; index >= 0; index--) {
        if (parameterObjectShadowScopes[index].has(name)) {
          return null;
        }
        if (parameterObjectBindingScopes[index].has(name)) {
          return parameterObjectBindingScopes[index].get(name);
        }
      }
      return parameterIndexes.has(name) ? parameterIndexes.get(name) : null;
    }

    function resolveDestructuredParameterProperty(name) {
      for (let index = destructuredParameterPropertyScopes.length - 1; index >= 0; index--) {
        if (shadowScopes[index].has(name)) {
          return null;
        }
        if (destructuredParameterPropertyScopes[index].has(name)) {
          return destructuredParameterPropertyScopes[index].get(name);
        }
      }
      return null;
    }

    function appendConditionalUse(scope, key, value) {
      const values = scope.get(key) ?? [];
      values.push(value);
      scope.set(key, values);
    }

    function conditionalUsesFor(key, scopes) {
      const uses = [];
      for (const scope of scopes) {
        uses.push(...(scope.get(key) ?? []));
      }
      return uses;
    }

    function conditionalObjectPropertyUses(objectName, propertyName) {
      const uses = [];
      for (const scope of conditionalParameterObjectScopes) {
        for (const index of scope.get(objectName) ?? []) {
          uses.push({ index, propertyName });
        }
      }
      return uses;
    }

    function resolveParameterPropertyUse(objectName, propertyName) {
      const key = `${objectName}.${propertyName}`;
      let baseUse = undefined;
      for (let index = parameterPropertyUseScopes.length - 1; index >= 0; index--) {
        if (parameterObjectShadowScopes[index].has(objectName)) {
          return null;
        }
        if (parameterPropertyUseScopes[index].has(key)) {
          baseUse = parameterPropertyUseScopes[index].get(key);
          break;
        }
      }
      const extraUses = [
        ...conditionalUsesFor(key, conditionalParameterPropertyUseScopes),
        ...conditionalObjectPropertyUses(objectName, propertyName),
      ];
      if (extraUses.length === 0) {
        return baseUse;
      }
      if (baseUse === null) {
        return extraUses;
      }
      const fallbackIndex = resolveParameterIndex(objectName);
      const baseUses = baseUse
        ? [baseUse]
        : fallbackIndex !== null
          ? [{ index: fallbackIndex, propertyName }]
          : [];
      return [...baseUses, ...extraUses];
    }

    function resolveDestructuredParameterPropertyUses(name) {
      const baseUse = resolveDestructuredParameterProperty(name);
      const extraUses = conditionalUsesFor(name, conditionalDestructuredParameterPropertyScopes);
      if (extraUses.length === 0) {
        return baseUse;
      }
      return baseUse ? [baseUse, ...extraUses] : extraUses;
    }

    function resolveParameterPropertyBinding(expression) {
      const unwrapped = unwrapExpression(expression);
      const propertyAccess = rootedPropertyAccessPath(unwrapped);
      if (propertyAccess?.properties.length > 0) {
        const index = resolveParameterIndex(propertyAccess.rootName);
        if (index !== null) {
          return {
            index,
            propertyName: propertyAccess.properties.join("."),
          };
        }
      }
      if (ts.isIdentifier(unwrapped)) {
        return resolveDestructuredParameterProperty(unwrapped.text);
      }
      return null;
    }

    function resolveParameterObjectBindingExpression(expression) {
      const unwrapped = unwrapExpression(expression);
      return ts.isIdentifier(unwrapped) ? resolveParameterIndex(unwrapped.text) : null;
    }

    function collectForwardedWrapperPropertyUses(
      argument,
      propertyName,
      parameter = null,
      wrapperNode = null,
      argumentsList = [],
      options = {},
    ) {
      if (propertyName === null) {
        return collectPathPropertyUses(
          argument,
          "writeFile",
          resolveParameterIndex,
          resolveDestructuredParameterProperty,
          resolveParameterPropertyUse,
          resolveDestructuredParameterPropertyUses,
        );
      }
      const propertyPath = propertyName.split(".");
      function collectWrapperBindingDefaultUses(sourceExpression) {
        if (!parameter || !ts.isObjectBindingPattern(parameter.name)) {
          return [];
        }
        const initializer = appliedBindingElementDefaultInitializer(
          parameter.name,
          propertyPath,
          sourceExpression,
          nestedWrapperObjectLiteralSpreadPropertyState,
        );
        const defaultExpression = initializer
          ? resolveBindingDefaultInitializerExpression(
              initializer,
              wrapperNode,
              argumentsList,
              parameter,
              options,
            )
          : null;
        return defaultExpression
          ? collectPathPropertyUses(
              defaultExpression,
              "writeFile",
              resolveParameterIndex,
              resolveDestructuredParameterProperty,
              resolveParameterPropertyUse,
              resolveDestructuredParameterPropertyUses,
            )
          : [];
      }
      function collectForwardedWrapperPropertyUseState(currentArgument, currentPropertyPath) {
        const currentUnwrapped = unwrapExpression(currentArgument);
        const currentPropertyName = currentPropertyPath.join(".");
        if (ts.isIdentifier(currentUnwrapped)) {
          const index = resolveParameterIndex(currentUnwrapped.text);
          if (index !== null) {
            const propertyUse = resolveParameterPropertyUse(
              currentUnwrapped.text,
              currentPropertyName,
            );
            return propertyUse === null
              ? []
              : [propertyUse ?? { index, propertyName: currentPropertyName }];
          }
          return null;
        }
        if (ts.isObjectLiteralExpression(currentUnwrapped)) {
          let result = null;
          for (const property of currentUnwrapped.properties) {
            if (ts.isSpreadAssignment(property)) {
              const spreadUses = collectForwardedWrapperPropertyUseState(
                property.expression,
                currentPropertyPath,
              );
              if (spreadUses !== null) {
                result = spreadUses;
              }
              continue;
            }
            const [nextPropertyName, ...remainingPropertyPath] = currentPropertyPath;
            if (
              ts.isPropertyAssignment(property) &&
              propertyNameText(property.name) === nextPropertyName
            ) {
              if (isKnownUndefinedExpression(property.initializer)) {
                result = null;
                continue;
              }
              if (remainingPropertyPath.length > 0) {
                result = collectForwardedWrapperPropertyUseState(
                  property.initializer,
                  remainingPropertyPath,
                );
                continue;
              }
              result = collectPathPropertyUses(
                property.initializer,
                "writeFile",
                resolveParameterIndex,
                resolveDestructuredParameterProperty,
                resolveParameterPropertyUse,
                resolveDestructuredParameterPropertyUses,
              );
              continue;
            }
            if (
              remainingPropertyPath.length === 0 &&
              ts.isShorthandPropertyAssignment(property) &&
              property.name.text === nextPropertyName
            ) {
              result = collectPathPropertyUses(
                property.name,
                "writeFile",
                resolveParameterIndex,
                resolveDestructuredParameterProperty,
                resolveParameterPropertyUse,
                resolveDestructuredParameterPropertyUses,
              );
            }
            if (
              remainingPropertyPath.length > 0 &&
              ts.isShorthandPropertyAssignment(property) &&
              property.name.text === nextPropertyName
            ) {
              result = collectForwardedWrapperPropertyUseState(
                property.name,
                remainingPropertyPath,
              );
            }
          }
          return result;
        }
        const uses = collectPathPropertyUses(
          currentArgument,
          "writeFile",
          resolveParameterIndex,
          resolveDestructuredParameterProperty,
          resolveParameterPropertyUse,
          resolveDestructuredParameterPropertyUses,
        );
        return uses.length > 0 ? uses : null;
      }
      const unwrapped = unwrapExpression(argument);
      if (ts.isIdentifier(unwrapped)) {
        const index = resolveParameterIndex(unwrapped.text);
        if (index !== null) {
          const propertyUse = resolveParameterPropertyUse(unwrapped.text, propertyName);
          return propertyUse === null ? [] : [propertyUse ?? { index, propertyName }];
        }
      }
      if (ts.isObjectLiteralExpression(unwrapped)) {
        return (
          collectForwardedWrapperPropertyUseState(unwrapped, propertyPath) ??
          collectWrapperBindingDefaultUses(unwrapped)
        );
      }
      return collectPathPropertyUses(
        argument,
        "writeFile",
        resolveParameterIndex,
        resolveDestructuredParameterProperty,
        resolveParameterPropertyUse,
        resolveDestructuredParameterPropertyUses,
      );
    }

    function markParameterAssignment(assignmentNode) {
      if (
        !ts.isBinaryExpression(assignmentNode) ||
        assignmentNode.operatorToken.kind !== ts.SyntaxKind.EqualsToken
      ) {
        return;
      }
      if (ts.isIdentifier(assignmentNode.left)) {
        if (resolveParameterIndex(assignmentNode.left.text) !== null) {
          const objectIndex = resolveParameterObjectBindingExpression(assignmentNode.right);
          if (currentConditionalWrapperBodyScope()) {
            recordWrapperBranchParameterObjectAssignment(assignmentNode.left.text, objectIndex);
            if (objectIndex !== null) {
              appendConditionalUse(
                currentConditionalParameterObjectScope(),
                assignmentNode.left.text,
                objectIndex,
              );
            }
          } else if (objectIndex !== null) {
            currentParameterObjectBindingScope().set(assignmentNode.left.text, objectIndex);
          } else {
            currentParameterObjectShadowScope().add(assignmentNode.left.text);
            currentParameterObjectAssignmentShadowScope().add(assignmentNode.left.text);
          }
        }
        if (resolveDestructuredParameterProperty(assignmentNode.left.text)) {
          const binding = resolveParameterPropertyBinding(assignmentNode.right);
          if (currentConditionalWrapperBodyScope()) {
            recordWrapperBranchDestructuredAssignment(assignmentNode.left.text, binding);
            if (binding) {
              appendConditionalUse(
                currentConditionalDestructuredParameterPropertyScope(),
                assignmentNode.left.text,
                binding,
              );
            }
          } else {
            const updatesOuterBinding = !currentDestructuredParameterPropertyScope().has(
              assignmentNode.left.text,
            );
            currentDestructuredParameterPropertyScope().set(assignmentNode.left.text, binding);
            if (updatesOuterBinding) {
              currentDestructuredParameterPropertyMergeScope().set(
                assignmentNode.left.text,
                binding,
              );
            }
          }
        }
        return;
      }
      const propertyAccess = rootedPropertyAccessPath(assignmentNode.left);
      if (
        propertyAccess?.properties.length > 0 &&
        resolveParameterIndex(propertyAccess.rootName) !== null
      ) {
        const binding = resolveParameterPropertyBinding(assignmentNode.right);
        const key = `${propertyAccess.rootName}.${propertyAccess.properties.join(".")}`;
        if (currentConditionalWrapperBodyScope()) {
          recordWrapperBranchParameterPropertyAssignment(key, binding);
          if (binding) {
            appendConditionalUse(currentConditionalParameterPropertyUseScope(), key, binding);
          }
        } else {
          currentParameterPropertyUseScope().set(key, binding);
        }
      }
    }

    function mergeConditionalUses(source, target) {
      for (const [key, uses] of source) {
        for (const use of uses) {
          appendConditionalUse(target, key, use);
        }
      }
    }

    function mergeMapEntries(source, target) {
      for (const [key, value] of source) {
        target.set(key, value);
      }
    }

    function mergeParameterObjectBindings(source, target) {
      for (const [key, value] of source) {
        if (parameterIndexes.has(key)) {
          target.set(key, value);
        }
      }
    }

    function pushWrapperBodyScope(
      conditional = currentConditionalWrapperBodyScope(),
      branchEffects = null,
    ) {
      bodyFsWriteAliasScopes.push(new Map());
      bodyFsModuleBindingScopes.push(new Map());
      bodyFsModulePropertyScopes.push(new Map());
      destructuredParameterPropertyScopes.push(new Map());
      destructuredParameterPropertyMergeScopes.push(new Map());
      parameterObjectBindingScopes.push(new Map());
      parameterPropertyUseScopes.push(new Map());
      conditionalDestructuredParameterPropertyScopes.push(new Map());
      conditionalParameterObjectScopes.push(new Map());
      conditionalParameterPropertyUseScopes.push(new Map());
      conditionalWrapperBodyScopes.push(conditional);
      shadowScopes.push(new Set());
      fsAliasShadowScopes.push(new Set());
      fsModuleShadowScopes.push(new Set());
      wrapperRequireShadowScopes.push(new Set());
      wrapperCreateRequireShadowScopes.push(new Set());
      bodyRequireAliasScopes.push(new Map());
      parameterObjectShadowScopes.push(new Set());
      parameterObjectAssignmentShadowScopes.push(new Set());
      wrapperBranchEffectScopes.push(branchEffects);
      const nestedWrapperFunctionScope = new Map();
      nestedWrapperFunctionScopeParents.set(
        nestedWrapperFunctionScope,
        currentNestedWrapperFunctionScope(),
      );
      nestedWrapperFunctionScopes.push(nestedWrapperFunctionScope);
    }

    function popWrapperBodyScope() {
      nestedWrapperFunctionScopes.pop();
      wrapperBranchEffectScopes.pop();
      const parameterObjectAssignmentShadows = parameterObjectAssignmentShadowScopes.pop();
      parameterObjectShadowScopes.pop();
      wrapperRequireShadowScopes.pop();
      wrapperCreateRequireShadowScopes.pop();
      bodyRequireAliasScopes.pop();
      fsModuleShadowScopes.pop();
      fsAliasShadowScopes.pop();
      shadowScopes.pop();
      const parameterPropertyUses = conditionalParameterPropertyUseScopes.pop();
      const parameterObjectUses = conditionalParameterObjectScopes.pop();
      const destructuredUses = conditionalDestructuredParameterPropertyScopes.pop();
      const wasConditional = conditionalWrapperBodyScopes.pop();
      const directParameterPropertyUses = parameterPropertyUseScopes.pop();
      const directParameterObjectBindings = parameterObjectBindingScopes.pop();
      destructuredParameterPropertyScopes.pop();
      const directDestructuredBindings = destructuredParameterPropertyMergeScopes.pop();
      if (wasConditional) {
        mergeConditionalUses(parameterPropertyUses, currentConditionalParameterPropertyUseScope());
        mergeConditionalUses(parameterObjectUses, currentConditionalParameterObjectScope());
        mergeConditionalUses(
          destructuredUses,
          currentConditionalDestructuredParameterPropertyScope(),
        );
      } else {
        mergeMapEntries(directParameterPropertyUses, currentParameterPropertyUseScope());
        mergeParameterObjectBindings(
          directParameterObjectBindings,
          currentParameterObjectBindingScope(),
        );
        for (const name of parameterObjectAssignmentShadows) {
          currentParameterObjectShadowScope().add(name);
          currentParameterObjectAssignmentShadowScope().add(name);
        }
        mergeMapEntries(directDestructuredBindings, currentDestructuredParameterPropertyScope());
      }
      bodyFsModuleBindingScopes.pop();
      bodyFsModulePropertyScopes.pop();
      bodyFsWriteAliasScopes.pop();
    }

    function resolveBodyFsWriteAlias(name) {
      for (let index = bodyFsWriteAliasScopes.length - 1; index >= 0; index--) {
        const scope = bodyFsWriteAliasScopes[index];
        if (scope.has(name)) {
          return scope.get(name) ?? null;
        }
      }
      return null;
    }

    function resolveBodyFsModuleBinding(name) {
      for (let index = bodyFsModuleBindingScopes.length - 1; index >= 0; index--) {
        const scope = bodyFsModuleBindingScopes[index];
        if (scope.has(name)) {
          return scope.get(name) === true;
        }
      }
      return false;
    }

    function resolveBodyFsModuleProperty(pathParts) {
      const fullPath = pathParts.join(".");
      const prefixes = pathParts.map((_, index) => pathParts.slice(0, index + 1).join("."));
      for (let index = bodyFsModulePropertyScopes.length - 1; index >= 0; index--) {
        const scope = bodyFsModulePropertyScopes[index];
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

    function isFsModuleShadowed(name) {
      for (let index = fsModuleShadowScopes.length - 1; index >= 0; index--) {
        if (fsModuleShadowScopes[index].has(name)) {
          return true;
        }
      }
      return false;
    }

    function isWrapperRequireName(name) {
      return resolveBodyRequireAlias(name);
    }

    function markWrapperRequireShadows(name) {
      for (const bindingName of bindingPatternNames(name)) {
        if (
          bindingName === "require" ||
          resolveBodyRequireAlias(bindingName) ||
          resolveRequireAlias(bindingName)
        ) {
          wrapperRequireShadowScopes[wrapperRequireShadowScopes.length - 1].add(bindingName);
        }
        currentBodyRequireAliasScope().set(bindingName, false);
      }
    }

    function isWrapperCreateRequireShadowed(name) {
      return wrapperCreateRequireShadowScopes.some((scope) => scope.has(name));
    }

    function isWrapperCreateRequireExpression(expression) {
      const call = unwrapExpression(expression);
      return (
        ts.isCallExpression(call) &&
        ts.isIdentifier(unwrapExpression(call.expression)) &&
        createRequireBindings.has(unwrapExpression(call.expression).text) &&
        !isWrapperCreateRequireShadowed(unwrapExpression(call.expression).text)
      );
    }

    function isWrapperRequireAliasExpression(expression) {
      const value = unwrapExpression(expression);
      return (
        isWrapperCreateRequireExpression(value) ||
        (ts.isIdentifier(value) && resolveBodyRequireAlias(value.text))
      );
    }

    function markWrapperCreateRequireShadows(name) {
      for (const bindingName of bindingPatternNames(name)) {
        if (createRequireBindings.has(bindingName)) {
          currentWrapperCreateRequireShadowScope().add(bindingName);
        }
      }
    }

    function resolveBodyRequireAlias(name) {
      for (let index = bodyRequireAliasScopes.length - 1; index >= 0; index--) {
        const scope = bodyRequireAliasScopes[index];
        if (scope.has(name)) {
          return scope.get(name) === true;
        }
      }
      return false;
    }

    function bodyFsWriteAliasWriteScope(name) {
      for (let index = bodyFsWriteAliasScopes.length - 1; index >= 0; index--) {
        const scope = bodyFsWriteAliasScopes[index];
        if (scope.has(name)) {
          return scope;
        }
      }
      return currentBodyFsWriteAliasScope();
    }

    function bodyFsModuleBindingWriteScope(name) {
      for (let index = bodyFsModuleBindingScopes.length - 1; index >= 0; index--) {
        const scope = bodyFsModuleBindingScopes[index];
        if (scope.has(name)) {
          return scope;
        }
      }
      return currentBodyFsModuleBindingScope();
    }

    function bodyRequireAliasWriteScope(name) {
      for (let index = bodyRequireAliasScopes.length - 1; index >= 0; index--) {
        const scope = bodyRequireAliasScopes[index];
        if (scope.has(name)) {
          return scope;
        }
      }
      return currentBodyRequireAliasScope();
    }

    function shadowVisibleBodyFsWriteObjectAliases(objectName) {
      const prefix = `${objectName}.`;
      const currentScope = currentBodyFsWriteAliasScope();
      for (const scope of bodyFsWriteAliasScopes) {
        for (const name of scope.keys()) {
          if (name.startsWith(prefix)) {
            currentScope.set(name, null);
          }
        }
      }
    }

    function clearBodyFsWriteObjectAliases(scope, objectName) {
      const prefix = `${objectName}.`;
      for (const name of scope.keys()) {
        if (name.startsWith(prefix)) {
          scope.set(name, null);
        }
      }
    }

    function setBodyFsWriteObjectAlias(scope, name, writeName) {
      scope.set(name, writeName ?? null);
    }

    function registerBodyFsWriteObjectAliases(
      objectName,
      initializer,
      scope = currentBodyFsWriteAliasScope(),
    ) {
      const objectLiteral = unwrapExpression(initializer);
      if (!ts.isObjectLiteralExpression(objectLiteral)) {
        return;
      }
      for (const property of objectLiteral.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = propertyNameText(property.name);
          if (name) {
            setBodyFsWriteObjectAlias(
              scope,
              `${objectName}.${name}`,
              legacyWrapperFsWriteName(property.initializer),
            );
          }
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          setBodyFsWriteObjectAlias(
            scope,
            `${objectName}.${property.name.text}`,
            resolveBodyFsWriteAlias(property.name.text),
          );
        }
      }
    }

    function isWrapperFsBindingExpression(expression) {
      const initializer = unwrapExpression(expression);
      if (
        isFsRequireExpression(initializer, isWrapperRequireName) ||
        isFsDynamicImportExpression(initializer)
      ) {
        return true;
      }
      if (ts.isIdentifier(initializer)) {
        return (
          !isFsModuleShadowed(initializer.text) && resolveBodyFsModuleBinding(initializer.text)
        );
      }
      return (
        ts.isPropertyAccessExpression(initializer) &&
        initializer.name.text === "promises" &&
        (isFsRequireExpression(initializer.expression, isWrapperRequireName) ||
          isFsDynamicImportExpression(initializer.expression) ||
          (ts.isIdentifier(initializer.expression) &&
            !isFsModuleShadowed(initializer.expression.text) &&
            resolveBodyFsModuleBinding(initializer.expression.text)))
      );
    }

    function isFsAliasShadowed(name) {
      for (let index = fsAliasShadowScopes.length - 1; index >= 0; index--) {
        if (fsAliasShadowScopes[index].has(name)) {
          return true;
        }
      }
      return false;
    }

    function isWrapperFsModuleExpression(expression) {
      const receiver = unwrapExpression(expression);
      if (
        isFsRequireExpression(receiver, isWrapperRequireName) ||
        isFsDynamicImportExpression(receiver)
      ) {
        return true;
      }
      if (ts.isIdentifier(receiver)) {
        return !isFsModuleShadowed(receiver.text) && resolveBodyFsModuleBinding(receiver.text);
      }
      const receiverPath = propertyAccessPath(receiver);
      if (receiverPath && resolveBodyFsModuleProperty(receiverPath)) {
        return true;
      }
      return (
        ts.isPropertyAccessExpression(receiver) &&
        receiver.name.text === "promises" &&
        (isFsRequireExpression(receiver.expression, isWrapperRequireName) ||
          isFsDynamicImportExpression(receiver.expression) ||
          (ts.isIdentifier(receiver.expression) &&
            !isFsModuleShadowed(receiver.expression.text) &&
            resolveBodyFsModuleBinding(receiver.expression.text)) ||
          (propertyAccessPath(receiver.expression) &&
            resolveBodyFsModuleProperty(propertyAccessPath(receiver.expression))))
      );
    }

    function legacyWrapperFsWriteName(expression) {
      const callee = unwrapExpression(expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const aliasedName = callExpressionName(callee);
        const writeAlias =
          aliasedName && !isFsAliasShadowed(aliasedName)
            ? resolveBodyFsWriteAlias(aliasedName)
            : null;
        if (writeAlias) {
          return writeAlias;
        }
        return legacyWriteCallees.has(callee.name.text) &&
          isWrapperFsModuleExpression(callee.expression)
          ? callee.name.text
          : null;
      }
      if (ts.isElementAccessExpression(callee)) {
        const aliasedName = callExpressionName(callee);
        const writeAlias =
          aliasedName && !isFsAliasShadowed(aliasedName)
            ? resolveBodyFsWriteAlias(aliasedName)
            : null;
        if (writeAlias) {
          return writeAlias;
        }
        const writeName = elementAccessName(callee.argumentExpression);
        return writeName &&
          legacyWriteCallees.has(writeName) &&
          isWrapperFsModuleExpression(callee.expression)
          ? writeName
          : null;
      }
      if (ts.isIdentifier(callee) && isFsAliasShadowed(callee.text)) {
        return null;
      }
      return ts.isIdentifier(callee) ? resolveBodyFsWriteAlias(callee.text) : null;
    }

    function markFsAliasShadows(name) {
      for (const bindingName of bindingPatternNames(name)) {
        if (resolveBodyFsWriteAlias(bindingName)) {
          currentFsAliasShadowScope().add(bindingName);
        }
      }
    }

    function markFsModuleShadows(name) {
      for (const bindingName of bindingPatternNames(name)) {
        if (resolveBodyFsModuleBinding(bindingName)) {
          currentFsModuleShadowScope().add(bindingName);
          currentBodyFsModuleBindingScope().set(bindingName, false);
        }
        currentBodyFsModulePropertyScope().set(bindingName, false);
      }
    }

    function registerBodyFsModuleTypeProperties(name, type) {
      if (!ts.isIdentifier(name) || !type) {
        return;
      }
      if (isFsModuleTypeNode(type)) {
        currentBodyFsModuleBindingScope().set(name.text, true);
      }
      for (const pathParts of fsModulePropertyPathsFromType(type)) {
        currentBodyFsModulePropertyScope().set([name.text, ...pathParts].join("."), true);
      }
    }

    node.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        parameterIndexes.set(parameter.name.text, index);
      }
      for (const bindingName of bindingPatternNames(parameter.name)) {
        currentNestedWrapperFunctionScope().set(bindingName, null);
      }
      markFsAliasShadows(parameter.name);
      markFsModuleShadows(parameter.name);
      markWrapperRequireShadows(parameter.name);
      markWrapperCreateRequireShadows(parameter.name);
      registerBodyFsModuleTypeProperties(parameter.name, parameter.type);
      for (const [name, binding] of parameterPropertyBindings(parameter, index)) {
        currentDestructuredParameterPropertyScope().set(name, binding);
      }
    });

    const propertyUses = new Map();

    function nestedWrapperRecordForNode(nestedNode) {
      const requireAliasSnapshot = visibleBodyRequireAliasSnapshot();
      return {
        aliases: visibleBodyFsWriteAliases(),
        closesOverCurrentWrapper: true,
        createRequireShadows: visibleWrapperCreateRequireShadows(),
        lexicalScope: currentNestedWrapperFunctionScope(),
        moduleBindings: visibleBodyFsModuleBindings(),
        moduleProperties: visibleBodyFsModuleProperties(),
        node: nestedNode,
        requireAliases: requireAliasSnapshot.aliases,
        requireAliasSourceScopes: requireAliasSnapshot.sourceScopes,
      };
    }

    function resolveNestedWrapperFunction(name) {
      for (let index = nestedWrapperFunctionScopes.length - 1; index >= 0; index--) {
        const scope = nestedWrapperFunctionScopes[index];
        if (scope.has(name)) {
          return scope.get(name);
        }
      }
      return undefined;
    }

    function isNestedWrapperScopeDescendant(scope, ancestor) {
      let current = scope;
      while (current) {
        if (current === ancestor) {
          return true;
        }
        current = nestedWrapperFunctionScopeParents.get(current) ?? null;
      }
      return false;
    }

    function refreshCurrentNestedWrapperFunctionAliases() {
      const aliases = visibleBodyFsWriteAliases();
      const moduleBindings = visibleBodyFsModuleBindings();
      const moduleProperties = visibleBodyFsModuleProperties();
      const requireAliasSnapshot = visibleBodyRequireAliasSnapshot();
      const createRequireShadows = visibleWrapperCreateRequireShadows();
      const currentLexicalScope = currentNestedWrapperFunctionScope();
      function refreshNestedWrapperRecord(record) {
        if (!isNestedWrapperScopeDescendant(record.lexicalScope, currentLexicalScope)) {
          return;
        }
        if (record.lexicalScope === currentLexicalScope) {
          record.aliases = aliases;
          record.moduleBindings = moduleBindings;
          record.moduleProperties = moduleProperties;
          record.requireAliases = requireAliasSnapshot.aliases;
          record.requireAliasSourceScopes = requireAliasSnapshot.sourceScopes;
          record.createRequireShadows = createRequireShadows;
          return;
        }
        record.aliases = new Map([...aliases, ...record.aliases]);
        record.moduleBindings = new Map([...moduleBindings, ...record.moduleBindings]);
        record.moduleProperties = new Map([...moduleProperties, ...record.moduleProperties]);
        record.requireAliases = new Map([
          ...requireAliasSnapshot.aliases,
          ...record.requireAliases,
        ]);
        record.requireAliasSourceScopes = new Map([
          ...requireAliasSnapshot.sourceScopes,
          ...record.requireAliasSourceScopes,
        ]);
        record.createRequireShadows = new Set([
          ...createRequireShadows,
          ...record.createRequireShadows,
        ]);
      }
      function refreshNestedWrapperRecords(values) {
        for (const value of values) {
          for (const record of wrapperRecords(value)) {
            refreshNestedWrapperRecord(record);
          }
        }
      }
      for (const scope of nestedWrapperFunctionScopes) {
        refreshNestedWrapperRecords(scope.values());
      }
      const branchEffects = currentWrapperBranchEffectScope();
      if (branchEffects) {
        refreshNestedWrapperRecords(branchEffects.nestedWrapperAssignments.values());
      }
    }

    function nestedWrapperFunctionWriteScope(name) {
      for (let index = nestedWrapperFunctionScopes.length - 1; index >= 0; index--) {
        const scope = nestedWrapperFunctionScopes[index];
        if (scope.has(name)) {
          return scope;
        }
      }
      return currentNestedWrapperFunctionScope();
    }

    function nestedWrapperObjectMethodWriteScope(objectName, propertyName) {
      const key = objectPropertyKey(objectName, propertyName);
      for (let index = nestedWrapperFunctionScopes.length - 1; index >= 0; index--) {
        const scope = nestedWrapperFunctionScopes[index];
        if (scope.has(key) || scope.has(objectName)) {
          return scope;
        }
      }
      return currentNestedWrapperFunctionScope();
    }

    function markNestedWrapperFunctionShadows(name) {
      for (const bindingName of bindingPatternNames(name)) {
        currentNestedWrapperFunctionScope().set(bindingName, null);
      }
    }

    function clearNestedWrapperObjectMethods(scope, objectName) {
      const prefix = `${objectName}.`;
      for (const name of scope.keys()) {
        if (name.startsWith(prefix)) {
          scope.set(name, null);
        }
      }
    }

    function shadowVisibleNestedWrapperObjectMethods(objectName) {
      const prefix = `${objectName}.`;
      const currentScope = currentNestedWrapperFunctionScope();
      for (const scope of nestedWrapperFunctionScopes) {
        for (const name of scope.keys()) {
          if (name.startsWith(prefix)) {
            currentScope.set(name, null);
          }
        }
      }
    }

    function markNestedWrapperObjectUnknown(
      objectName,
      scope = currentNestedWrapperFunctionScope(),
      recordBranchAssignments = false,
      recordBranchAssignmentScope = scope,
    ) {
      clearNestedWrapperObjectMethods(scope, objectName);
      scope.set(objectName, unknownNestedWrapperObjectValue);
      if (recordBranchAssignments) {
        recordWrapperBranchNestedWrapperAssignment(
          objectName,
          unknownNestedWrapperObjectValue,
          recordBranchAssignmentScope,
        );
      }
    }

    function copyNestedWrapperObjectMethods(
      targetName,
      sourceName,
      scope = currentNestedWrapperFunctionScope(),
      recordBranchAssignments = false,
      recordBranchAssignmentScope = scope,
    ) {
      const copiedMethods = new Map();
      const sourcePrefix = `${sourceName}.`;
      for (const sourceScope of nestedWrapperFunctionScopes) {
        for (const [name, value] of sourceScope) {
          if (!name.startsWith(sourcePrefix)) {
            continue;
          }
          const key = `${targetName}.${name.slice(sourcePrefix.length)}`;
          const copiedValue = cloneWrapperFunctionValue(value);
          scope.set(key, copiedValue);
          copiedMethods.set(key, copiedValue);
          if (recordBranchAssignments) {
            recordWrapperBranchNestedWrapperAssignment(
              key,
              copiedValue,
              recordBranchAssignmentScope,
            );
          }
        }
      }
      return copiedMethods;
    }

    function isKnownNestedWrapperObjectSource(sourceName) {
      const source = resolveNestedWrapperBindingValue(sourceName);
      return source.found && source.value === knownObjectLiteralNestedWrapperValue;
    }

    function resolveNestedWrapperValue(name) {
      const nestedWrapper = resolveNestedWrapperFunction(name);
      return nestedWrapper === undefined ? resolveWrapperFunction(name) : nestedWrapper;
    }

    function resolveNestedWrapperBindingValue(name) {
      for (let index = nestedWrapperFunctionScopes.length - 1; index >= 0; index--) {
        const scope = nestedWrapperFunctionScopes[index];
        if (scope.has(name)) {
          return { found: true, value: scope.get(name) };
        }
      }
      for (let index = wrapperFunctionScopes.length - 1; index >= 0; index--) {
        const scope = wrapperFunctionScopes[index];
        if (scope.has(name)) {
          return { found: true, value: scope.get(name) };
        }
      }
      return { found: false, value: null };
    }

    function resolveNestedWrapperExpression(expression) {
      const unwrapped = unwrapExpression(expression);
      if (ts.isIdentifier(unwrapped)) {
        return resolveNestedWrapperValue(unwrapped.text);
      }
      const name = callExpressionName(unwrapped);
      return name ? resolveNestedWrapperValue(name) : null;
    }

    function registerNestedWrapperObjectMethods(
      objectName,
      initializer,
      scope = currentNestedWrapperFunctionScope(),
      recordBranchAssignments = false,
      recordBranchAssignmentScope = scope,
    ) {
      const registeredMethods = new Map();
      const objectLiteral = unwrapExpression(initializer);
      if (ts.isIdentifier(objectLiteral)) {
        return copyNestedWrapperObjectMethods(
          objectName,
          objectLiteral.text,
          scope,
          recordBranchAssignments,
          recordBranchAssignmentScope,
        );
      }
      const propertyAccessSource = callExpressionName(objectLiteral);
      if (propertyAccessSource) {
        return copyNestedWrapperObjectMethods(
          objectName,
          propertyAccessSource,
          scope,
          recordBranchAssignments,
          recordBranchAssignmentScope,
        );
      }
      if (!ts.isObjectLiteralExpression(objectLiteral)) {
        return registeredMethods;
      }
      for (const property of objectLiteral.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spreadExpression = unwrapExpression(property.expression);
          const spreadSource = ts.isIdentifier(spreadExpression)
            ? spreadExpression.text
            : callExpressionName(spreadExpression);
          if (spreadSource) {
            const sourceIsKnownObject = isKnownNestedWrapperObjectSource(spreadSource);
            if (!sourceIsKnownObject) {
              markNestedWrapperObjectUnknown(
                objectName,
                scope,
                recordBranchAssignments,
                recordBranchAssignmentScope,
              );
            }
            for (const [key, value] of copyNestedWrapperObjectMethods(
              objectName,
              spreadSource,
              scope,
              recordBranchAssignments,
              recordBranchAssignmentScope,
            )) {
              registeredMethods.set(key, value);
            }
            continue;
          }
          markNestedWrapperObjectUnknown(
            objectName,
            scope,
            recordBranchAssignments,
            recordBranchAssignmentScope,
          );
          continue;
        }
        if (ts.isMethodDeclaration(property)) {
          const name = propertyNameText(property.name);
          if (name) {
            const key = `${objectName}.${name}`;
            clearNestedWrapperObjectMethods(scope, key);
            const value = nestedWrapperRecordForNode(property);
            scope.set(key, value);
            registeredMethods.set(key, value);
            if (recordBranchAssignments) {
              recordWrapperBranchNestedWrapperAssignment(key, value, recordBranchAssignmentScope);
            }
          }
          continue;
        }
        if (
          ts.isPropertyAssignment(property) &&
          (ts.isFunctionExpression(unwrapExpression(property.initializer)) ||
            ts.isArrowFunction(unwrapExpression(property.initializer)))
        ) {
          const name = propertyNameText(property.name);
          if (name) {
            const key = `${objectName}.${name}`;
            clearNestedWrapperObjectMethods(scope, key);
            const value = nestedWrapperRecordForNode(unwrapExpression(property.initializer));
            scope.set(key, value);
            registeredMethods.set(key, value);
            if (recordBranchAssignments) {
              recordWrapperBranchNestedWrapperAssignment(key, value, recordBranchAssignmentScope);
            }
          }
          continue;
        }
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(unwrapExpression(property.initializer))
        ) {
          const name = propertyNameText(property.name);
          if (!name) {
            continue;
          }
          if (isKnownUndefinedExpression(property.initializer)) {
            const key = `${objectName}.${name}`;
            clearNestedWrapperObjectMethods(scope, key);
            scope.set(key, explicitUndefinedNestedWrapperValue);
            registeredMethods.set(key, explicitUndefinedNestedWrapperValue);
            if (recordBranchAssignments) {
              recordWrapperBranchNestedWrapperAssignment(
                key,
                explicitUndefinedNestedWrapperValue,
                recordBranchAssignmentScope,
              );
            }
            continue;
          }
          const sourceName = unwrapExpression(property.initializer).text;
          const wrapper = resolveNestedWrapperValue(sourceName);
          if (wrapper) {
            const key = `${objectName}.${name}`;
            clearNestedWrapperObjectMethods(scope, key);
            const value =
              wrapperRecords(wrapper).length > 0 ? cloneWrapperFunctionValue(wrapper) : null;
            scope.set(key, value);
            registeredMethods.set(key, value);
            if (recordBranchAssignments) {
              recordWrapperBranchNestedWrapperAssignment(key, value, recordBranchAssignmentScope);
            }
            if (wrapperRecords(wrapper).length === 0) {
              const copiedMethods = copyNestedWrapperObjectMethods(
                key,
                sourceName,
                scope,
                recordBranchAssignments,
                recordBranchAssignmentScope,
              );
              for (const [copiedKey, copiedValue] of copiedMethods) {
                registeredMethods.set(copiedKey, copiedValue);
              }
            }
          } else {
            const key = `${objectName}.${name}`;
            clearNestedWrapperObjectMethods(scope, key);
            const copiedMethods = copyNestedWrapperObjectMethods(
              key,
              sourceName,
              scope,
              recordBranchAssignments,
              recordBranchAssignmentScope,
            );
            if (copiedMethods.size > 0) {
              for (const [copiedKey, value] of copiedMethods) {
                registeredMethods.set(copiedKey, value);
              }
            } else {
              scope.set(key, null);
              registeredMethods.set(key, null);
              if (recordBranchAssignments) {
                recordWrapperBranchNestedWrapperAssignment(key, null, recordBranchAssignmentScope);
              }
            }
          }
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          const wrapper = resolveNestedWrapperValue(property.name.text);
          const key = `${objectName}.${property.name.text}`;
          clearNestedWrapperObjectMethods(scope, key);
          if (wrapper) {
            const value =
              wrapperRecords(wrapper).length > 0 ? cloneWrapperFunctionValue(wrapper) : null;
            scope.set(key, value);
            registeredMethods.set(key, value);
            if (recordBranchAssignments) {
              recordWrapperBranchNestedWrapperAssignment(key, value, recordBranchAssignmentScope);
            }
            if (wrapperRecords(wrapper).length === 0) {
              const copiedMethods = copyNestedWrapperObjectMethods(
                key,
                property.name.text,
                scope,
                recordBranchAssignments,
                recordBranchAssignmentScope,
              );
              for (const [copiedKey, copiedValue] of copiedMethods) {
                registeredMethods.set(copiedKey, copiedValue);
              }
            }
          } else {
            const copiedMethods = copyNestedWrapperObjectMethods(
              key,
              property.name.text,
              scope,
              recordBranchAssignments,
              recordBranchAssignmentScope,
            );
            if (copiedMethods.size > 0) {
              for (const [copiedKey, value] of copiedMethods) {
                registeredMethods.set(copiedKey, value);
              }
            } else {
              scope.set(key, null);
              registeredMethods.set(key, null);
              if (recordBranchAssignments) {
                recordWrapperBranchNestedWrapperAssignment(key, null, recordBranchAssignmentScope);
              }
            }
          }
          continue;
        }
        if (ts.isPropertyAssignment(property)) {
          const name = propertyNameText(property.name);
          if (name) {
            const key = `${objectName}.${name}`;
            clearNestedWrapperObjectMethods(scope, key);
            const propertyInitializer = unwrapExpression(property.initializer);
            if (ts.isObjectLiteralExpression(propertyInitializer)) {
              registerNestedWrapperObjectMethods(
                key,
                propertyInitializer,
                scope,
                recordBranchAssignments,
                recordBranchAssignmentScope,
              );
            }
            const wrapper = isKnownUndefinedExpression(property.initializer)
              ? explicitUndefinedNestedWrapperValue
              : resolveNestedWrapperExpression(property.initializer);
            const value = wrapper ? cloneWrapperFunctionValue(wrapper) : null;
            scope.set(key, value);
            registeredMethods.set(key, value);
            if (recordBranchAssignments) {
              recordWrapperBranchNestedWrapperAssignment(key, value, recordBranchAssignmentScope);
            }
          }
        }
      }
      return registeredMethods;
    }

    function registerNestedWrapperObjectBinding(
      bindingPattern,
      sourceName,
      propertyPath = [],
      scope = currentNestedWrapperFunctionScope(),
    ) {
      for (const element of bindingPattern.elements) {
        const propertyName = element.propertyName
          ? propertyNameText(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null;
        if (!propertyName) {
          continue;
        }
        const nextPath = [...propertyPath, propertyName];
        if (ts.isIdentifier(element.name)) {
          const sourcePath = `${sourceName}.${nextPath.join(".")}`;
          const source = resolveNestedWrapperBindingValue(sourcePath);
          const wrapper = source.found
            ? source.value === explicitUndefinedNestedWrapperValue
              ? nestedWrapperObjectBindingDefaultValue(element)
              : source.value
            : nestedWrapperObjectBindingMissingValue(sourceName, nextPath, element);
          clearNestedWrapperObjectMethods(scope, element.name.text);
          scope.set(element.name.text, cloneWrapperFunctionValue(wrapper));
          copyNestedWrapperObjectMethods(element.name.text, sourcePath, scope);
          continue;
        }
        if (ts.isObjectBindingPattern(element.name)) {
          registerNestedWrapperObjectBinding(element.name, sourceName, nextPath, scope);
        }
      }
    }

    function nestedWrapperObjectBindingMissingValue(sourceName, propertyPath, element) {
      for (let index = propertyPath.length - 1; index >= 0; index--) {
        const parentPath = propertyPath.slice(0, index);
        const parentName =
          parentPath.length === 0 ? sourceName : `${sourceName}.${parentPath.join(".")}`;
        const parent = resolveNestedWrapperBindingValue(parentName);
        if (parent.found && parent.value === unknownNestedWrapperObjectValue) {
          return null;
        }
      }
      return nestedWrapperObjectBindingDefaultValue(element);
    }

    function nestedWrapperObjectBindingDefaultValue(element) {
      if (!element.initializer) {
        return null;
      }
      const initializer = unwrapExpression(element.initializer);
      return nestedWrapperValueFromExpression(initializer);
    }

    function nestedWrapperValueFromExpression(expression) {
      const initializer = unwrapExpression(expression);
      if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) {
        return nestedWrapperRecordForNode(initializer);
      }
      return resolveNestedWrapperExpression(initializer);
    }

    function nestedWrapperObjectLiteralSpreadPropertyState(objectName, propertyName) {
      const source = resolveNestedWrapperBindingValue(`${objectName}.${propertyName}`);
      if (!source.found) {
        const objectSource = resolveNestedWrapperBindingValue(objectName);
        return objectSource.found && objectSource.value === knownObjectLiteralNestedWrapperValue
          ? { kind: "missing" }
          : { kind: "unknown" };
      }
      if (source.value === explicitUndefinedNestedWrapperValue) {
        return { kind: "undefined" };
      }
      if (source.value === unknownNestedWrapperObjectValue) {
        return { kind: "unknown" };
      }
      return { kind: "value", value: source.value };
    }

    function nestedWrapperValueFromObjectLiteralPropertyState(propertyState, element) {
      if (propertyState.kind === "unknown") {
        return null;
      }
      if (propertyState.kind === "value") {
        return propertyState.value;
      }
      if (propertyState.kind === "initializer") {
        return nestedWrapperValueFromExpression(propertyState.initializer);
      }
      return nestedWrapperObjectBindingDefaultValue(element);
    }

    function registerNestedWrapperObjectLiteralBinding(
      bindingPattern,
      objectLiteral,
      scope = currentNestedWrapperFunctionScope(),
    ) {
      for (const element of bindingPattern.elements) {
        const propertyName = element.propertyName
          ? propertyNameText(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null;
        if (!propertyName) {
          continue;
        }
        const propertyState = objectLiteralPropertyInitializerState(
          objectLiteral,
          propertyName,
          nestedWrapperObjectLiteralSpreadPropertyState,
        );
        if (ts.isIdentifier(element.name)) {
          const wrapper = nestedWrapperValueFromObjectLiteralPropertyState(propertyState, element);
          scope.set(element.name.text, cloneWrapperFunctionValue(wrapper));
          continue;
        }
        if (
          ts.isObjectBindingPattern(element.name) &&
          propertyState.kind === "initializer" &&
          ts.isObjectLiteralExpression(unwrapExpression(propertyState.initializer))
        ) {
          registerNestedWrapperObjectLiteralBinding(
            element.name,
            unwrapExpression(propertyState.initializer),
            scope,
          );
        }
      }
    }

    function registerNestedWrapperObjectBindingInitializer(
      bindingPattern,
      initializer,
      scope = currentNestedWrapperFunctionScope(),
    ) {
      const unwrapped = unwrapExpression(initializer);
      if (ts.isIdentifier(unwrapped)) {
        registerNestedWrapperObjectBinding(bindingPattern, unwrapped.text, [], scope);
        return;
      }
      if (ts.isObjectLiteralExpression(unwrapped)) {
        registerNestedWrapperObjectLiteralBinding(bindingPattern, unwrapped, scope);
        return;
      }
      const propertyAccess = rootedPropertyAccessPath(unwrapped);
      if (propertyAccess?.properties.length > 0) {
        registerNestedWrapperObjectBinding(
          bindingPattern,
          objectPropertyKey(propertyAccess.rootName, propertyAccess.properties.join(".")),
          [],
          scope,
        );
      }
    }

    function resolveRecordFsModuleProperty(record, pathParts) {
      const fullPath = pathParts.join(".");
      const prefixes = pathParts.map((_, index) => pathParts.slice(0, index + 1).join("."));
      if (record.moduleProperties.get(fullPath) === true) {
        return true;
      }
      for (const prefix of prefixes) {
        if (record.moduleProperties.get(prefix) === false) {
          return false;
        }
      }
      return false;
    }

    function collectClosedOverPathPropertyUses(
      record,
      activeClosedOverNodes = new Set(),
      argumentsList = null,
    ) {
      if (activeClosedOverNodes.has(record.node)) {
        return new Map();
      }
      activeClosedOverNodes.add(record.node);
      const closedOverUses = new Map();
      const localBindingScopes = [new Set()];
      const localFsWriteAliasScopes = [new Map(record.aliases)];
      const localFsModuleBindingScopes = [new Map(record.moduleBindings)];
      const localRequireAliasScopes = [new Map(record.requireAliases)];
      const localNestedFunctionScopes = [new Map()];
      const localNestedFunctionScopeParents = new Map([[localNestedFunctionScopes[0], null]]);
      const localNestedBranchEffectScopes = [];

      function currentLocalBindingScope() {
        return localBindingScopes[localBindingScopes.length - 1];
      }

      function currentLocalFsWriteAliasScope() {
        return localFsWriteAliasScopes[localFsWriteAliasScopes.length - 1];
      }

      function currentLocalFsModuleBindingScope() {
        return localFsModuleBindingScopes[localFsModuleBindingScopes.length - 1];
      }

      function currentLocalRequireAliasScope() {
        return localRequireAliasScopes[localRequireAliasScopes.length - 1];
      }

      function currentLocalNestedFunctionScope() {
        return localNestedFunctionScopes[localNestedFunctionScopes.length - 1];
      }

      function pushLocalClosedOverScope() {
        localBindingScopes.push(new Set());
        localFsWriteAliasScopes.push(new Map());
        localFsModuleBindingScopes.push(new Map());
        localRequireAliasScopes.push(new Map());
        const localNestedFunctionScope = new Map();
        localNestedFunctionScopeParents.set(
          localNestedFunctionScope,
          currentLocalNestedFunctionScope(),
        );
        localNestedFunctionScopes.push(localNestedFunctionScope);
      }

      function popLocalClosedOverScope() {
        localNestedFunctionScopes.pop();
        localRequireAliasScopes.pop();
        localFsModuleBindingScopes.pop();
        localFsWriteAliasScopes.pop();
        localBindingScopes.pop();
      }

      function currentLocalNestedBranchEffectScope() {
        return localNestedBranchEffectScopes[localNestedBranchEffectScopes.length - 1] ?? null;
      }

      function createLocalNestedBranchEffects() {
        return {
          fsIdentifierAssignments: new Map(),
          nestedAssignments: new Map(),
          nestedAssignmentScopes: new Map(),
        };
      }

      function recordLocalNestedBranchFsIdentifierAssignment(
        name,
        moduleValue,
        writeAlias,
        requireAlias,
        moduleScope,
        writeAliasScope,
        requireAliasScope,
      ) {
        const effects = currentLocalNestedBranchEffectScope();
        if (!effects) {
          return;
        }
        effects.fsIdentifierAssignments.set(name, {
          moduleScope,
          moduleValue,
          name,
          requireAlias,
          requireAliasScope,
          writeAlias,
          writeAliasScope,
        });
      }

      function recordLocalNestedBranchAssignment(name, value, targetScope) {
        const effects = currentLocalNestedBranchEffectScope();
        if (!effects) {
          return;
        }
        clearLocalNestedBranchObjectAssignments(effects, name);
        effects.nestedAssignments.set(name, cloneWrapperFunctionValue(value));
        effects.nestedAssignmentScopes.set(name, targetScope);
      }

      function clearLocalNestedBranchObjectAssignments(effects, objectName) {
        const prefix = `${objectName}.`;
        for (const name of effects.nestedAssignments.keys()) {
          if (name.startsWith(prefix)) {
            effects.nestedAssignments.delete(name);
            effects.nestedAssignmentScopes.delete(name);
          }
        }
      }

      function applyMergedLocalNestedBranchAssignment(name, value, targetScope) {
        clearLocalNestedObjectMethods(name);
        targetScope.set(name, cloneWrapperFunctionValue(value));
        recordLocalNestedBranchAssignment(name, value, targetScope);
      }

      function applyMergedLocalNestedFsIdentifierAssignment(assignment, previous = null) {
        const moduleValue = assignment.moduleValue === true || previous?.moduleValue === true;
        const writeAlias = previous?.writeAlias ?? assignment.writeAlias;
        const requireAlias = assignment.requireAlias === true || previous?.requireAlias === true;
        if (assignment.moduleScope && localFsModuleBindingScopes.includes(assignment.moduleScope)) {
          assignment.moduleScope.set(assignment.name, moduleValue);
        }
        if (
          assignment.writeAliasScope &&
          localFsWriteAliasScopes.includes(assignment.writeAliasScope)
        ) {
          assignment.writeAliasScope.set(assignment.name, writeAlias);
        }
        if (
          assignment.requireAliasScope &&
          localRequireAliasScopes.includes(assignment.requireAliasScope)
        ) {
          assignment.requireAliasScope.set(assignment.name, requireAlias);
        }
      }

      function mergeExhaustiveLocalNestedBranchEffects(thenEffects, elseEffects) {
        const fsIdentifierAssignmentNames = new Set([
          ...thenEffects.fsIdentifierAssignments.keys(),
          ...elseEffects.fsIdentifierAssignments.keys(),
        ]);
        for (const name of fsIdentifierAssignmentNames) {
          const thenAssignment = thenEffects.fsIdentifierAssignments.get(name);
          const elseAssignment = elseEffects.fsIdentifierAssignments.get(name);
          const assignment = thenAssignment ?? elseAssignment;
          if (!assignment) {
            continue;
          }
          applyMergedLocalNestedFsIdentifierAssignment(
            assignment,
            thenAssignment && elseAssignment ? elseAssignment : null,
          );
        }
        const names = new Set([
          ...thenEffects.nestedAssignments.keys(),
          ...elseEffects.nestedAssignments.keys(),
        ]);
        for (const name of [...names].toSorted(wrapperAssignmentMergeOrder)) {
          const thenScope = thenEffects.nestedAssignmentScopes.get(name);
          const elseScope = elseEffects.nestedAssignmentScopes.get(name);
          const targetScope = thenScope ?? elseScope;
          if (
            targetScope === undefined ||
            (thenScope !== undefined && elseScope !== undefined && thenScope !== elseScope)
          ) {
            continue;
          }
          const previousValue = targetScope.get(name);
          applyMergedLocalNestedBranchAssignment(
            name,
            mergeWrapperAssignmentValues(
              thenEffects.nestedAssignments.has(name)
                ? thenEffects.nestedAssignments.get(name)
                : previousValue,
              elseEffects.nestedAssignments.has(name)
                ? elseEffects.nestedAssignments.get(name)
                : previousValue,
            ),
            targetScope,
          );
        }
      }

      function mergeOptionalLocalNestedBranchEffects(effects) {
        for (const assignment of effects.fsIdentifierAssignments.values()) {
          applyMergedLocalNestedFsIdentifierAssignment(assignment, {
            moduleValue: assignment.moduleScope?.get(assignment.name) === true,
            requireAlias: assignment.requireAliasScope?.get(assignment.name) === true,
            writeAlias: assignment.writeAliasScope?.get(assignment.name) ?? null,
          });
        }
        for (const [name, value] of effects.nestedAssignments) {
          const targetScope = effects.nestedAssignmentScopes.get(name);
          if (!targetScope) {
            continue;
          }
          const previousValue = targetScope.get(name);
          applyMergedLocalNestedBranchAssignment(
            name,
            mergeWrapperAssignmentValues(previousValue, value),
            targetScope,
          );
        }
      }

      function localBindingWriteScope(name, scopes) {
        for (let index = localBindingScopes.length - 1; index >= 0; index--) {
          if (localBindingScopes[index].has(name)) {
            return scopes[index];
          }
        }
        return scopes[scopes.length - 1];
      }

      function localNestedObjectMethodWriteScope(objectName, propertyName) {
        const key = objectPropertyKey(objectName, propertyName);
        for (let index = localNestedFunctionScopes.length - 1; index >= 0; index--) {
          const scope = localNestedFunctionScopes[index];
          if (scope.has(key) || localBindingScopes[index].has(objectName)) {
            return scope;
          }
        }
        if (record.lexicalScope?.has(key) || record.lexicalScope?.has(objectName)) {
          return record.lexicalScope;
        }
        return currentLocalNestedFunctionScope();
      }

      function visibleLocalFsWriteAliases() {
        const aliases = new Map();
        for (const scope of localFsWriteAliasScopes) {
          for (const [name, value] of scope) {
            aliases.set(name, value);
          }
        }
        return aliases;
      }

      function visibleLocalFsModuleBindings() {
        const bindings = new Map();
        for (const scope of localFsModuleBindingScopes) {
          for (const [name, value] of scope) {
            bindings.set(name, value);
          }
        }
        return bindings;
      }

      function visibleLocalRequireAliases() {
        const aliases = new Map();
        for (const scope of localRequireAliasScopes) {
          for (const [name, value] of scope) {
            aliases.set(name, value);
          }
        }
        return aliases;
      }

      function registerLocalNestedFunction(
        name,
        nestedNode,
        scope = currentLocalNestedFunctionScope(),
      ) {
        registerLocalNestedFunctionRecord(name, localNestedRecordForNode(nestedNode, scope), scope);
      }

      function localNestedRecordForNode(
        nestedNode,
        scope = currentLocalNestedFunctionScope(),
        localScope = scope,
      ) {
        return {
          aliases: visibleLocalFsWriteAliases(),
          closesOverCurrentWrapper: true,
          createRequireShadows: new Set(record.createRequireShadows),
          lexicalScope: record.lexicalScope,
          localScope,
          moduleBindings: visibleLocalFsModuleBindings(),
          moduleProperties: new Map(record.moduleProperties),
          node: nestedNode,
          requireAliases: visibleLocalRequireAliases(),
          requireAliasSourceScopes: new Map(record.requireAliasSourceScopes),
        };
      }

      function registerLocalNestedFunctionRecord(
        name,
        nestedRecord,
        scope = currentLocalNestedFunctionScope(),
      ) {
        scope.set(name, nestedRecord);
      }

      function clearLocalNestedObjectMethods(objectName) {
        const prefix = `${objectName}.`;
        for (const scope of localNestedFunctionScopes) {
          for (const name of scope.keys()) {
            if (name.startsWith(prefix)) {
              scope.set(name, null);
            }
          }
        }
      }

      function markLocalNestedObjectUnknown(
        objectName,
        scope = currentLocalNestedFunctionScope(),
        recordBranchAssignments = false,
        recordBranchAssignmentScope = scope,
      ) {
        clearLocalNestedObjectMethods(objectName);
        registerLocalNestedFunctionRecord(objectName, unknownNestedWrapperObjectValue, scope);
        if (recordBranchAssignments) {
          recordLocalNestedBranchAssignment(
            objectName,
            unknownNestedWrapperObjectValue,
            recordBranchAssignmentScope,
          );
        }
      }

      function copyLocalNestedObjectMethods(
        targetName,
        sourceName,
        scope = currentLocalNestedFunctionScope(),
        recordBranchAssignments = false,
        recordBranchAssignmentScope = scope,
      ) {
        const sourceScopes =
          !isLocalBinding(sourceName) && record.lexicalScope
            ? [record.lexicalScope, ...localNestedFunctionScopes]
            : localNestedFunctionScopes;
        const copiedMethods = new Map();
        const sourcePrefix = `${sourceName}.`;
        for (const sourceScope of sourceScopes) {
          for (const [name, value] of sourceScope) {
            if (!name.startsWith(sourcePrefix)) {
              continue;
            }
            const key = `${targetName}.${name.slice(sourcePrefix.length)}`;
            const copiedValue = cloneWrapperFunctionValue(value);
            registerLocalNestedFunctionRecord(key, copiedValue, scope);
            copiedMethods.set(key, copiedValue);
            if (recordBranchAssignments) {
              recordLocalNestedBranchAssignment(key, copiedValue, recordBranchAssignmentScope);
            }
          }
        }
        return copiedMethods;
      }

      function isKnownLocalNestedObjectSource(sourceName) {
        const source = resolveLocalNestedFunctionBindingValue(sourceName);
        return source.found && source.value === knownObjectLiteralNestedWrapperValue;
      }

      function registerLocalNestedObjectMethods(
        objectName,
        initializer,
        scope = currentLocalNestedFunctionScope(),
        localScope = scope,
        recordBranchAssignments = false,
        recordBranchAssignmentScope = scope,
      ) {
        const objectLiteral = unwrapExpression(initializer);
        if (ts.isIdentifier(objectLiteral)) {
          copyLocalNestedObjectMethods(
            objectName,
            objectLiteral.text,
            scope,
            recordBranchAssignments,
            recordBranchAssignmentScope,
          );
          return;
        }
        const propertyAccessSource = callExpressionName(objectLiteral);
        if (propertyAccessSource) {
          copyLocalNestedObjectMethods(
            objectName,
            propertyAccessSource,
            scope,
            recordBranchAssignments,
            recordBranchAssignmentScope,
          );
          return;
        }
        if (!ts.isObjectLiteralExpression(objectLiteral)) {
          return;
        }
        for (const property of objectLiteral.properties) {
          if (ts.isSpreadAssignment(property)) {
            const spreadExpression = unwrapExpression(property.expression);
            if (ts.isIdentifier(spreadExpression)) {
              const sourceIsKnownObject = isKnownLocalNestedObjectSource(spreadExpression.text);
              if (!sourceIsKnownObject) {
                markLocalNestedObjectUnknown(
                  objectName,
                  scope,
                  recordBranchAssignments,
                  recordBranchAssignmentScope,
                );
              }
              copyLocalNestedObjectMethods(
                objectName,
                spreadExpression.text,
                scope,
                recordBranchAssignments,
                recordBranchAssignmentScope,
              );
              continue;
            }
            markLocalNestedObjectUnknown(
              objectName,
              scope,
              recordBranchAssignments,
              recordBranchAssignmentScope,
            );
            continue;
          }
          if (ts.isMethodDeclaration(property)) {
            const name = propertyNameText(property.name);
            if (name) {
              const key = `${objectName}.${name}`;
              clearLocalNestedObjectMethods(key);
              const value = localNestedRecordForNode(property, scope, localScope);
              registerLocalNestedFunctionRecord(key, value, scope);
              if (recordBranchAssignments) {
                recordLocalNestedBranchAssignment(key, value, recordBranchAssignmentScope);
              }
            }
            continue;
          }
          if (
            ts.isPropertyAssignment(property) &&
            (ts.isFunctionExpression(unwrapExpression(property.initializer)) ||
              ts.isArrowFunction(unwrapExpression(property.initializer)))
          ) {
            const name = propertyNameText(property.name);
            if (name) {
              const key = `${objectName}.${name}`;
              clearLocalNestedObjectMethods(key);
              const value = localNestedRecordForNode(
                unwrapExpression(property.initializer),
                scope,
                localScope,
              );
              registerLocalNestedFunctionRecord(key, value, scope);
              if (recordBranchAssignments) {
                recordLocalNestedBranchAssignment(key, value, recordBranchAssignmentScope);
              }
            }
            continue;
          }
          if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(unwrapExpression(property.initializer))
          ) {
            const name = propertyNameText(property.name);
            if (!name) {
              continue;
            }
            if (isKnownUndefinedExpression(property.initializer)) {
              const key = `${objectName}.${name}`;
              clearLocalNestedObjectMethods(key);
              registerLocalNestedFunctionRecord(key, explicitUndefinedNestedWrapperValue, scope);
              if (recordBranchAssignments) {
                recordLocalNestedBranchAssignment(
                  key,
                  explicitUndefinedNestedWrapperValue,
                  recordBranchAssignmentScope,
                );
              }
              continue;
            }
            const sourceName = unwrapExpression(property.initializer).text;
            const nested = resolveLocalNestedFunction(sourceName);
            const key = `${objectName}.${name}`;
            clearLocalNestedObjectMethods(key);
            if (wrapperRecords(nested).length > 0) {
              registerLocalNestedFunctionRecord(key, nested, scope);
              if (recordBranchAssignments) {
                recordLocalNestedBranchAssignment(key, nested, recordBranchAssignmentScope);
              }
            } else {
              if (isNestedWrapperObjectMarker(nested)) {
                registerLocalNestedFunctionRecord(key, nested, scope);
                if (recordBranchAssignments) {
                  recordLocalNestedBranchAssignment(key, nested, recordBranchAssignmentScope);
                }
              }
              const copiedMethods = copyLocalNestedObjectMethods(
                key,
                sourceName,
                scope,
                recordBranchAssignments,
                recordBranchAssignmentScope,
              );
              if (copiedMethods.size === 0 && !isNestedWrapperObjectMarker(nested)) {
                registerLocalNestedFunctionRecord(key, null, scope);
                if (recordBranchAssignments) {
                  recordLocalNestedBranchAssignment(key, null, recordBranchAssignmentScope);
                }
              }
            }
            continue;
          }
          if (ts.isShorthandPropertyAssignment(property)) {
            const nested = resolveLocalNestedFunction(property.name.text);
            const key = `${objectName}.${property.name.text}`;
            clearLocalNestedObjectMethods(key);
            if (wrapperRecords(nested).length > 0) {
              registerLocalNestedFunctionRecord(key, nested, scope);
              if (recordBranchAssignments) {
                recordLocalNestedBranchAssignment(key, nested, recordBranchAssignmentScope);
              }
            } else {
              if (isNestedWrapperObjectMarker(nested)) {
                registerLocalNestedFunctionRecord(key, nested, scope);
                if (recordBranchAssignments) {
                  recordLocalNestedBranchAssignment(key, nested, recordBranchAssignmentScope);
                }
              }
              const copiedMethods = copyLocalNestedObjectMethods(
                key,
                property.name.text,
                scope,
                recordBranchAssignments,
                recordBranchAssignmentScope,
              );
              if (copiedMethods.size === 0 && !isNestedWrapperObjectMarker(nested)) {
                registerLocalNestedFunctionRecord(key, null, scope);
                if (recordBranchAssignments) {
                  recordLocalNestedBranchAssignment(key, null, recordBranchAssignmentScope);
                }
              }
            }
            continue;
          }
          if (ts.isPropertyAssignment(property)) {
            const name = propertyNameText(property.name);
            if (name) {
              const key = `${objectName}.${name}`;
              clearLocalNestedObjectMethods(key);
              const propertyInitializer = unwrapExpression(property.initializer);
              if (ts.isObjectLiteralExpression(propertyInitializer)) {
                registerLocalNestedObjectMethods(
                  key,
                  propertyInitializer,
                  scope,
                  localScope,
                  recordBranchAssignments,
                  recordBranchAssignmentScope,
                );
              }
              const value =
                (isKnownUndefinedExpression(property.initializer)
                  ? explicitUndefinedNestedWrapperValue
                  : resolveLocalNestedExpression(property.initializer)) ?? null;
              registerLocalNestedFunctionRecord(key, value, scope);
              if (recordBranchAssignments) {
                recordLocalNestedBranchAssignment(key, value, recordBranchAssignmentScope);
              }
            }
          }
        }
      }

      function registerLocalNestedObjectBinding(
        bindingPattern,
        sourceName,
        propertyPath = [],
        scope = currentLocalNestedFunctionScope(),
        localScope = scope,
      ) {
        for (const element of bindingPattern.elements) {
          const propertyName = element.propertyName
            ? propertyNameText(element.propertyName)
            : ts.isIdentifier(element.name)
              ? element.name.text
              : null;
          if (!propertyName) {
            continue;
          }
          const nextPath = [...propertyPath, propertyName];
          if (ts.isIdentifier(element.name)) {
            const sourcePath = `${sourceName}.${nextPath.join(".")}`;
            const source = resolveLocalNestedFunctionBindingValue(sourcePath);
            clearLocalNestedObjectMethods(element.name.text);
            registerLocalNestedFunctionRecord(
              element.name.text,
              cloneWrapperFunctionValue(
                source.found
                  ? source.value === explicitUndefinedNestedWrapperValue
                    ? localNestedObjectBindingDefaultValue(element, scope, localScope)
                    : source.value
                  : localNestedObjectBindingMissingValue(
                      sourceName,
                      nextPath,
                      element,
                      scope,
                      localScope,
                    ),
              ),
              scope,
            );
            copyLocalNestedObjectMethods(element.name.text, sourcePath, scope);
            continue;
          }
          if (ts.isObjectBindingPattern(element.name)) {
            registerLocalNestedObjectBinding(element.name, sourceName, nextPath, scope, localScope);
          }
        }
      }

      function localNestedObjectBindingMissingValue(
        sourceName,
        propertyPath,
        element,
        scope = currentLocalNestedFunctionScope(),
        localScope = scope,
      ) {
        for (let index = propertyPath.length - 1; index >= 0; index--) {
          const parentPath = propertyPath.slice(0, index);
          const parentName =
            parentPath.length === 0 ? sourceName : `${sourceName}.${parentPath.join(".")}`;
          const parent = resolveLocalNestedFunctionBindingValue(parentName);
          if (parent.found && parent.value === unknownNestedWrapperObjectValue) {
            return null;
          }
        }
        return localNestedObjectBindingDefaultValue(element, scope, localScope);
      }

      function resolveLocalNestedFunctionBindingValue(name) {
        for (let index = localNestedFunctionScopes.length - 1; index >= 0; index--) {
          const scope = localNestedFunctionScopes[index];
          if (scope.has(name)) {
            return { found: true, value: scope.get(name) };
          }
        }
        const rootName = name.split(".")[0] ?? name;
        if (!isLocalBinding(rootName) && record.lexicalScope?.has(name)) {
          return { found: true, value: record.lexicalScope.get(name) };
        }
        return { found: false, value: null };
      }

      function localNestedObjectBindingDefaultValue(
        element,
        scope = currentLocalNestedFunctionScope(),
        localScope = scope,
      ) {
        if (!element.initializer) {
          return null;
        }
        const initializer = unwrapExpression(element.initializer);
        return localNestedValueFromExpression(initializer, scope, localScope);
      }

      function localNestedValueFromExpression(
        expression,
        scope = currentLocalNestedFunctionScope(),
        localScope = scope,
      ) {
        const initializer = unwrapExpression(expression);
        if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) {
          return localNestedRecordForNode(initializer, scope, localScope);
        }
        return resolveLocalNestedExpression(initializer);
      }

      function localNestedObjectLiteralSpreadPropertyState(objectName, propertyName) {
        const source = resolveLocalNestedFunctionBindingValue(`${objectName}.${propertyName}`);
        if (!source.found) {
          const objectSource = resolveLocalNestedFunctionBindingValue(objectName);
          return objectSource.found && objectSource.value === knownObjectLiteralNestedWrapperValue
            ? { kind: "missing" }
            : { kind: "unknown" };
        }
        if (source.value === explicitUndefinedNestedWrapperValue) {
          return { kind: "undefined" };
        }
        if (source.value === unknownNestedWrapperObjectValue) {
          return { kind: "unknown" };
        }
        return { kind: "value", value: source.value };
      }

      function localNestedValueFromObjectLiteralPropertyState(
        propertyState,
        element,
        scope = currentLocalNestedFunctionScope(),
        localScope = scope,
      ) {
        if (propertyState.kind === "unknown") {
          return null;
        }
        if (propertyState.kind === "value") {
          return propertyState.value;
        }
        if (propertyState.kind === "initializer") {
          return localNestedValueFromExpression(propertyState.initializer, scope, localScope);
        }
        return localNestedObjectBindingDefaultValue(element, scope, localScope);
      }

      function registerLocalNestedObjectLiteralBinding(
        bindingPattern,
        objectLiteral,
        scope = currentLocalNestedFunctionScope(),
        localScope = scope,
      ) {
        for (const element of bindingPattern.elements) {
          const propertyName = element.propertyName
            ? propertyNameText(element.propertyName)
            : ts.isIdentifier(element.name)
              ? element.name.text
              : null;
          if (!propertyName) {
            continue;
          }
          const propertyState = objectLiteralPropertyInitializerState(
            objectLiteral,
            propertyName,
            localNestedObjectLiteralSpreadPropertyState,
          );
          if (ts.isIdentifier(element.name)) {
            const wrapper = localNestedValueFromObjectLiteralPropertyState(
              propertyState,
              element,
              scope,
              localScope,
            );
            registerLocalNestedFunctionRecord(
              element.name.text,
              cloneWrapperFunctionValue(wrapper),
              scope,
            );
            continue;
          }
          if (
            ts.isObjectBindingPattern(element.name) &&
            propertyState.kind === "initializer" &&
            ts.isObjectLiteralExpression(unwrapExpression(propertyState.initializer))
          ) {
            registerLocalNestedObjectLiteralBinding(
              element.name,
              unwrapExpression(propertyState.initializer),
              scope,
              localScope,
            );
          }
        }
      }

      function refreshCurrentLocalNestedFunctionAliases() {
        const currentScope = currentLocalNestedFunctionScope();
        const aliases = visibleLocalFsWriteAliases();
        const moduleBindings = visibleLocalFsModuleBindings();
        const requireAliases = visibleLocalRequireAliases();
        function isLocalNestedScopeDescendant(scope, ancestor) {
          let current = scope;
          while (current) {
            if (current === ancestor) {
              return true;
            }
            current = localNestedFunctionScopeParents.get(current) ?? null;
          }
          return false;
        }
        function refreshLocalNestedFunctionRecord(localRecord) {
          if (!isLocalNestedScopeDescendant(localRecord.localScope, currentScope)) {
            return;
          }
          if (localRecord.localScope === currentScope) {
            localRecord.aliases = aliases;
            localRecord.moduleBindings = moduleBindings;
            localRecord.requireAliases = requireAliases;
            return;
          }
          localRecord.aliases = new Map([...aliases, ...localRecord.aliases]);
          localRecord.moduleBindings = new Map([...moduleBindings, ...localRecord.moduleBindings]);
          localRecord.requireAliases = new Map([...requireAliases, ...localRecord.requireAliases]);
        }
        function refreshLocalNestedFunctionRecords(values) {
          for (const value of values) {
            for (const localRecord of wrapperRecords(value)) {
              refreshLocalNestedFunctionRecord(localRecord);
            }
          }
        }
        for (const scope of localNestedFunctionScopes) {
          refreshLocalNestedFunctionRecords(scope.values());
        }
        for (const branchEffects of localNestedBranchEffectScopes) {
          refreshLocalNestedFunctionRecords(branchEffects.nestedAssignments.values());
        }
        if (record.lexicalScope) {
          refreshLocalNestedFunctionRecords(record.lexicalScope.values());
        }
      }

      function registerLocalNestedObjectBindingInitializer(
        bindingPattern,
        initializer,
        scope = currentLocalNestedFunctionScope(),
        localScope = scope,
      ) {
        const unwrapped = unwrapExpression(initializer);
        if (ts.isIdentifier(unwrapped)) {
          registerLocalNestedObjectBinding(bindingPattern, unwrapped.text, [], scope, localScope);
          return;
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
          registerLocalNestedObjectLiteralBinding(bindingPattern, unwrapped, scope, localScope);
          return;
        }
        const propertyAccess = rootedPropertyAccessPath(unwrapped);
        if (propertyAccess?.properties.length > 0) {
          registerLocalNestedObjectBinding(
            bindingPattern,
            objectPropertyKey(propertyAccess.rootName, propertyAccess.properties.join(".")),
            [],
            scope,
            localScope,
          );
        }
      }

      function resolveLocalNestedFunction(name) {
        const binding = resolveLocalNestedFunctionBindingValue(name);
        return binding.found ? binding.value : null;
      }

      function resolveLocalNestedExpression(expression) {
        const unwrapped = unwrapExpression(expression);
        const name = ts.isIdentifier(unwrapped) ? unwrapped.text : callExpressionName(unwrapped);
        if (!name) {
          return null;
        }
        const binding = resolveLocalNestedFunctionBindingValue(name);
        if (binding.found) {
          return binding.value;
        }
        const rootName = name.split(".")[0] ?? name;
        return isLocalBinding(rootName) ? null : resolveWrapperFunction(name);
      }

      function assignLocalNestedFunction(
        name,
        expression,
        scope = currentLocalNestedFunctionScope(),
        mergeExisting = false,
        localScope = currentLocalNestedFunctionScope(),
      ) {
        if (!mergeExisting) {
          clearLocalNestedObjectMethods(name);
        }
        const unwrapped = unwrapExpression(expression);
        const nextValue =
          ts.isFunctionExpression(unwrapped) || ts.isArrowFunction(unwrapped)
            ? localNestedRecordForNode(unwrapped, scope, localScope)
            : ts.isObjectLiteralExpression(unwrapped)
              ? knownObjectLiteralNestedWrapperValue
              : cloneWrapperFunctionValue(resolveLocalNestedExpression(expression));
        registerLocalNestedFunctionRecord(
          name,
          mergeExisting ? mergeWrapperAssignmentValues(scope.get(name), nextValue) : nextValue,
          scope,
        );
        return nextValue;
      }

      function registerHoistedLocalNestedFunctions(statements) {
        for (const statement of statements) {
          if (ts.isFunctionDeclaration(statement) && statement.name) {
            currentLocalBindingScope().add(statement.name.text);
            currentLocalFsWriteAliasScope().set(statement.name.text, null);
            currentLocalFsModuleBindingScope().set(statement.name.text, false);
            currentLocalRequireAliasScope().set(statement.name.text, false);
            registerLocalNestedFunction(statement.name.text, statement);
          }
        }
      }

      function localScopeStatements(current) {
        if ("statements" in current) {
          return current.statements;
        }
        if (ts.isCaseBlock(current)) {
          return current.clauses.flatMap((clause) => [...clause.statements]);
        }
        return [];
      }

      function registerLocalDeclarationShadows(statements) {
        for (const statement of statements) {
          if (!ts.isVariableStatement(statement)) {
            continue;
          }
          for (const declaration of statement.declarationList.declarations) {
            markLocalBindings(declaration.name, localDeclarationScopes(declaration));
          }
        }
      }

      function localDeclarationScopes(declaration) {
        if (!isVarVariableDeclaration(declaration)) {
          return {
            bindingScope: currentLocalBindingScope(),
            fsModuleBindingScope: currentLocalFsModuleBindingScope(),
            fsWriteAliasScope: currentLocalFsWriteAliasScope(),
            nestedFunctionScope: currentLocalNestedFunctionScope(),
            requireAliasScope: currentLocalRequireAliasScope(),
          };
        }
        return {
          bindingScope: localBindingScopes[0],
          fsModuleBindingScope: localFsModuleBindingScopes[0],
          fsWriteAliasScope: localFsWriteAliasScopes[0],
          nestedFunctionScope: localNestedFunctionScopes[0],
          requireAliasScope: localRequireAliasScopes[0],
        };
      }

      function currentLocalDeclarationScopes() {
        return {
          bindingScope: currentLocalBindingScope(),
          fsModuleBindingScope: currentLocalFsModuleBindingScope(),
          fsWriteAliasScope: currentLocalFsWriteAliasScope(),
          nestedFunctionScope: currentLocalNestedFunctionScope(),
          requireAliasScope: currentLocalRequireAliasScope(),
        };
      }

      function markLocalBindings(name, scopes = currentLocalDeclarationScopes()) {
        for (const bindingName of bindingPatternNames(name)) {
          scopes.bindingScope.add(bindingName);
          scopes.fsWriteAliasScope.set(bindingName, null);
          scopes.fsModuleBindingScope.set(bindingName, false);
          scopes.requireAliasScope.set(bindingName, false);
          clearLocalNestedObjectMethods(bindingName);
        }
      }

      function isLocalBinding(name) {
        return localBindingScopes.some((scope) => scope.has(name));
      }

      function resolveLocalFsWriteAlias(name) {
        for (let index = localFsWriteAliasScopes.length - 1; index >= 0; index--) {
          const alias = localFsWriteAliasScopes[index].get(name);
          if (alias !== undefined) {
            return alias ?? null;
          }
        }
        return null;
      }

      function resolveLocalFsModuleBinding(name) {
        for (let index = localFsModuleBindingScopes.length - 1; index >= 0; index--) {
          const binding = localFsModuleBindingScopes[index].get(name);
          if (binding !== undefined) {
            return binding === true;
          }
        }
        return false;
      }

      function resolveLocalRequireAlias(name) {
        for (let index = localRequireAliasScopes.length - 1; index >= 0; index--) {
          const alias = localRequireAliasScopes[index].get(name);
          if (alias !== undefined) {
            return alias === true;
          }
        }
        if (name === "require") {
          return true;
        }
        return false;
      }

      function resolveClosedParameterIndex(name) {
        return isLocalBinding(name) ? null : resolveParameterIndex(name);
      }

      function resolveClosedDestructuredParameterProperty(name) {
        return isLocalBinding(name) ? null : resolveDestructuredParameterProperty(name);
      }

      function resolveClosedParameterPropertyUse(objectName, propertyName) {
        return isLocalBinding(objectName)
          ? null
          : resolveParameterPropertyUse(objectName, propertyName);
      }

      function resolveClosedDestructuredParameterPropertyUses(name) {
        return isLocalBinding(name) ? null : resolveDestructuredParameterPropertyUses(name);
      }

      function appendClosedUse(use) {
        const properties = closedOverUses.get(use.index) ?? new Set();
        properties.add(use.propertyName);
        closedOverUses.set(use.index, properties);
      }

      function isClosedOverFsModuleExpression(expression) {
        const receiver = unwrapExpression(expression);
        if (
          isFsRequireExpression(receiver, resolveLocalRequireAlias) ||
          isFsDynamicImportExpression(receiver)
        ) {
          return true;
        }
        if (ts.isIdentifier(receiver)) {
          return resolveLocalFsModuleBinding(receiver.text);
        }
        const receiverPath = propertyAccessPath(receiver);
        if (receiverPath && resolveRecordFsModuleProperty(record, receiverPath)) {
          return true;
        }
        return (
          ts.isPropertyAccessExpression(receiver) &&
          receiver.name.text === "promises" &&
          (isFsRequireExpression(receiver.expression, resolveLocalRequireAlias) ||
            isFsDynamicImportExpression(receiver.expression) ||
            (ts.isIdentifier(receiver.expression) &&
              resolveLocalFsModuleBinding(receiver.expression.text)) ||
            (propertyAccessPath(receiver.expression) &&
              resolveRecordFsModuleProperty(record, propertyAccessPath(receiver.expression))))
        );
      }

      function isClosedOverCreateRequireExpression(expression) {
        const call = unwrapExpression(expression);
        if (!ts.isCallExpression(call) || !ts.isIdentifier(unwrapExpression(call.expression))) {
          return false;
        }
        const createRequireName = unwrapExpression(call.expression).text;
        return (
          createRequireBindings.has(createRequireName) &&
          !record.createRequireShadows.has(createRequireName) &&
          !isLocalBinding(createRequireName)
        );
      }

      function isClosedOverRequireAliasExpression(expression) {
        const value = unwrapExpression(expression);
        return (
          isClosedOverCreateRequireExpression(value) ||
          (ts.isIdentifier(value) && resolveLocalRequireAlias(value.text))
        );
      }

      function legacyClosedOverFsWriteName(expression) {
        const callee = unwrapExpression(expression);
        if (ts.isPropertyAccessExpression(callee)) {
          const aliasedName = callExpressionName(callee);
          const writeAlias = aliasedName ? resolveLocalFsWriteAlias(aliasedName) : null;
          if (writeAlias) {
            return writeAlias;
          }
          return legacyWriteCallees.has(callee.name.text) &&
            isClosedOverFsModuleExpression(callee.expression)
            ? callee.name.text
            : null;
        }
        if (ts.isElementAccessExpression(callee)) {
          const aliasedName = callExpressionName(callee);
          const writeAlias = aliasedName ? resolveLocalFsWriteAlias(aliasedName) : null;
          if (writeAlias) {
            return writeAlias;
          }
          const writeName = elementAccessName(callee.argumentExpression);
          return writeName &&
            legacyWriteCallees.has(writeName) &&
            isClosedOverFsModuleExpression(callee.expression)
            ? writeName
            : null;
        }
        return ts.isIdentifier(callee) ? resolveLocalFsWriteAlias(callee.text) : null;
      }

      function collectForwardedClosedOverPropertyUses(
        argument,
        propertyName,
        parameter = null,
        wrapperNode = null,
        forwardedArguments = [],
        options = {},
      ) {
        if (propertyName === null) {
          return collectPathPropertyUses(
            argument,
            "writeFile",
            resolveClosedParameterIndex,
            resolveClosedDestructuredParameterProperty,
            resolveClosedParameterPropertyUse,
            resolveClosedDestructuredParameterPropertyUses,
          );
        }
        const propertyPath = propertyName.split(".");
        function collectClosedOverBindingDefaultUses(sourceExpression) {
          if (!parameter || !ts.isObjectBindingPattern(parameter.name)) {
            return [];
          }
          const initializer = appliedBindingElementDefaultInitializer(
            parameter.name,
            propertyPath,
            sourceExpression,
            localNestedObjectLiteralSpreadPropertyState,
          );
          const defaultExpression = initializer
            ? resolveBindingDefaultInitializerExpression(
                initializer,
                wrapperNode,
                forwardedArguments,
                parameter,
                options,
              )
            : null;
          return defaultExpression
            ? collectPathPropertyUses(
                defaultExpression,
                "writeFile",
                resolveClosedParameterIndex,
                resolveClosedDestructuredParameterProperty,
                resolveClosedParameterPropertyUse,
                resolveClosedDestructuredParameterPropertyUses,
              )
            : [];
        }
        function collectForwardedClosedOverPropertyUseState(currentArgument, currentPropertyPath) {
          const currentUnwrapped = unwrapExpression(currentArgument);
          const currentPropertyName = currentPropertyPath.join(".");
          if (ts.isIdentifier(currentUnwrapped)) {
            const index = resolveClosedParameterIndex(currentUnwrapped.text);
            if (index !== null) {
              const propertyUse = resolveClosedParameterPropertyUse(
                currentUnwrapped.text,
                currentPropertyName,
              );
              return propertyUse === null
                ? []
                : [propertyUse ?? { index, propertyName: currentPropertyName }];
            }
            return null;
          }
          if (ts.isObjectLiteralExpression(currentUnwrapped)) {
            let result = null;
            for (const property of currentUnwrapped.properties) {
              if (ts.isSpreadAssignment(property)) {
                const spreadUses = collectForwardedClosedOverPropertyUseState(
                  property.expression,
                  currentPropertyPath,
                );
                if (spreadUses !== null) {
                  result = spreadUses;
                }
                continue;
              }
              const [nextPropertyName, ...remainingPropertyPath] = currentPropertyPath;
              if (
                ts.isPropertyAssignment(property) &&
                propertyNameText(property.name) === nextPropertyName
              ) {
                if (isKnownUndefinedExpression(property.initializer)) {
                  result = null;
                  continue;
                }
                if (remainingPropertyPath.length > 0) {
                  result = collectForwardedClosedOverPropertyUseState(
                    property.initializer,
                    remainingPropertyPath,
                  );
                  continue;
                }
                result = collectPathPropertyUses(
                  property.initializer,
                  "writeFile",
                  resolveClosedParameterIndex,
                  resolveClosedDestructuredParameterProperty,
                  resolveClosedParameterPropertyUse,
                  resolveClosedDestructuredParameterPropertyUses,
                );
                continue;
              }
              if (
                remainingPropertyPath.length === 0 &&
                ts.isShorthandPropertyAssignment(property) &&
                property.name.text === nextPropertyName
              ) {
                result = collectPathPropertyUses(
                  property.name,
                  "writeFile",
                  resolveClosedParameterIndex,
                  resolveClosedDestructuredParameterProperty,
                  resolveClosedParameterPropertyUse,
                  resolveClosedDestructuredParameterPropertyUses,
                );
              }
              if (
                remainingPropertyPath.length > 0 &&
                ts.isShorthandPropertyAssignment(property) &&
                property.name.text === nextPropertyName
              ) {
                result = collectForwardedClosedOverPropertyUseState(
                  property.name,
                  remainingPropertyPath,
                );
              }
            }
            return result;
          }
          const uses = collectPathPropertyUses(
            currentArgument,
            "writeFile",
            resolveClosedParameterIndex,
            resolveClosedDestructuredParameterProperty,
            resolveClosedParameterPropertyUse,
            resolveClosedDestructuredParameterPropertyUses,
          );
          return uses.length > 0 ? uses : null;
        }
        const unwrapped = unwrapExpression(argument);
        if (ts.isIdentifier(unwrapped)) {
          const index = resolveClosedParameterIndex(unwrapped.text);
          if (index !== null) {
            const propertyUse = resolveClosedParameterPropertyUse(unwrapped.text, propertyName);
            return propertyUse === null ? [] : [propertyUse ?? { index, propertyName }];
          }
        }
        if (ts.isObjectLiteralExpression(unwrapped)) {
          return (
            collectForwardedClosedOverPropertyUseState(unwrapped, propertyPath) ??
            collectClosedOverBindingDefaultUses(unwrapped)
          );
        }
        return collectPathPropertyUses(
          argument,
          "writeFile",
          resolveClosedParameterIndex,
          resolveClosedDestructuredParameterProperty,
          resolveClosedParameterPropertyUse,
          resolveClosedDestructuredParameterPropertyUses,
        );
      }

      for (const parameter of record.node.parameters ?? []) {
        markLocalBindings(parameter.name);
      }
      if (argumentsList) {
        record.node.parameters.forEach((parameter, index) => {
          if (!ts.isIdentifier(parameter.name) || !parameter.initializer) {
            return;
          }
          const providedArgument = argumentsList[index] ?? null;
          if (providedArgument && !isKnownUndefinedExpression(providedArgument)) {
            return;
          }
          const unwrappedArgument = unwrapExpression(parameter.initializer);
          if (
            !ts.isFunctionExpression(unwrappedArgument) &&
            !ts.isArrowFunction(unwrappedArgument)
          ) {
            return;
          }
          registerLocalNestedFunctionRecord(
            parameter.name.text,
            localNestedRecordForNode(
              unwrappedArgument,
              currentLocalNestedFunctionScope(),
              currentLocalNestedFunctionScope(),
            ),
          );
        });
      }
      if (
        (ts.isFunctionDeclaration(record.node) || ts.isFunctionExpression(record.node)) &&
        record.node.name
      ) {
        markLocalBindings(record.node.name);
      }

      function visitClosedOverNode(current) {
        if (isTypeSyntaxNode(current)) {
          return;
        }
        if (current !== record.node && ts.isFunctionDeclaration(current)) {
          if (current.name) {
            currentLocalBindingScope().add(current.name.text);
            currentLocalFsWriteAliasScope().set(current.name.text, null);
            currentLocalFsModuleBindingScope().set(current.name.text, false);
            currentLocalRequireAliasScope().set(current.name.text, false);
            registerLocalNestedFunction(current.name.text, current);
          }
          return;
        }
        if (ts.isIfStatement(current)) {
          visitClosedOverNode(current.expression);
          if (!current.elseStatement) {
            const effects = createLocalNestedBranchEffects();
            localNestedBranchEffectScopes.push(effects);
            pushLocalClosedOverScope();
            visitClosedOverNode(current.thenStatement);
            popLocalClosedOverScope();
            localNestedBranchEffectScopes.pop();
            mergeOptionalLocalNestedBranchEffects(effects);
            return;
          }
          const thenEffects = createLocalNestedBranchEffects();
          const elseEffects = createLocalNestedBranchEffects();
          localNestedBranchEffectScopes.push(thenEffects);
          visitClosedOverNode(current.thenStatement);
          localNestedBranchEffectScopes.pop();
          localNestedBranchEffectScopes.push(elseEffects);
          visitClosedOverNode(current.elseStatement);
          localNestedBranchEffectScopes.pop();
          mergeExhaustiveLocalNestedBranchEffects(thenEffects, elseEffects);
          return;
        }
        if (current !== record.node && ts.isFunctionLike(current)) {
          return;
        }
        if (ts.isWhileStatement(current)) {
          visitClosedOverNode(current.expression);
          const bodyEffects = createLocalNestedBranchEffects();
          localNestedBranchEffectScopes.push(bodyEffects);
          pushLocalClosedOverScope();
          visitClosedOverNode(current.statement);
          popLocalClosedOverScope();
          localNestedBranchEffectScopes.pop();
          mergeOptionalLocalNestedBranchEffects(bodyEffects);
          return;
        }
        if (ts.isDoStatement(current)) {
          const bodyEffects = createLocalNestedBranchEffects();
          localNestedBranchEffectScopes.push(bodyEffects);
          pushLocalClosedOverScope();
          visitClosedOverNode(current.statement);
          popLocalClosedOverScope();
          localNestedBranchEffectScopes.pop();
          mergeOptionalLocalNestedBranchEffects(bodyEffects);
          visitClosedOverNode(current.expression);
          return;
        }
        if (ts.isForStatement(current)) {
          pushLocalClosedOverScope();
          if (current.initializer) {
            visitClosedOverNode(current.initializer);
          }
          if (current.condition) {
            visitClosedOverNode(current.condition);
          }
          if (current.incrementor) {
            const incrementorEffects = createLocalNestedBranchEffects();
            localNestedBranchEffectScopes.push(incrementorEffects);
            pushLocalClosedOverScope();
            visitClosedOverNode(current.incrementor);
            popLocalClosedOverScope();
            localNestedBranchEffectScopes.pop();
            mergeOptionalLocalNestedBranchEffects(incrementorEffects);
          }
          const bodyEffects = createLocalNestedBranchEffects();
          localNestedBranchEffectScopes.push(bodyEffects);
          pushLocalClosedOverScope();
          visitClosedOverNode(current.statement);
          popLocalClosedOverScope();
          localNestedBranchEffectScopes.pop();
          mergeOptionalLocalNestedBranchEffects(bodyEffects);
          popLocalClosedOverScope();
          return;
        }
        if (ts.isForInStatement(current) || ts.isForOfStatement(current)) {
          visitClosedOverNode(current.expression);
          pushLocalClosedOverScope();
          visitClosedOverNode(current.initializer);
          const bodyEffects = createLocalNestedBranchEffects();
          localNestedBranchEffectScopes.push(bodyEffects);
          pushLocalClosedOverScope();
          visitClosedOverNode(current.statement);
          popLocalClosedOverScope();
          localNestedBranchEffectScopes.pop();
          mergeOptionalLocalNestedBranchEffects(bodyEffects);
          popLocalClosedOverScope();
          return;
        }
        if (ts.isTryStatement(current)) {
          const tryEffects = createLocalNestedBranchEffects();
          localNestedBranchEffectScopes.push(tryEffects);
          pushLocalClosedOverScope();
          visitClosedOverNode(current.tryBlock);
          popLocalClosedOverScope();
          localNestedBranchEffectScopes.pop();
          mergeOptionalLocalNestedBranchEffects(tryEffects);
          if (current.catchClause) {
            const catchEffects = createLocalNestedBranchEffects();
            localNestedBranchEffectScopes.push(catchEffects);
            pushLocalClosedOverScope();
            visitClosedOverNode(current.catchClause);
            popLocalClosedOverScope();
            localNestedBranchEffectScopes.pop();
            mergeOptionalLocalNestedBranchEffects(catchEffects);
          }
          if (current.finallyBlock) {
            pushLocalClosedOverScope();
            visitClosedOverNode(current.finallyBlock);
            popLocalClosedOverScope();
          }
          return;
        }
        if (
          current !== record.node.body &&
          (ts.isBlock(current) || ts.isModuleBlock(current) || ts.isCaseBlock(current))
        ) {
          pushLocalClosedOverScope();
          const statements = localScopeStatements(current);
          registerHoistedLocalNestedFunctions(statements);
          registerLocalDeclarationShadows(statements);
          ts.forEachChild(current, visitClosedOverNode);
          popLocalClosedOverScope();
          return;
        }
        if (ts.isVariableDeclaration(current)) {
          const declarationScopes = localDeclarationScopes(current);
          const declarationUsesBranchEffects =
            isVarVariableDeclaration(current) && Boolean(currentLocalNestedBranchEffectScope());
          const assignmentScopes = declarationUsesBranchEffects
            ? currentLocalDeclarationScopes()
            : declarationScopes;
          markLocalBindings(current.name, declarationScopes);
          if (current.initializer) {
            visitClosedOverNode(current.initializer);
          }
          collectFsWriteAliasesFromBindingInto(
            current,
            assignmentScopes.fsWriteAliasScope,
            isClosedOverFsModuleExpression,
          );
          if (ts.isIdentifier(current.name) && current.initializer) {
            const nestedInitializer = unwrapExpression(current.initializer);
            if (
              ts.isFunctionExpression(nestedInitializer) ||
              ts.isArrowFunction(nestedInitializer)
            ) {
              registerLocalNestedFunctionRecord(
                current.name.text,
                localNestedRecordForNode(
                  nestedInitializer,
                  assignmentScopes.nestedFunctionScope,
                  currentLocalNestedFunctionScope(),
                ),
                assignmentScopes.nestedFunctionScope,
              );
            } else {
              registerLocalNestedFunctionRecord(
                current.name.text,
                ts.isObjectLiteralExpression(nestedInitializer)
                  ? knownObjectLiteralNestedWrapperValue
                  : cloneWrapperFunctionValue(resolveLocalNestedExpression(current.initializer)),
                assignmentScopes.nestedFunctionScope,
              );
            }
            if (declarationUsesBranchEffects) {
              recordLocalNestedBranchAssignment(
                current.name.text,
                assignmentScopes.nestedFunctionScope.get(current.name.text),
                declarationScopes.nestedFunctionScope,
              );
            }
            registerLocalNestedObjectMethods(
              current.name.text,
              current.initializer,
              assignmentScopes.nestedFunctionScope,
              currentLocalNestedFunctionScope(),
              declarationUsesBranchEffects,
              declarationScopes.nestedFunctionScope,
            );
            assignmentScopes.requireAliasScope.set(
              current.name.text,
              isClosedOverRequireAliasExpression(current.initializer),
            );
            assignmentScopes.fsModuleBindingScope.set(
              current.name.text,
              isClosedOverFsModuleExpression(current.initializer),
            );
            assignmentScopes.fsWriteAliasScope.set(
              current.name.text,
              legacyClosedOverFsWriteName(current.initializer),
            );
            if (declarationUsesBranchEffects) {
              recordLocalNestedBranchFsIdentifierAssignment(
                current.name.text,
                isClosedOverFsModuleExpression(current.initializer),
                legacyClosedOverFsWriteName(current.initializer),
                isClosedOverRequireAliasExpression(current.initializer),
                declarationScopes.fsModuleBindingScope,
                declarationScopes.fsWriteAliasScope,
                declarationScopes.requireAliasScope,
              );
            }
          }
          if (ts.isObjectBindingPattern(current.name) && current.initializer) {
            registerLocalNestedObjectBindingInitializer(
              current.name,
              current.initializer,
              assignmentScopes.nestedFunctionScope,
              currentLocalNestedFunctionScope(),
            );
          }
          refreshCurrentLocalNestedFunctionAliases();
          return;
        }
        if (
          ts.isBinaryExpression(current) &&
          current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(current.left)
        ) {
          visitClosedOverNode(current.right);
          const requireAliasScope = localBindingWriteScope(
            current.left.text,
            localRequireAliasScopes,
          );
          const fsModuleBindingScope = localBindingWriteScope(
            current.left.text,
            localFsModuleBindingScopes,
          );
          const fsWriteAliasScope = localBindingWriteScope(
            current.left.text,
            localFsWriteAliasScopes,
          );
          const writesEnclosingNestedFunction =
            !isLocalBinding(current.left.text) && record.lexicalScope?.has(current.left.text);
          const nestedFunctionOwnerScope = writesEnclosingNestedFunction
            ? record.lexicalScope
            : localBindingWriteScope(current.left.text, localNestedFunctionScopes);
          const nestedFunctionScope = currentLocalNestedBranchEffectScope()
            ? currentLocalNestedFunctionScope()
            : nestedFunctionOwnerScope;
          const crossesLocalBlock = requireAliasScope !== currentLocalRequireAliasScope();
          const mergesNestedFunctionAssignment =
            !currentLocalNestedBranchEffectScope() &&
            (writesEnclosingNestedFunction || crossesLocalBlock);
          const nextRequireAlias = isClosedOverRequireAliasExpression(current.right);
          const nextFsModuleBinding = isClosedOverFsModuleExpression(current.right);
          const nextFsWriteAlias = legacyClosedOverFsWriteName(current.right);
          requireAliasScope.set(
            current.left.text,
            crossesLocalBlock
              ? requireAliasScope.get(current.left.text) === true || nextRequireAlias
              : nextRequireAlias,
          );
          fsModuleBindingScope.set(
            current.left.text,
            crossesLocalBlock
              ? fsModuleBindingScope.get(current.left.text) === true || nextFsModuleBinding
              : nextFsModuleBinding,
          );
          fsWriteAliasScope.set(
            current.left.text,
            crossesLocalBlock
              ? (fsWriteAliasScope.get(current.left.text) ?? nextFsWriteAlias)
              : nextFsWriteAlias,
          );
          const assignedNestedFunction = assignLocalNestedFunction(
            current.left.text,
            current.right,
            nestedFunctionScope,
            mergesNestedFunctionAssignment,
          );
          recordLocalNestedBranchAssignment(
            current.left.text,
            assignedNestedFunction,
            nestedFunctionOwnerScope,
          );
          registerLocalNestedObjectMethods(
            current.left.text,
            current.right,
            nestedFunctionScope,
            nestedFunctionScope,
            Boolean(currentLocalNestedBranchEffectScope()),
            nestedFunctionOwnerScope,
          );
          refreshCurrentLocalNestedFunctionAliases();
          return;
        }
        if (
          ts.isBinaryExpression(current) &&
          current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          rootedPropertyAccessPath(current.left)?.properties.length > 0
        ) {
          visitClosedOverNode(current.right);
          const propertyAccess = rootedPropertyAccessPath(current.left);
          const propertyName = propertyAccess.properties.join(".");
          const nestedFunctionOwnerScope = localNestedObjectMethodWriteScope(
            propertyAccess.rootName,
            propertyName,
          );
          const nestedFunctionScope = currentLocalNestedBranchEffectScope()
            ? currentLocalNestedFunctionScope()
            : nestedFunctionOwnerScope;
          const crossesLocalBlock = nestedFunctionOwnerScope !== currentLocalNestedFunctionScope();
          const mergesNestedFunctionAssignment =
            !currentLocalNestedBranchEffectScope() && crossesLocalBlock;
          const key = objectPropertyKey(propertyAccess.rootName, propertyName);
          const assignedNestedFunction = assignLocalNestedFunction(
            key,
            current.right,
            nestedFunctionScope,
            mergesNestedFunctionAssignment,
          );
          recordLocalNestedBranchAssignment(key, assignedNestedFunction, nestedFunctionOwnerScope);
          registerLocalNestedObjectMethods(
            key,
            current.right,
            nestedFunctionScope,
            nestedFunctionScope,
            Boolean(currentLocalNestedBranchEffectScope()),
            nestedFunctionOwnerScope,
          );
          refreshCurrentLocalNestedFunctionAliases();
          return;
        }
        if (ts.isParameter(current)) {
          markLocalBindings(current.name);
          return;
        }
        if (ts.isCallExpression(current)) {
          const localNestedFunctionName = callExpressionName(current.expression);
          const localNestedFunctionRootName = localNestedFunctionName?.split(".")[0] ?? null;
          const localNestedFunctionShadowed = localNestedFunctionRootName
            ? isLocalBinding(localNestedFunctionRootName)
            : false;
          const localNestedBinding = localNestedFunctionName
            ? resolveLocalNestedFunctionBindingValue(localNestedFunctionName)
            : { found: false, value: null };
          const calledWrapper = localNestedFunctionName
            ? localNestedBinding.found
              ? localNestedBinding.value
              : localNestedFunctionShadowed
                ? null
                : resolveWrapperFunction(localNestedFunctionName)
            : null;
          if (calledWrapper) {
            for (const localNestedRecord of wrapperRecords(calledWrapper)) {
              if (localNestedBinding.found && localNestedRecord.closesOverCurrentWrapper === true) {
                for (const [index, propertyNames] of collectClosedOverPathPropertyUses(
                  localNestedRecord,
                  activeClosedOverNodes,
                  current.arguments,
                )) {
                  const properties = closedOverUses.get(index) ?? new Set();
                  for (const propertyName of propertyNames) {
                    properties.add(propertyName);
                  }
                  closedOverUses.set(index, properties);
                }
              }
              const forwardedPropertyUses = collectLegacyPathPropertyParameters(
                localNestedRecord.node,
                localNestedRecord.aliases,
                localNestedRecord.moduleBindings,
                localNestedRecord.moduleProperties,
                localNestedRecord.requireAliases,
                localNestedRecord.createRequireShadows,
                activeClosedOverNodes,
                localNestedRecord.lexicalScope ?? null,
              );
              for (const [index, propertyNames] of forwardedPropertyUses) {
                const argument = callArgumentOrParameterDefault(
                  localNestedRecord.node,
                  current.arguments,
                  index,
                  {
                    allowLexicalIdentifierDefault: Boolean(localNestedRecord.lexicalScope),
                  },
                );
                if (!argument) {
                  continue;
                }
                for (const propertyName of propertyNames) {
                  for (const use of collectForwardedClosedOverPropertyUses(
                    argument,
                    propertyName,
                    localNestedRecord.node.parameters[index] ?? null,
                    localNestedRecord.node,
                    current.arguments,
                    {
                      allowLexicalIdentifierDefault: Boolean(localNestedRecord.lexicalScope),
                    },
                  )) {
                    appendClosedUse(use);
                  }
                }
              }
            }
          }
          const fsWriteName = legacyClosedOverFsWriteName(current.expression);
          if (fsWriteName && fsWriteCallMayWrite(fsWriteName, [...current.arguments])) {
            for (const argument of pathArgumentsForFsWrite(fsWriteName, [...current.arguments])) {
              for (const use of collectPathPropertyUses(
                argument,
                fsWriteName,
                resolveClosedParameterIndex,
                resolveClosedDestructuredParameterProperty,
                resolveClosedParameterPropertyUse,
                resolveClosedDestructuredParameterPropertyUses,
              )) {
                appendClosedUse(use);
              }
            }
          }
        }
        ts.forEachChild(current, visitClosedOverNode);
      }

      if (record.node.body && "statements" in record.node.body) {
        registerHoistedLocalNestedFunctions(record.node.body.statements);
      }
      for (const parameter of record.node.parameters ?? []) {
        if (parameter.initializer) {
          visitClosedOverNode(parameter.initializer);
        }
      }
      if (record.node.body && "statements" in record.node.body) {
        registerLocalDeclarationShadows(record.node.body.statements);
      }
      visitClosedOverNode(record.node.body ?? record.node);
      activeClosedOverNodes.delete(record.node);
      return closedOverUses;
    }

    function registerHoistedWrapperFunctionShadows(statements) {
      for (const statement of statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) {
          markWrapperRequireShadows(statement.name);
          markWrapperCreateRequireShadows(statement.name);
          currentNestedWrapperFunctionScope().set(
            statement.name.text,
            nestedWrapperRecordForNode(statement),
          );
        }
      }
    }

    function wrapperScopeStatements(current) {
      if ("statements" in current) {
        return current.statements;
      }
      if (ts.isCaseBlock(current)) {
        return current.clauses.flatMap((clause) => [...clause.statements]);
      }
      return [];
    }

    function visitBody(current) {
      if (isTypeSyntaxNode(current)) {
        return;
      }
      if (current !== node && ts.isFunctionLike(current)) {
        return;
      }
      if (ts.isIfStatement(current)) {
        visitBody(current.expression);
        const thenEffects = current.elseStatement ? createWrapperBranchEffects() : null;
        const elseEffects = current.elseStatement ? createWrapperBranchEffects() : null;
        pushWrapperBodyScope(true, thenEffects);
        visitBody(current.thenStatement);
        popWrapperBodyScope();
        if (current.elseStatement) {
          pushWrapperBodyScope(true, elseEffects);
          visitBody(current.elseStatement);
          popWrapperBodyScope();
          mergeExhaustiveWrapperBranchEffects(thenEffects, elseEffects);
        }
        return;
      }
      if (ts.isWhileStatement(current)) {
        visitBody(current.expression);
        pushWrapperBodyScope(true);
        visitBody(current.statement);
        popWrapperBodyScope();
        return;
      }
      if (ts.isDoStatement(current)) {
        pushWrapperBodyScope(true);
        visitBody(current.statement);
        popWrapperBodyScope();
        visitBody(current.expression);
        return;
      }
      if (ts.isForStatement(current)) {
        pushWrapperBodyScope();
        if (current.initializer) {
          visitBody(current.initializer);
        }
        if (current.condition) {
          visitBody(current.condition);
        }
        if (current.incrementor) {
          pushWrapperBodyScope(true);
          visitBody(current.incrementor);
          popWrapperBodyScope();
        }
        pushWrapperBodyScope(true);
        visitBody(current.statement);
        popWrapperBodyScope();
        popWrapperBodyScope();
        return;
      }
      if (ts.isForInStatement(current) || ts.isForOfStatement(current)) {
        visitBody(current.expression);
        pushWrapperBodyScope();
        visitBody(current.initializer);
        pushWrapperBodyScope(true);
        visitBody(current.statement);
        popWrapperBodyScope();
        popWrapperBodyScope();
        return;
      }
      if (ts.isTryStatement(current)) {
        pushWrapperBodyScope(true);
        visitBody(current.tryBlock);
        popWrapperBodyScope();
        if (current.catchClause) {
          pushWrapperBodyScope(true);
          visitBody(current.catchClause);
          popWrapperBodyScope();
        }
        if (current.finallyBlock) {
          pushWrapperBodyScope();
          visitBody(current.finallyBlock);
          popWrapperBodyScope();
        }
        return;
      }
      if (
        current !== node.body &&
        (ts.isBlock(current) ||
          ts.isModuleBlock(current) ||
          ts.isCaseBlock(current) ||
          ts.isCatchClause(current))
      ) {
        const branchBlockEffects = currentConditionalWrapperBodyScope()
          ? currentWrapperBranchEffectScope()
          : null;
        pushWrapperBodyScope(currentConditionalWrapperBodyScope(), branchBlockEffects);
        registerHoistedWrapperFunctionShadows(wrapperScopeStatements(current));
        ts.forEachChild(current, visitBody);
        popWrapperBodyScope();
        return;
      }
      if (ts.isVariableDeclaration(current)) {
        const isFsAliasBinding =
          ts.isObjectBindingPattern(current.name) &&
          current.initializer &&
          isWrapperFsBindingExpression(current.initializer);
        const nestedFunctionInitializer = current.initializer
          ? unwrapExpression(current.initializer)
          : null;
        const declarationIsVar = isVarVariableDeclaration(current);
        const declarationWrapperBranchEffects = currentWrapperBranchEffectScope();
        const declarationUsesConditionalScope =
          declarationIsVar && currentConditionalWrapperBodyScope();
        const declarationUsesBranchEffects =
          declarationIsVar && Boolean(declarationWrapperBranchEffects);
        const declarationFsWriteAliasOwnerScope = declarationIsVar
          ? bodyFsWriteAliasScopes[0]
          : currentBodyFsWriteAliasScope();
        const declarationFsModuleBindingOwnerScope = declarationIsVar
          ? bodyFsModuleBindingScopes[0]
          : currentBodyFsModuleBindingScope();
        const declarationRequireAliasOwnerScope = declarationIsVar
          ? bodyRequireAliasScopes[0]
          : currentBodyRequireAliasScope();
        const declarationNestedWrapperOwnerScope = declarationIsVar
          ? nestedWrapperFunctionScopes[0]
          : currentNestedWrapperFunctionScope();
        const declarationFsWriteAliasScope = declarationUsesConditionalScope
          ? currentBodyFsWriteAliasScope()
          : declarationFsWriteAliasOwnerScope;
        const declarationFsModuleBindingScope = declarationUsesConditionalScope
          ? currentBodyFsModuleBindingScope()
          : declarationFsModuleBindingOwnerScope;
        const declarationRequireAliasScope = declarationUsesConditionalScope
          ? currentBodyRequireAliasScope()
          : declarationRequireAliasOwnerScope;
        const declarationNestedWrapperScope = declarationUsesConditionalScope
          ? currentNestedWrapperFunctionScope()
          : declarationNestedWrapperOwnerScope;
        collectFsWriteAliasesFromBindingInto(
          current,
          declarationFsWriteAliasScope,
          isWrapperFsBindingExpression,
        );
        if (ts.isIdentifier(current.name)) {
          const nextRequireAlias = current.initializer
            ? isWrapperRequireAliasExpression(current.initializer)
            : false;
          const nextFsModuleBinding = current.initializer
            ? isWrapperFsBindingExpression(current.initializer)
            : false;
          const nextFsWriteAlias = current.initializer
            ? legacyWrapperFsWriteName(current.initializer)
            : null;
          shadowVisibleBodyFsWriteObjectAliases(current.name.text);
          shadowVisibleNestedWrapperObjectMethods(current.name.text);
          if (nextRequireAlias) {
            declarationRequireAliasScope.set(current.name.text, true);
          } else {
            markWrapperRequireShadows(current.name);
            if (declarationIsVar) {
              declarationRequireAliasScope.set(current.name.text, false);
            }
          }
          if (nextFsModuleBinding) {
            declarationFsModuleBindingScope.set(current.name.text, true);
          } else {
            markFsModuleShadows(current.name);
            if (declarationIsVar) {
              declarationFsModuleBindingScope.set(current.name.text, false);
            }
          }
          if (current.initializer) {
            registerBodyFsWriteObjectAliases(current.name.text, current.initializer);
          }
          markWrapperCreateRequireShadows(current.name);
          if (
            !nestedFunctionInitializer ||
            (!ts.isFunctionExpression(nestedFunctionInitializer) &&
              !ts.isArrowFunction(nestedFunctionInitializer))
          ) {
            declarationNestedWrapperScope.set(
              current.name.text,
              current.initializer && ts.isObjectLiteralExpression(nestedFunctionInitializer)
                ? knownObjectLiteralNestedWrapperValue
                : current.initializer
                  ? cloneWrapperFunctionValue(resolveNestedWrapperExpression(current.initializer))
                  : null,
            );
            if (current.initializer && declarationUsesBranchEffects) {
              recordWrapperBranchNestedWrapperAssignment(
                current.name.text,
                declarationNestedWrapperScope.get(current.name.text),
                declarationNestedWrapperOwnerScope,
              );
            }
            if (
              current.initializer &&
              declarationUsesConditionalScope &&
              !declarationUsesBranchEffects &&
              declarationNestedWrapperOwnerScope !== declarationNestedWrapperScope
            ) {
              declarationNestedWrapperOwnerScope.set(
                current.name.text,
                mergeWrapperAssignmentValues(
                  declarationNestedWrapperOwnerScope.get(current.name.text),
                  declarationNestedWrapperScope.get(current.name.text),
                ),
              );
            }
          }
          if (current.initializer && declarationUsesBranchEffects) {
            recordWrapperBranchFsIdentifierAssignment(
              current.name.text,
              nextFsModuleBinding,
              nextFsWriteAlias,
              nextRequireAlias,
              declarationFsModuleBindingOwnerScope,
              declarationFsWriteAliasOwnerScope,
              declarationRequireAliasOwnerScope,
            );
          }
        } else if (!isFsAliasBinding) {
          markFsModuleShadows(current.name);
          markWrapperRequireShadows(current.name);
          markWrapperCreateRequireShadows(current.name);
          markNestedWrapperFunctionShadows(current.name);
        }
        const initializerPropertyAccess = current.initializer
          ? namedObjectPropertyAccess(current.initializer)
          : null;
        const initializerParameterIndex = initializerPropertyAccess
          ? resolveParameterIndex(initializerPropertyAccess.objectName)
          : null;
        const initializerObjectIndex =
          current.initializer && ts.isIdentifier(unwrapExpression(current.initializer))
            ? resolveParameterIndex(unwrapExpression(current.initializer).text)
            : null;
        if (isParameterPropertyDestructure(current, parameterIndexes)) {
          const index = parameterIndexes.get(current.initializer.text);
          for (const [name, binding] of objectBindingParameterProperties(current.name, index)) {
            currentDestructuredParameterPropertyScope().set(name, binding);
          }
        } else if (
          ts.isIdentifier(current.name) &&
          initializerPropertyAccess &&
          initializerParameterIndex !== null
        ) {
          currentDestructuredParameterPropertyScope().set(current.name.text, {
            index: initializerParameterIndex,
            propertyName: initializerPropertyAccess.propertyName,
          });
        } else if (ts.isIdentifier(current.name) && initializerObjectIndex !== null) {
          currentParameterObjectBindingScope().set(current.name.text, initializerObjectIndex);
        } else {
          for (const name of bindingPatternNames(current.name)) {
            if (resolveDestructuredParameterProperty(name)) {
              currentShadowScope().add(name);
            }
            if (parameterIndexes.has(name)) {
              currentParameterObjectShadowScope().add(name);
            }
          }
        }
        if (!isFsAliasBinding) {
          markFsAliasShadows(current.name);
        }
        if (ts.isIdentifier(current.name) && current.initializer) {
          declarationFsWriteAliasScope.set(
            current.name.text,
            legacyWrapperFsWriteName(current.initializer),
          );
        } else if (ts.isIdentifier(current.name)) {
          declarationFsWriteAliasScope.set(current.name.text, null);
        }
        if (
          ts.isIdentifier(current.name) &&
          nestedFunctionInitializer &&
          (ts.isFunctionExpression(nestedFunctionInitializer) ||
            ts.isArrowFunction(nestedFunctionInitializer))
        ) {
          declarationNestedWrapperScope.set(
            current.name.text,
            nestedWrapperRecordForNode(nestedFunctionInitializer),
          );
          if (declarationUsesBranchEffects) {
            recordWrapperBranchNestedWrapperAssignment(
              current.name.text,
              declarationNestedWrapperScope.get(current.name.text),
              declarationNestedWrapperOwnerScope,
            );
          }
          if (
            declarationUsesConditionalScope &&
            !declarationUsesBranchEffects &&
            declarationNestedWrapperOwnerScope !== declarationNestedWrapperScope
          ) {
            declarationNestedWrapperOwnerScope.set(
              current.name.text,
              mergeWrapperAssignmentValues(
                declarationNestedWrapperOwnerScope.get(current.name.text),
                declarationNestedWrapperScope.get(current.name.text),
              ),
            );
          }
        }
        if (ts.isIdentifier(current.name) && current.initializer) {
          const declarationObjectMethods = registerNestedWrapperObjectMethods(
            current.name.text,
            current.initializer,
            declarationNestedWrapperScope,
            declarationUsesBranchEffects,
            declarationNestedWrapperOwnerScope,
          );
          if (
            declarationUsesConditionalScope &&
            !declarationUsesBranchEffects &&
            declarationNestedWrapperOwnerScope !== declarationNestedWrapperScope
          ) {
            for (const [key, value] of declarationObjectMethods) {
              declarationNestedWrapperOwnerScope.set(
                key,
                mergeWrapperAssignmentValues(declarationNestedWrapperOwnerScope.get(key), value),
              );
            }
          }
        }
        if (ts.isObjectBindingPattern(current.name) && current.initializer) {
          registerNestedWrapperObjectBindingInitializer(
            current.name,
            current.initializer,
            declarationNestedWrapperScope,
          );
        }
        refreshCurrentNestedWrapperFunctionAliases();
      }
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(current.left)
      ) {
        const fsModuleBindingScope = bodyFsModuleBindingWriteScope(current.left.text);
        const fsWriteAliasScope = bodyFsWriteAliasWriteScope(current.left.text);
        const requireAliasScope = bodyRequireAliasWriteScope(current.left.text);
        const nextFsModuleBinding = isWrapperFsBindingExpression(current.right);
        const nextFsWriteAlias = legacyWrapperFsWriteName(current.right);
        const nextRequireAlias = isWrapperRequireAliasExpression(current.right);
        const wrapperBranchEffects = currentWrapperBranchEffectScope();
        if (wrapperBranchEffects) {
          currentBodyFsModuleBindingScope().set(current.left.text, nextFsModuleBinding);
          currentBodyFsWriteAliasScope().set(current.left.text, nextFsWriteAlias);
          currentBodyRequireAliasScope().set(current.left.text, nextRequireAlias);
          recordWrapperBranchFsIdentifierAssignment(
            current.left.text,
            nextFsModuleBinding,
            nextFsWriteAlias,
            nextRequireAlias,
            fsModuleBindingScope,
            fsWriteAliasScope,
            requireAliasScope,
          );
        } else {
          fsModuleBindingScope.set(
            current.left.text,
            currentConditionalWrapperBodyScope()
              ? fsModuleBindingScope.get(current.left.text) === true || nextFsModuleBinding
              : nextFsModuleBinding,
          );
          fsWriteAliasScope.set(
            current.left.text,
            currentConditionalWrapperBodyScope()
              ? (fsWriteAliasScope.get(current.left.text) ?? nextFsWriteAlias)
              : nextFsWriteAlias,
          );
          requireAliasScope.set(
            current.left.text,
            currentConditionalWrapperBodyScope()
              ? requireAliasScope.get(current.left.text) === true || nextRequireAlias
              : nextRequireAlias,
          );
        }
        shadowVisibleBodyFsWriteObjectAliases(current.left.text);
        clearBodyFsWriteObjectAliases(currentBodyFsWriteAliasScope(), current.left.text);
        registerBodyFsWriteObjectAliases(current.left.text, current.right);
        const exhaustiveNestedWrapperBranch = Boolean(wrapperBranchEffects);
        const optionalNestedWrapperBranch =
          currentConditionalWrapperBodyScope() && !exhaustiveNestedWrapperBranch;
        const nestedWrapperOwnerScope = nestedWrapperFunctionWriteScope(current.left.text);
        const nestedWrapperTargetScope = currentConditionalWrapperBodyScope()
          ? currentNestedWrapperFunctionScope()
          : nestedWrapperOwnerScope;
        clearNestedWrapperObjectMethods(nestedWrapperTargetScope, current.left.text);
        const assignedNestedWrapper =
          ts.isFunctionExpression(unwrapExpression(current.right)) ||
          ts.isArrowFunction(unwrapExpression(current.right))
            ? nestedWrapperRecordForNode(unwrapExpression(current.right))
            : ts.isObjectLiteralExpression(unwrapExpression(current.right))
              ? knownObjectLiteralNestedWrapperValue
              : cloneWrapperFunctionValue(resolveNestedWrapperExpression(current.right));
        nestedWrapperTargetScope.set(current.left.text, assignedNestedWrapper);
        if (optionalNestedWrapperBranch && nestedWrapperOwnerScope !== nestedWrapperTargetScope) {
          nestedWrapperOwnerScope.set(
            current.left.text,
            mergeWrapperAssignmentValues(
              nestedWrapperOwnerScope.get(current.left.text),
              assignedNestedWrapper,
            ),
          );
        }
        if (exhaustiveNestedWrapperBranch) {
          recordWrapperBranchNestedWrapperAssignment(
            current.left.text,
            assignedNestedWrapper,
            nestedWrapperOwnerScope,
          );
        }
        const assignedNestedWrapperObjectMethods = registerNestedWrapperObjectMethods(
          current.left.text,
          current.right,
          nestedWrapperTargetScope,
          exhaustiveNestedWrapperBranch,
          nestedWrapperOwnerScope,
        );
        if (optionalNestedWrapperBranch && nestedWrapperOwnerScope !== nestedWrapperTargetScope) {
          for (const [key, value] of assignedNestedWrapperObjectMethods) {
            nestedWrapperOwnerScope.set(
              key,
              mergeWrapperAssignmentValues(nestedWrapperOwnerScope.get(key), value),
            );
          }
        }
        refreshCurrentNestedWrapperFunctionAliases();
      }
      if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        rootedPropertyAccessPath(current.left)?.properties.length > 0
      ) {
        const propertyAccess = rootedPropertyAccessPath(current.left);
        const propertyName = propertyAccess.properties.join(".");
        if (propertyAccess.properties.length === 1) {
          setBodyFsWriteObjectAlias(
            currentBodyFsWriteAliasScope(),
            objectPropertyKey(propertyAccess.rootName, propertyName),
            legacyWrapperFsWriteName(current.right),
          );
        }
        const nestedWrapperKey = objectPropertyKey(propertyAccess.rootName, propertyName);
        const assignedNestedWrapper =
          ts.isFunctionExpression(unwrapExpression(current.right)) ||
          ts.isArrowFunction(unwrapExpression(current.right))
            ? nestedWrapperRecordForNode(unwrapExpression(current.right))
            : ts.isObjectLiteralExpression(unwrapExpression(current.right))
              ? knownObjectLiteralNestedWrapperValue
              : cloneWrapperFunctionValue(resolveNestedWrapperExpression(current.right));
        const exhaustiveNestedWrapperBranch = Boolean(currentWrapperBranchEffectScope());
        const optionalNestedWrapperBranch =
          currentConditionalWrapperBodyScope() && !exhaustiveNestedWrapperBranch;
        const nestedWrapperOwnerScope = nestedWrapperObjectMethodWriteScope(
          propertyAccess.rootName,
          propertyName,
        );
        const nestedWrapperTargetScope = currentConditionalWrapperBodyScope()
          ? currentNestedWrapperFunctionScope()
          : nestedWrapperOwnerScope;
        clearNestedWrapperObjectMethods(nestedWrapperTargetScope, nestedWrapperKey);
        nestedWrapperTargetScope.set(nestedWrapperKey, assignedNestedWrapper);
        if (optionalNestedWrapperBranch && nestedWrapperOwnerScope !== nestedWrapperTargetScope) {
          nestedWrapperOwnerScope.set(
            nestedWrapperKey,
            mergeWrapperAssignmentValues(
              nestedWrapperOwnerScope.get(nestedWrapperKey),
              assignedNestedWrapper,
            ),
          );
        }
        if (exhaustiveNestedWrapperBranch) {
          recordWrapperBranchNestedWrapperAssignment(
            nestedWrapperKey,
            assignedNestedWrapper,
            nestedWrapperOwnerScope,
          );
        }
        const assignedNestedWrapperObjectMethods = registerNestedWrapperObjectMethods(
          nestedWrapperKey,
          current.right,
          nestedWrapperTargetScope,
          exhaustiveNestedWrapperBranch,
          nestedWrapperOwnerScope,
        );
        if (optionalNestedWrapperBranch && nestedWrapperOwnerScope !== nestedWrapperTargetScope) {
          for (const [key, value] of assignedNestedWrapperObjectMethods) {
            nestedWrapperOwnerScope.set(
              key,
              mergeWrapperAssignmentValues(nestedWrapperOwnerScope.get(key), value),
            );
          }
        }
        refreshCurrentNestedWrapperFunctionAliases();
      }
      markParameterAssignment(current);
      if (ts.isCallExpression(current)) {
        const fsWriteName = legacyWrapperFsWriteName(current.expression);
        if (fsWriteName && fsWriteCallMayWrite(fsWriteName, [...current.arguments])) {
          for (const argument of pathArgumentsForFsWrite(fsWriteName, [...current.arguments])) {
            for (const use of collectPathPropertyUses(
              argument,
              fsWriteName,
              resolveParameterIndex,
              resolveDestructuredParameterProperty,
              resolveParameterPropertyUse,
              resolveDestructuredParameterPropertyUses,
            )) {
              const properties = propertyUses.get(use.index) ?? new Set();
              properties.add(use.propertyName);
              propertyUses.set(use.index, properties);
            }
          }
        }
        const wrapperName = callExpressionName(current.expression);
        const nestedWrapperRecord = wrapperName
          ? resolveNestedWrapperFunction(wrapperName)
          : undefined;
        const wrapperRecord = wrapperName
          ? nestedWrapperRecord === undefined
            ? resolveWrapperFunction(wrapperName)
            : nestedWrapperRecord
          : null;
        for (const record of wrapperRecords(wrapperRecord)) {
          if (nestedWrapperRecord !== undefined && record.closesOverCurrentWrapper === true) {
            for (const [index, propertyNames] of collectClosedOverPathPropertyUses(
              record,
              activeWrapperNodes,
              current.arguments,
            )) {
              const properties = propertyUses.get(index) ?? new Set();
              for (const propertyName of propertyNames) {
                properties.add(propertyName);
              }
              propertyUses.set(index, properties);
            }
          }
          const forwardedPropertyUses = collectLegacyPathPropertyParameters(
            record.node,
            record.aliases,
            record.moduleBindings,
            record.moduleProperties,
            record.requireAliases,
            record.createRequireShadows,
            activeWrapperNodes,
            record.lexicalScope ?? null,
          );
          for (const [index, propertyNames] of forwardedPropertyUses) {
            const argument = callArgumentOrParameterDefault(record.node, current.arguments, index, {
              allowLexicalIdentifierDefault: record.closesOverCurrentWrapper === true,
            });
            if (!argument) {
              continue;
            }
            for (const propertyName of propertyNames) {
              for (const use of collectForwardedWrapperPropertyUses(
                argument,
                propertyName,
                record.node.parameters[index] ?? null,
                record.node,
                current.arguments,
                {
                  allowLexicalIdentifierDefault: record.closesOverCurrentWrapper === true,
                },
              )) {
                const properties = propertyUses.get(use.index) ?? new Set();
                properties.add(use.propertyName);
                propertyUses.set(use.index, properties);
              }
            }
          }
        }
      }
      ts.forEachChild(current, visitBody);
    }
    if (node.body) {
      if ("statements" in node.body) {
        registerHoistedWrapperFunctionShadows(node.body.statements);
      }
      visitBody(node.body);
    }
    activeWrapperNodes.delete(node);
    return propertyUses;
  }

  function callArgumentOrParameterDefault(
    wrapperNode,
    argumentsList,
    index,
    optionsOrActiveDefaultIndexes = {},
    maybeActiveDefaultIndexes = new Set(),
  ) {
    const options =
      optionsOrActiveDefaultIndexes instanceof Set ? {} : optionsOrActiveDefaultIndexes;
    const activeDefaultIndexes =
      optionsOrActiveDefaultIndexes instanceof Set
        ? optionsOrActiveDefaultIndexes
        : maybeActiveDefaultIndexes;
    const allowLexicalIdentifierDefault = options.allowLexicalIdentifierDefault ?? true;
    const argument = argumentsList[index];
    if (argument && !isKnownUndefinedExpression(argument)) {
      return argument;
    }
    const initializer = wrapperNode.parameters[index]?.initializer ?? null;
    if (!initializer) {
      return null;
    }
    const unwrapped = unwrapExpression(initializer);
    if (ts.isIdentifier(unwrapped)) {
      const parameterBinding = earlierParameterBindingForIdentifier(
        unwrapped.text,
        wrapperNode,
        index,
      );
      if (parameterBinding && !activeDefaultIndexes.has(parameterBinding.index)) {
        activeDefaultIndexes.add(parameterBinding.index);
        const resolved = resolveEarlierParameterBindingExpression(
          parameterBinding,
          wrapperNode,
          argumentsList,
          options,
          activeDefaultIndexes,
        );
        activeDefaultIndexes.delete(parameterBinding.index);
        return resolved ?? null;
      }
      if (!allowLexicalIdentifierDefault) {
        return null;
      }
    }
    if (!allowLexicalIdentifierDefault) {
      const resolved = resolveEarlierParameterDefaultExpression(
        unwrapped,
        wrapperNode,
        argumentsList,
        index,
        options,
        activeDefaultIndexes,
      );
      if (resolved) {
        return resolved;
      }
      const spreadOnlyObjectLiteral =
        ts.isObjectLiteralExpression(unwrapped) &&
        objectLiteralIdentifiersAreSpreadSourcesOnly(unwrapped);
      return earlierParameterReferenceIndexes(unwrapped, wrapperNode, index).size === 0 &&
        (!expressionContainsIdentifier(unwrapped) || spreadOnlyObjectLiteral)
        ? initializer
        : null;
    }
    return initializer;
  }

  function earlierParameterBindingForIdentifier(name, wrapperNode, parameterPosition) {
    for (let index = 0; index < parameterPosition; index++) {
      const candidate = wrapperNode.parameters[index];
      if (!candidate) {
        continue;
      }
      if (ts.isIdentifier(candidate.name) && candidate.name.text === name) {
        return { index, propertyName: null };
      }
      if (ts.isObjectBindingPattern(candidate.name)) {
        const binding = objectBindingParameterProperties(candidate.name, index).get(name);
        if (binding) {
          return binding;
        }
      }
    }
    return null;
  }

  function earlierParameterReferenceBindings(expression, wrapperNode, parameterPosition) {
    const bindings = new Map();
    function addBinding(binding) {
      bindings.set(`${binding.index}:${binding.propertyName ?? ""}`, binding);
    }
    function visitReference(current) {
      if (ts.isPropertyAccessExpression(current)) {
        visitReference(current.expression);
        return;
      }
      if (ts.isPropertyAssignment(current)) {
        visitReference(current.initializer);
        return;
      }
      if (ts.isShorthandPropertyAssignment(current)) {
        visitReference(current.name);
        return;
      }
      if (ts.isIdentifier(current)) {
        const binding = earlierParameterBindingForIdentifier(
          current.text,
          wrapperNode,
          parameterPosition,
        );
        if (binding) {
          addBinding(binding);
        }
        return;
      }
      ts.forEachChild(current, visitReference);
    }
    visitReference(expression);
    return [...bindings.values()];
  }

  function earlierParameterReferenceIndexes(expression, wrapperNode, parameterPosition) {
    return new Set(
      earlierParameterReferenceBindings(expression, wrapperNode, parameterPosition).map(
        (binding) => binding.index,
      ),
    );
  }

  function expressionContainsIdentifier(expression) {
    let found = false;
    function visitIdentifier(current) {
      if (ts.isPropertyAccessExpression(current)) {
        visitIdentifier(current.expression);
        return;
      }
      if (ts.isPropertyAssignment(current)) {
        visitIdentifier(current.initializer);
        return;
      }
      if (ts.isMethodDeclaration(current) || ts.isGetAccessor(current)) {
        if (current.body) {
          visitIdentifier(current.body);
        }
        return;
      }
      if (ts.isSetAccessor(current)) {
        visitIdentifier(current.parameters[0]);
        if (current.body) {
          visitIdentifier(current.body);
        }
        return;
      }
      if (ts.isIdentifier(current)) {
        found = true;
        return;
      }
      ts.forEachChild(current, visitIdentifier);
    }
    visitIdentifier(expression);
    return found;
  }

  function objectLiteralIdentifiersAreSpreadSourcesOnly(objectLiteral) {
    let valid = true;
    function visitExpression(current) {
      if (!valid) {
        return;
      }
      if (ts.isSpreadAssignment(current)) {
        const spreadExpression = unwrapExpression(current.expression);
        if (!ts.isIdentifier(spreadExpression)) {
          visitExpression(spreadExpression);
        }
        return;
      }
      if (ts.isPropertyAssignment(current)) {
        visitExpression(current.initializer);
        return;
      }
      if (ts.isShorthandPropertyAssignment(current) || ts.isIdentifier(current)) {
        valid = false;
        return;
      }
      ts.forEachChild(current, visitExpression);
    }
    visitExpression(objectLiteral);
    return valid;
  }

  function resolveEarlierParameterDefaultExpression(
    expression,
    wrapperNode,
    argumentsList,
    parameterPosition,
    options,
    activeDefaultIndexes,
  ) {
    const resolvedExpressions = [];
    for (const binding of earlierParameterReferenceBindings(
      expression,
      wrapperNode,
      parameterPosition,
    )) {
      const referencedParameterIndex = binding.index;
      if (activeDefaultIndexes.has(referencedParameterIndex)) {
        continue;
      }
      activeDefaultIndexes.add(referencedParameterIndex);
      const resolved = resolveEarlierParameterBindingExpression(
        binding,
        wrapperNode,
        argumentsList,
        options,
        activeDefaultIndexes,
      );
      activeDefaultIndexes.delete(referencedParameterIndex);
      if (resolved) {
        resolvedExpressions.push(resolved);
      }
    }
    if (resolvedExpressions.length === 0) {
      return null;
    }
    return resolvedExpressions.length === 1
      ? resolvedExpressions[0]
      : ts.factory.createArrayLiteralExpression(resolvedExpressions);
  }

  function propertyAccessExpressionForName(expression, propertyName) {
    return /^[A-Za-z_$][\w$]*$/u.test(propertyName)
      ? ts.factory.createPropertyAccessExpression(expression, propertyName)
      : ts.factory.createElementAccessExpression(
          expression,
          ts.factory.createStringLiteral(propertyName),
        );
  }

  function propertyPathExpression(expression, propertyPath) {
    let current = expression;
    for (const propertyName of propertyPath) {
      current = propertyAccessExpressionForName(current, propertyName);
    }
    return current;
  }

  function trackedPropertyPathExpression(expression, propertyPath) {
    const unwrapped = unwrapExpression(expression);
    if (!ts.isIdentifier(unwrapped)) {
      return propertyPathExpression(expression, propertyPath);
    }
    const propertyName = propertyPath.join(".");
    const property = lookupLegacyObjectPropertyEntry(unwrapped.text, propertyName);
    if (property.found) {
      if (property.value === true) {
        return ts.factory.createStringLiteral("sessions.json");
      }
      return property.value === explicitUndefinedLegacyObjectPropertyValue
        ? ts.factory.createIdentifier("undefined")
        : ts.factory.createStringLiteral("state/openclaw.sqlite");
    }
    return lookupKnownLegacyObjectLiteral(unwrapped.text)
      ? ts.factory.createIdentifier("undefined")
      : null;
  }

  function objectLiteralPropertyPathInitializer(objectLiteral, propertyPath) {
    let current = objectLiteral;
    for (const [index, propertyName] of propertyPath.entries()) {
      if (!ts.isObjectLiteralExpression(current)) {
        return null;
      }
      const initializer = objectLiteralPropertyInitializer(current, propertyName);
      if (!initializer || initializer === unknownObjectLiteralPropertyInitializer) {
        return null;
      }
      if (index === propertyPath.length - 1) {
        return initializer;
      }
      current = unwrapExpression(initializer);
      if (ts.isIdentifier(current)) {
        return trackedPropertyPathExpression(current, propertyPath.slice(index + 1));
      }
    }
    return null;
  }

  function objectLiteralPropertyPathLegacyValue(
    objectLiteral,
    propertyPath,
    maxScopeIndex = legacyObjectPropertyScopes.length - 1,
  ) {
    if (propertyPath.length === 0) {
      return expressionContainsLegacyStore(objectLiteral);
    }
    const [propertyName, ...remainingPath] = propertyPath;
    let result = null;
    for (const property of objectLiteral.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spreadExpression = unwrapExpression(property.expression);
        let spreadValue = null;
        if (ts.isIdentifier(spreadExpression)) {
          spreadValue = lookupLegacyObjectProperty(
            spreadExpression.text,
            propertyPath.join("."),
            maxScopeIndex,
          );
        } else if (ts.isObjectLiteralExpression(spreadExpression)) {
          spreadValue = objectLiteralPropertyPathLegacyValue(
            spreadExpression,
            propertyPath,
            maxScopeIndex,
          );
        } else if (expressionContainsLegacyStore(property.expression)) {
          spreadValue = true;
        }
        if (spreadValue !== null) {
          result = spreadValue;
        }
        continue;
      }
      if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === propertyName) {
        if (remainingPath.length === 0) {
          result = expressionContainsLegacyStore(property.initializer);
          continue;
        }
        const unwrapped = unwrapExpression(property.initializer);
        result = ts.isObjectLiteralExpression(unwrapped)
          ? objectLiteralPropertyPathLegacyValue(unwrapped, remainingPath, maxScopeIndex)
          : ts.isIdentifier(unwrapped)
            ? lookupLegacyObjectProperty(unwrapped.text, remainingPath.join("."), maxScopeIndex)
            : null;
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
        result =
          remainingPath.length === 0
            ? expressionContainsLegacyStore(property.name)
            : lookupLegacyObjectProperty(
                property.name.text,
                remainingPath.join("."),
                maxScopeIndex,
              );
      }
    }
    return result;
  }

  function bindingElementForProperty(bindingPattern, propertyName) {
    for (const element of bindingPattern.elements) {
      const boundPropertyName = element.propertyName
        ? propertyNameText(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : null;
      if (boundPropertyName === propertyName) {
        return element;
      }
    }
    return null;
  }

  function bindingElementDefaultInitializerForPath(bindingPattern, propertyPath) {
    const [propertyName, ...remainingPath] = propertyPath;
    const element = propertyName ? bindingElementForProperty(bindingPattern, propertyName) : null;
    if (!element) {
      return null;
    }
    if (remainingPath.length === 0) {
      return element.initializer ?? null;
    }
    return ts.isObjectBindingPattern(element.name)
      ? bindingElementDefaultInitializerForPath(element.name, remainingPath)
      : null;
  }

  function propertyPathInitializerFromExpression(expression, propertyPath) {
    if (propertyPath.length === 0) {
      return expression;
    }
    const unwrapped = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(unwrapped)) {
      return objectLiteralPropertyPathInitializer(unwrapped, propertyPath);
    }
    if (ts.isIdentifier(unwrapped)) {
      return trackedPropertyPathExpression(unwrapped, propertyPath);
    }
    return null;
  }

  function bindingElementAncestorDefaultInitializerForObjectLiteral(
    bindingPattern,
    propertyPath,
    objectLiteral,
    resolveSpreadProperty,
  ) {
    const [propertyName, ...remainingPath] = propertyPath;
    const element = propertyName ? bindingElementForProperty(bindingPattern, propertyName) : null;
    if (!element || remainingPath.length === 0) {
      return null;
    }
    const propertyState = objectLiteralPropertyInitializerState(
      objectLiteral,
      propertyName,
      resolveSpreadProperty,
    );
    if (
      (propertyState.kind === "missing" || propertyState.kind === "undefined") &&
      element.initializer
    ) {
      return propertyPathInitializerFromExpression(element.initializer, remainingPath);
    }
    if (
      propertyState.kind === "initializer" &&
      ts.isObjectLiteralExpression(unwrapExpression(propertyState.initializer)) &&
      ts.isObjectBindingPattern(element.name)
    ) {
      return bindingElementAncestorDefaultInitializerForObjectLiteral(
        element.name,
        remainingPath,
        unwrapExpression(propertyState.initializer),
        resolveSpreadProperty,
      );
    }
    if (
      propertyState.kind === "initializer" &&
      ts.isIdentifier(unwrapExpression(propertyState.initializer)) &&
      ts.isObjectBindingPattern(element.name)
    ) {
      return bindingElementAncestorDefaultInitializerForIdentifier(
        element.name,
        remainingPath,
        unwrapExpression(propertyState.initializer).text,
      );
    }
    return null;
  }

  function bindingElementAncestorDefaultInitializerForIdentifier(
    bindingPattern,
    propertyPath,
    sourceName,
  ) {
    const [propertyName, ...remainingPath] = propertyPath;
    const element = propertyName ? bindingElementForProperty(bindingPattern, propertyName) : null;
    if (!element || remainingPath.length === 0) {
      return null;
    }
    const parentProperty = lookupLegacyObjectPropertyEntry(sourceName, propertyName);
    const parentMissingOrUndefined =
      (!parentProperty.found && lookupKnownLegacyObjectLiteral(sourceName)) ||
      parentProperty.value === explicitUndefinedLegacyObjectPropertyValue;
    if (parentMissingOrUndefined && element.initializer) {
      return propertyPathInitializerFromExpression(element.initializer, remainingPath);
    }
    const parentObjectName = `${sourceName}.${propertyName}`;
    if (
      parentProperty.found &&
      lookupKnownLegacyObjectLiteral(parentObjectName) &&
      ts.isObjectBindingPattern(element.name)
    ) {
      return bindingElementAncestorDefaultInitializerForIdentifier(
        element.name,
        remainingPath,
        parentObjectName,
      );
    }
    return null;
  }

  function bindingElementAncestorDefaultInitializer(
    bindingPattern,
    propertyPath,
    sourceExpression,
    resolveSpreadProperty = null,
  ) {
    const source = unwrapExpression(sourceExpression);
    if (ts.isObjectLiteralExpression(source)) {
      return bindingElementAncestorDefaultInitializerForObjectLiteral(
        bindingPattern,
        propertyPath,
        source,
        resolveSpreadProperty,
      );
    }
    if (ts.isIdentifier(source)) {
      return bindingElementAncestorDefaultInitializerForIdentifier(
        bindingPattern,
        propertyPath,
        source.text,
      );
    }
    return null;
  }

  function appliedBindingElementDefaultInitializer(
    bindingPattern,
    propertyPath,
    sourceExpression,
    resolveSpreadProperty = null,
  ) {
    const leafInitializer = bindingElementDefaultInitializerForPath(bindingPattern, propertyPath);
    if (
      leafInitializer &&
      objectBindingPropertyDefaultApplies(
        bindingPattern,
        propertyPath,
        sourceExpression,
        resolveSpreadProperty,
      )
    ) {
      return leafInitializer;
    }
    return bindingElementAncestorDefaultInitializer(
      bindingPattern,
      propertyPath,
      sourceExpression,
      resolveSpreadProperty,
    );
  }

  function objectBindingPropertyDefaultAppliesForObjectLiteral(
    bindingPattern,
    propertyPath,
    objectLiteral,
    resolveSpreadProperty,
  ) {
    const [propertyName, ...remainingPath] = propertyPath;
    const element = propertyName ? bindingElementForProperty(bindingPattern, propertyName) : null;
    if (!element) {
      return false;
    }
    const propertyState = objectLiteralPropertyInitializerState(
      objectLiteral,
      propertyName,
      resolveSpreadProperty,
    );
    if (remainingPath.length === 0) {
      return propertyState.kind === "missing" || propertyState.kind === "undefined";
    }
    if (!ts.isObjectBindingPattern(element.name)) {
      return false;
    }
    if (
      propertyState.kind === "initializer" &&
      ts.isObjectLiteralExpression(unwrapExpression(propertyState.initializer))
    ) {
      return objectBindingPropertyDefaultAppliesForObjectLiteral(
        element.name,
        remainingPath,
        unwrapExpression(propertyState.initializer),
        resolveSpreadProperty,
      );
    }
    if (
      propertyState.kind === "initializer" &&
      ts.isIdentifier(unwrapExpression(propertyState.initializer))
    ) {
      return objectBindingPropertyDefaultAppliesForIdentifier(
        element.name,
        remainingPath,
        unwrapExpression(propertyState.initializer).text,
      );
    }
    if (
      (propertyState.kind === "missing" || propertyState.kind === "undefined") &&
      element.initializer &&
      ts.isObjectLiteralExpression(unwrapExpression(element.initializer))
    ) {
      return objectBindingPropertyDefaultAppliesForObjectLiteral(
        element.name,
        remainingPath,
        unwrapExpression(element.initializer),
        resolveSpreadProperty,
      );
    }
    return false;
  }

  function objectBindingPropertyDefaultAppliesForIdentifier(
    bindingPattern,
    propertyPath,
    sourceName,
  ) {
    const [propertyName, ...remainingPath] = propertyPath;
    const element = propertyName ? bindingElementForProperty(bindingPattern, propertyName) : null;
    if (!element) {
      return false;
    }
    const exactProperty = lookupLegacyObjectPropertyEntry(sourceName, propertyPath.join("."));
    if (remainingPath.length === 0) {
      return exactProperty.found
        ? exactProperty.value === explicitUndefinedLegacyObjectPropertyValue
        : lookupKnownLegacyObjectLiteral(sourceName);
    }
    if (exactProperty.found) {
      return exactProperty.value === explicitUndefinedLegacyObjectPropertyValue;
    }
    if (!ts.isObjectBindingPattern(element.name)) {
      return false;
    }
    const parentProperty = lookupLegacyObjectPropertyEntry(sourceName, propertyName);
    const parentObjectName = `${sourceName}.${propertyName}`;
    if (parentProperty.found && lookupKnownLegacyObjectLiteral(parentObjectName)) {
      return objectBindingPropertyDefaultAppliesForIdentifier(
        element.name,
        remainingPath,
        parentObjectName,
      );
    }
    const parentMissingOrUndefined =
      (!parentProperty.found && lookupKnownLegacyObjectLiteral(sourceName)) ||
      parentProperty.value === explicitUndefinedLegacyObjectPropertyValue;
    if (
      parentMissingOrUndefined &&
      element.initializer &&
      ts.isObjectLiteralExpression(unwrapExpression(element.initializer))
    ) {
      return objectBindingPropertyDefaultAppliesForObjectLiteral(
        element.name,
        remainingPath,
        unwrapExpression(element.initializer),
        null,
      );
    }
    return false;
  }

  function objectBindingPropertyDefaultApplies(
    bindingPattern,
    propertyPath,
    sourceExpression,
    resolveSpreadProperty = null,
  ) {
    if (propertyPath.length === 0) {
      return false;
    }
    const source = unwrapExpression(sourceExpression);
    if (ts.isObjectLiteralExpression(source)) {
      return objectBindingPropertyDefaultAppliesForObjectLiteral(
        bindingPattern,
        propertyPath,
        source,
        resolveSpreadProperty,
      );
    }
    if (ts.isIdentifier(source)) {
      return objectBindingPropertyDefaultAppliesForIdentifier(
        bindingPattern,
        propertyPath,
        source.text,
      );
    }
    return false;
  }

  function resolveEarlierParameterBindingExpression(
    binding,
    wrapperNode,
    argumentsList,
    options,
    activeDefaultIndexes,
  ) {
    const resolved = callArgumentOrParameterDefault(
      wrapperNode,
      argumentsList,
      binding.index,
      options,
      activeDefaultIndexes,
    );
    if (!resolved || !binding.propertyName) {
      return resolved;
    }
    const propertyPath = binding.propertyName.split(".");
    const unwrapped = unwrapExpression(resolved);
    if (ts.isObjectLiteralExpression(unwrapped)) {
      return objectLiteralPropertyPathInitializer(unwrapped, propertyPath);
    }
    return trackedPropertyPathExpression(resolved, propertyPath);
  }

  function resolveBindingDefaultInitializerExpression(
    initializer,
    wrapperNode,
    argumentsList,
    parameter,
    options = {},
  ) {
    if (!wrapperNode || !parameter) {
      return initializer;
    }
    const parameterPosition = wrapperNode.parameters.findIndex(
      (candidate) => candidate === parameter,
    );
    if (parameterPosition <= 0) {
      return options.allowLexicalIdentifierDefault === false &&
        expressionContainsIdentifier(unwrapExpression(initializer))
        ? null
        : initializer;
    }
    const unwrapped = unwrapExpression(initializer);
    if (!ts.isIdentifier(unwrapped)) {
      if (options.allowLexicalIdentifierDefault !== false) {
        return initializer;
      }
      const resolved = resolveEarlierParameterDefaultExpression(
        unwrapped,
        wrapperNode,
        argumentsList,
        parameterPosition,
        options,
        new Set(),
      );
      if (resolved) {
        return resolved;
      }
      const spreadOnlyObjectLiteral =
        ts.isObjectLiteralExpression(unwrapped) &&
        objectLiteralIdentifiersAreSpreadSourcesOnly(unwrapped);
      return earlierParameterReferenceIndexes(unwrapped, wrapperNode, parameterPosition).size ===
        0 &&
        (!expressionContainsIdentifier(unwrapped) || spreadOnlyObjectLiteral)
        ? initializer
        : null;
    }
    const parameterBinding = earlierParameterBindingForIdentifier(
      unwrapped.text,
      wrapperNode,
      parameterPosition,
    );
    if (!parameterBinding) {
      return options.allowLexicalIdentifierDefault === false ? null : initializer;
    }
    return resolveEarlierParameterBindingExpression(
      parameterBinding,
      wrapperNode,
      argumentsList,
      options,
      new Set(),
    );
  }

  function wrapperRecordForNode(node) {
    const requireAliasSnapshot = visibleRequireAliasSnapshot();
    return {
      aliases: visibleFsWriteAliases(),
      createRequireShadows: visibleCreateRequireShadows(),
      lexicalScopeIndex: wrapperFunctionScopes.length - 1,
      moduleBindings: visibleFsModuleBindings(),
      moduleProperties: visibleFsModuleProperties(),
      node,
      requireAliases: requireAliasSnapshot.aliases,
      requireAliasSourceScopes: requireAliasSnapshot.sourceScopes,
    };
  }

  function registerWrapperFunction(name, node) {
    currentWrapperFunctionScope().set(name, wrapperRecordForNode(node));
  }

  function setWrapperFunctionValue(scope, name, value, conditionalWrite) {
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

  function clearWrapperObjectMethods(scope, objectName) {
    const prefix = `${objectName}.`;
    for (const name of scope.keys()) {
      if (name.startsWith(prefix)) {
        scope.set(name, null);
      }
    }
  }

  function clearWrapperObjectMethod(scope, methodName) {
    scope.set(methodName, null);
    clearWrapperObjectMethods(scope, methodName);
  }

  function shadowVisibleWrapperObjectMethods(objectName) {
    const prefix = `${objectName}.`;
    const currentScope = currentWrapperFunctionScope();
    for (const scope of wrapperFunctionScopes) {
      for (const name of scope.keys()) {
        if (name.startsWith(prefix)) {
          currentScope.set(name, null);
        }
      }
    }
  }

  function copyWrapperObjectMethods(
    targetName,
    sourceName,
    scope = currentWrapperFunctionScope(),
    conditionalWrite = false,
  ) {
    const sourcePrefix = `${sourceName}.`;
    let copiedCount = 0;
    const visibleScopeIndexes = [];
    for (let index = wrapperFunctionScopes.length - 1; index >= 0; index--) {
      visibleScopeIndexes.push(index);
      if (wrapperFunctionScopes[index].has(sourceName) || legacyPathScopes[index].has(sourceName)) {
        break;
      }
    }
    for (const index of visibleScopeIndexes.toReversed()) {
      const sourceScope = wrapperFunctionScopes[index];
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
    objectName,
    initializer,
    scope = currentWrapperFunctionScope(),
    conditionalWrite = false,
  ) {
    const objectLiteral = unwrapExpression(initializer);
    if (!ts.isObjectLiteralExpression(objectLiteral)) {
      return;
    }
    const seenProperties = new Set();
    for (const property of objectLiteral.properties) {
      const propertyName =
        ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property)
          ? propertyNameText(property.name)
          : ts.isShorthandPropertyAssignment(property)
            ? property.name.text
            : null;
      const methodName = propertyName ? `${objectName}.${propertyName}` : null;
      if (methodName && seenProperties.has(propertyName)) {
        clearWrapperObjectMethod(scope, methodName);
      }
      if (propertyName) {
        seenProperties.add(propertyName);
      }
      if (ts.isSpreadAssignment(property)) {
        const spreadExpression = unwrapExpression(property.expression);
        const spreadSource = ts.isIdentifier(spreadExpression)
          ? spreadExpression.text
          : callExpressionName(spreadExpression);
        const copiedCount = spreadSource
          ? copyWrapperObjectMethods(objectName, spreadSource, scope, conditionalWrite)
          : 0;
        if (copiedCount === 0) {
          clearWrapperObjectMethods(scope, objectName);
        }
        continue;
      }
      if (ts.isMethodDeclaration(property)) {
        if (methodName) {
          setWrapperFunctionValue(
            scope,
            methodName,
            wrapperRecordForNode(property),
            conditionalWrite,
          );
        }
        continue;
      }
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isFunctionExpression(unwrapExpression(property.initializer)) ||
          ts.isArrowFunction(unwrapExpression(property.initializer)))
      ) {
        if (methodName) {
          setWrapperFunctionValue(
            scope,
            methodName,
            wrapperRecordForNode(unwrapExpression(property.initializer)),
            conditionalWrite,
          );
        }
        continue;
      }
      if (ts.isPropertyAssignment(property)) {
        const propertyInitializer = unwrapExpression(property.initializer);
        if (propertyName && ts.isObjectLiteralExpression(propertyInitializer)) {
          registerWrapperObjectMethods(
            `${objectName}.${propertyName}`,
            propertyInitializer,
            scope,
            conditionalWrite,
          );
        }
      }
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(unwrapExpression(property.initializer))
      ) {
        const sourceName = unwrapExpression(property.initializer).text;
        const wrapper = resolveWrapperFunction(sourceName);
        if (methodName && wrapper) {
          setWrapperFunctionValue(
            scope,
            methodName,
            cloneWrapperFunctionValue(wrapper),
            conditionalWrite,
          );
        }
        if (methodName) {
          copyWrapperObjectMethods(methodName, sourceName, scope, conditionalWrite);
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        const wrapper = resolveWrapperFunction(property.name.text);
        if (methodName && wrapper) {
          setWrapperFunctionValue(
            scope,
            methodName,
            cloneWrapperFunctionValue(wrapper),
            conditionalWrite,
          );
        }
        if (methodName) {
          copyWrapperObjectMethods(methodName, property.name.text, scope, conditionalWrite);
        }
      }
    }
  }

  function wrapperRecords(value) {
    if (
      !value ||
      value === explicitUndefinedNestedWrapperValue ||
      isNestedWrapperObjectMarker(value)
    ) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  }

  function isNestedWrapperObjectMarker(value) {
    return (
      value === knownObjectLiteralNestedWrapperValue || value === unknownNestedWrapperObjectValue
    );
  }

  function cloneWrapperRecord(record) {
    return {
      aliases: new Map(record.aliases),
      closesOverCurrentWrapper: record.closesOverCurrentWrapper === true,
      createRequireShadows: new Set(record.createRequireShadows),
      lexicalScope: record.lexicalScope,
      localScope: record.localScope,
      lexicalScopeIndex: record.lexicalScopeIndex,
      moduleBindings: new Map(record.moduleBindings),
      moduleProperties: new Map(record.moduleProperties),
      node: record.node,
      requireAliases: new Map(record.requireAliases),
      requireAliasSourceScopes: new Map(record.requireAliasSourceScopes),
    };
  }

  function cloneWrapperFunctionValue(value) {
    if (!value) {
      return null;
    }
    if (value === explicitUndefinedNestedWrapperValue) {
      return explicitUndefinedNestedWrapperValue;
    }
    if (value === knownObjectLiteralNestedWrapperValue) {
      return knownObjectLiteralNestedWrapperValue;
    }
    if (value === unknownNestedWrapperObjectValue) {
      return unknownNestedWrapperObjectValue;
    }
    const records = wrapperRecords(value).map(cloneWrapperRecord);
    return Array.isArray(value) ? records : records[0];
  }

  function refreshCurrentWrapperFunctionAliases() {
    const aliases = visibleFsWriteAliases();
    const moduleBindings = visibleFsModuleBindings();
    const moduleProperties = visibleFsModuleProperties();
    const requireAliasSnapshot = visibleRequireAliasSnapshot();
    const createRequireShadows = visibleCreateRequireShadows();
    const currentLexicalScopeIndex = wrapperFunctionScopes.length - 1;
    for (const value of currentWrapperFunctionScope().values()) {
      for (const record of wrapperRecords(value)) {
        if (record.lexicalScopeIndex !== currentLexicalScopeIndex) {
          continue;
        }
        record.aliases = aliases;
        record.moduleBindings = moduleBindings;
        record.moduleProperties = moduleProperties;
        record.requireAliases = requireAliasSnapshot.aliases;
        record.requireAliasSourceScopes = requireAliasSnapshot.sourceScopes;
        record.createRequireShadows = createRequireShadows;
      }
    }
  }

  function refreshWrapperRequireAliasesAtScope(scopeIndex) {
    const wrapperScope = wrapperFunctionScopes[scopeIndex];
    if (!wrapperScope) {
      return;
    }
    const requireAliasSnapshot = visibleRequireAliasSnapshot(scopeIndex);
    for (const value of wrapperScope.values()) {
      for (const record of wrapperRecords(value)) {
        if (record.lexicalScopeIndex === scopeIndex) {
          record.requireAliases = requireAliasSnapshot.aliases;
          record.requireAliasSourceScopes = requireAliasSnapshot.sourceScopes;
          continue;
        }
        if (record.lexicalScopeIndex > scopeIndex) {
          for (const [name, alias] of requireAliasSnapshot.aliases) {
            const recordSourceScope = record.requireAliasSourceScopes.get(name);
            if (recordSourceScope === undefined || recordSourceScope <= scopeIndex) {
              record.requireAliases.set(name, alias);
              record.requireAliasSourceScopes.set(
                name,
                requireAliasSnapshot.sourceScopes.get(name) ?? scopeIndex,
              );
            }
          }
        }
      }
    }
  }

  function refreshWrapperRequireAliasesFromScope(scopeIndex) {
    for (let index = scopeIndex; index < wrapperFunctionScopes.length; index++) {
      refreshWrapperRequireAliasesAtScope(index);
    }
  }

  function registerHoistedWrapperFunctions(statements) {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        markRequireShadows(statement.name);
        markCreateRequireShadows(statement.name);
        currentRequireAliasScope().set(statement.name.text, false);
        registerWrapperFunction(statement.name.text, statement);
      }
    }
  }

  function resolveWrapperFunction(name) {
    for (let index = wrapperFunctionScopes.length - 1; index >= 0; index--) {
      const wrapperScope = wrapperFunctionScopes[index];
      if (wrapperScope.has(name)) {
        return wrapperScope.get(name);
      }
      if (legacyPathScopes[index].has(name)) {
        return null;
      }
    }
    return null;
  }

  function resolveWrapperExpression(expression) {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      return resolveWrapperFunction(unwrapped.text);
    }
    const name = callExpressionName(unwrapped);
    return name ? resolveWrapperFunction(name) : null;
  }

  function pathArgumentContainsLegacyStore(argument) {
    return expressionContainsLegacyStore(argument);
  }

  function isUndefinedExpression(expression) {
    const unwrapped = unwrapExpression(expression);
    return (
      (ts.isIdentifier(unwrapped) && unwrapped.text === "undefined") ||
      ts.isVoidExpression(unwrapped)
    );
  }

  function isKnownUndefinedExpression(expression) {
    const unwrapped = unwrapExpression(expression);
    return (
      isUndefinedExpression(unwrapped) ||
      (ts.isIdentifier(unwrapped) && resolveKnownUndefinedIdentifier(unwrapped.text))
    );
  }

  function callExpressionName(expression) {
    const callee = unwrapExpression(expression);
    const pathParts = propertyAccessPath(callee);
    return pathParts ? pathParts.join(".") : null;
  }

  function objectArgumentPropertyContainsLegacyStore(argument, propertyName) {
    const propertyPath = propertyName.split(".");
    const unwrapped = unwrapExpression(argument);
    if (ts.isObjectLiteralExpression(unwrapped)) {
      return objectExpressionPropertyPathContainsLegacyStore(unwrapped, propertyPath);
    }
    if (ts.isIdentifier(unwrapped)) {
      return lookupLegacyObjectProperty(unwrapped.text, propertyPath.join(".")) === true;
    }
    return expressionContainsLegacyStore(argument);
  }

  function objectExpressionPropertyLegacyValue(
    expression,
    propertyName,
    maxScopeIndex = legacyObjectPropertyScopes.length - 1,
  ) {
    const propertyPath = propertyName.split(".");
    const unwrapped = unwrapExpression(expression);
    if (ts.isObjectLiteralExpression(unwrapped)) {
      return objectLiteralPropertyPathLegacyValue(unwrapped, propertyPath, maxScopeIndex);
    }
    if (ts.isIdentifier(unwrapped)) {
      return lookupLegacyObjectProperty(unwrapped.text, propertyPath.join("."), maxScopeIndex);
    }
    return null;
  }

  function objectExpressionPropertyPathMayUseBindingDefault(expression, propertyPath) {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      const property = lookupLegacyObjectPropertyEntry(unwrapped.text, propertyPath.join("."));
      if (property.found) {
        return property.value === explicitUndefinedLegacyObjectPropertyValue;
      }
      return lookupKnownLegacyObjectLiteral(unwrapped.text);
    }
    if (!ts.isObjectLiteralExpression(unwrapped) || propertyPath.length === 0) {
      return false;
    }
    const [propertyName, ...remainingPath] = propertyPath;
    const state = objectLiteralPropertyInitializerState(unwrapped, propertyName);
    if (remainingPath.length === 0) {
      return state.kind === "missing" || state.kind === "undefined";
    }
    return state.kind === "initializer"
      ? objectExpressionPropertyPathMayUseBindingDefault(state.initializer, remainingPath)
      : state.kind === "missing" || state.kind === "undefined";
  }

  function objectExpressionPropertyPathContainsLegacyStore(
    expression,
    propertyPath,
    maxScopeIndex = legacyObjectPropertyScopes.length - 1,
  ) {
    if (propertyPath.length === 0) {
      return pathArgumentContainsLegacyStore(expression);
    }
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      return (
        lookupLegacyObjectProperty(unwrapped.text, propertyPath.join("."), maxScopeIndex) === true
      );
    }
    if (!ts.isObjectLiteralExpression(unwrapped)) {
      return expressionContainsLegacyStore(expression);
    }
    const [propertyName, ...remainingPath] = propertyPath;
    if (remainingPath.length === 0) {
      return objectLiteralPropertyContainsLegacyStore(unwrapped, propertyName);
    }
    let result = false;
    for (const property of unwrapped.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spreadExpression = unwrapExpression(property.expression);
        let spreadValue = null;
        if (ts.isIdentifier(spreadExpression)) {
          const spreadProperty = lookupLegacyObjectPropertyEntry(
            spreadExpression.text,
            propertyPath.join("."),
            maxScopeIndex,
          );
          spreadValue = spreadProperty.found ? spreadProperty.value === true : null;
        } else if (ts.isObjectLiteralExpression(spreadExpression)) {
          spreadValue = objectLiteralPropertyPathLegacyValue(
            spreadExpression,
            propertyPath,
            maxScopeIndex,
          );
        } else if (expressionContainsLegacyStore(property.expression)) {
          spreadValue = true;
        }
        if (spreadValue !== null) {
          result = spreadValue === true;
        }
        continue;
      }
      if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === propertyName) {
        result =
          !isKnownUndefinedExpression(property.initializer) &&
          objectExpressionPropertyPathContainsLegacyStore(
            property.initializer,
            remainingPath,
            maxScopeIndex,
          );
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
        result = objectExpressionPropertyPathContainsLegacyStore(
          property.name,
          remainingPath,
          maxScopeIndex,
        );
      }
    }
    return result;
  }

  function parameterDefaultContainsLegacyStore(
    initializer,
    wrapperNode,
    argumentsList,
    parameterIndex,
    maxScopeIndex = legacyObjectPropertyScopes.length - 1,
  ) {
    return defaultPathExpressionContainsLegacyStore(
      initializer,
      wrapperNode,
      argumentsList,
      parameterIndex,
      new Set(),
      maxScopeIndex,
    );
  }

  function defaultPathExpressionContainsLegacyStore(
    expression,
    wrapperNode,
    argumentsList,
    parameterIndex,
    activeDefaultIndexes,
    maxScopeIndex,
  ) {
    if (earlierParameterReferenceIndexes(expression, wrapperNode, parameterIndex).size === 0) {
      return pathArgumentContainsLegacyStore(expression);
    }
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      const binding = earlierParameterBindingForIdentifier(
        unwrapped.text,
        wrapperNode,
        parameterIndex,
      );
      if (!binding || activeDefaultIndexes.has(binding.index)) {
        return false;
      }
      activeDefaultIndexes.add(binding.index);
      const resolved = resolveEarlierParameterBindingExpression(
        binding,
        wrapperNode,
        argumentsList,
        { allowLexicalIdentifierDefault: false },
        activeDefaultIndexes,
      );
      activeDefaultIndexes.delete(binding.index);
      return resolved ? pathArgumentContainsLegacyStore(resolved) : false;
    }
    if (ts.isConditionalExpression(unwrapped)) {
      return (
        defaultPathExpressionContainsLegacyStore(
          unwrapped.whenTrue,
          wrapperNode,
          argumentsList,
          parameterIndex,
          activeDefaultIndexes,
          maxScopeIndex,
        ) ||
        defaultPathExpressionContainsLegacyStore(
          unwrapped.whenFalse,
          wrapperNode,
          argumentsList,
          parameterIndex,
          activeDefaultIndexes,
          maxScopeIndex,
        )
      );
    }
    if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
      const propertyPath = rootedPropertyAccessPath(unwrapped);
      if (propertyPath) {
        const binding = earlierParameterBindingForIdentifier(
          propertyPath.rootName,
          wrapperNode,
          parameterIndex,
        );
        if (binding && !activeDefaultIndexes.has(binding.index)) {
          activeDefaultIndexes.add(binding.index);
          const resolved = resolveEarlierParameterBindingExpression(
            binding,
            wrapperNode,
            argumentsList,
            { allowLexicalIdentifierDefault: false },
            activeDefaultIndexes,
          );
          activeDefaultIndexes.delete(binding.index);
          return resolved
            ? objectExpressionPropertyPathContainsLegacyStore(
                resolved,
                propertyPath.properties,
                maxScopeIndex,
              )
            : false;
        }
      }
      return false;
    }
    if (ts.isBinaryExpression(unwrapped)) {
      const operator = unwrapped.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
        return defaultPathExpressionContainsLegacyStore(
          unwrapped.right,
          wrapperNode,
          argumentsList,
          parameterIndex,
          activeDefaultIndexes,
          maxScopeIndex,
        );
      }
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.PlusToken
      ) {
        return (
          defaultPathExpressionContainsLegacyStore(
            unwrapped.left,
            wrapperNode,
            argumentsList,
            parameterIndex,
            activeDefaultIndexes,
            maxScopeIndex,
          ) ||
          defaultPathExpressionContainsLegacyStore(
            unwrapped.right,
            wrapperNode,
            argumentsList,
            parameterIndex,
            activeDefaultIndexes,
            maxScopeIndex,
          )
        );
      }
      if (
        operator === ts.SyntaxKind.CommaToken ||
        (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment)
      ) {
        return defaultPathExpressionContainsLegacyStore(
          unwrapped.right,
          wrapperNode,
          argumentsList,
          parameterIndex,
          activeDefaultIndexes,
          maxScopeIndex,
        );
      }
      return false;
    }
    if (ts.isTemplateExpression(unwrapped)) {
      return unwrapped.templateSpans.some((span) =>
        defaultPathExpressionContainsLegacyStore(
          span.expression,
          wrapperNode,
          argumentsList,
          parameterIndex,
          activeDefaultIndexes,
          maxScopeIndex,
        ),
      );
    }
    if (ts.isCallExpression(unwrapped)) {
      const receiver = ts.isPropertyAccessExpression(unwrapped.expression)
        ? unwrapped.expression.expression
        : unwrapped.expression;
      return (
        defaultPathExpressionContainsLegacyStore(
          receiver,
          wrapperNode,
          argumentsList,
          parameterIndex,
          activeDefaultIndexes,
          maxScopeIndex,
        ) ||
        [...unwrapped.arguments].some((argument) =>
          defaultPathExpressionContainsLegacyStore(
            argument,
            wrapperNode,
            argumentsList,
            parameterIndex,
            activeDefaultIndexes,
            maxScopeIndex,
          ),
        )
      );
    }
    let containsLegacyStore = false;
    ts.forEachChild(unwrapped, (child) => {
      if (
        defaultPathExpressionContainsLegacyStore(
          child,
          wrapperNode,
          argumentsList,
          parameterIndex,
          activeDefaultIndexes,
          maxScopeIndex,
        )
      ) {
        containsLegacyStore = true;
      }
    });
    return containsLegacyStore;
  }

  function rootedPropertyAccessPath(expression) {
    const properties = [];
    let current = unwrapExpression(expression);
    while (true) {
      if (ts.isPropertyAccessExpression(current)) {
        properties.unshift(current.name.text);
        current = unwrapExpression(current.expression);
        continue;
      }
      if (ts.isElementAccessExpression(current)) {
        const propertyName = elementAccessName(current.argumentExpression);
        if (!propertyName) {
          return null;
        }
        properties.unshift(propertyName);
        current = unwrapExpression(current.expression);
        continue;
      }
      break;
    }
    return ts.isIdentifier(current) ? { rootName: current.text, properties } : null;
  }

  function wrapperObjectBindingDefaultContainsLegacyStore(
    parameter,
    propertyName,
    sourceExpression,
    wrapperNode,
    argumentsList,
    parameterIndex,
    maxScopeIndex = legacyObjectPropertyScopes.length - 1,
  ) {
    if (!parameter || !ts.isObjectBindingPattern(parameter.name) || !sourceExpression) {
      return false;
    }
    const propertyPath = propertyName.split(".");
    const initializer = appliedBindingElementDefaultInitializer(
      parameter.name,
      propertyPath,
      sourceExpression,
    );
    if (!initializer) {
      return false;
    }
    return parameterDefaultContainsLegacyStore(
      initializer,
      wrapperNode,
      argumentsList,
      parameterIndex,
      maxScopeIndex,
    );
  }

  function wrapperPathUseContainsLegacyStore(record, index, propertyName, argumentsList) {
    const wrapperNode = record.node;
    const maxScopeIndex = record.lexicalScopeIndex;
    const parameter = wrapperNode.parameters[index] ?? null;
    const argument = argumentsList[index];
    const argumentUsesDefault = !argument || isKnownUndefinedExpression(argument);
    if (propertyName === null) {
      if (!argumentUsesDefault) {
        return pathArgumentContainsLegacyStore(argument);
      }
      return parameter?.initializer
        ? parameterDefaultContainsLegacyStore(
            parameter.initializer,
            wrapperNode,
            argumentsList,
            index,
            maxScopeIndex,
          )
        : false;
    }
    if (!argumentUsesDefault) {
      if (objectArgumentPropertyContainsLegacyStore(argument, propertyName)) {
        return true;
      }
      return wrapperObjectBindingDefaultContainsLegacyStore(
        parameter,
        propertyName,
        argument,
        wrapperNode,
        argumentsList,
        index,
      );
    }
    if (parameter?.initializer) {
      const propertyPath = propertyName.split(".");
      const defaultPropertyValue = objectExpressionPropertyLegacyValue(
        parameter.initializer,
        propertyName,
        maxScopeIndex,
      );
      if (defaultPropertyValue === true) {
        return true;
      }
      if (
        defaultPropertyValue === false &&
        !objectExpressionPropertyPathMayUseBindingDefault(parameter.initializer, propertyPath)
      ) {
        return false;
      }
    }
    return wrapperObjectBindingDefaultContainsLegacyStore(
      parameter,
      propertyName,
      parameter?.initializer ?? null,
      wrapperNode,
      argumentsList,
      index,
      maxScopeIndex,
    );
  }

  function visitInConditionalExecution(node, branchEffects = null) {
    conditionalExecutionScopes.push(true);
    fsWriteAliasScopes.push(new Map());
    fsSafeStoreFactoryAliasScopes.push(new Map());
    fsSafeStoreScopes.push(new Map());
    fsSafeJsonStoreScopes.push(new Map());
    fsModuleBindingScopes.push(new Map());
    fsModulePropertyScopes.push(new Map());
    requireAliasScopes.push(new Map());
    requireShadowScopes.push(new Set());
    createRequireShadowScopes.push(new Set());
    legacyPathScopes.push(new Map());
    literalTextScopes.push(new Map());
    knownUndefinedScopes.push(new Map());
    legacyKnownObjectLiteralScopes.push(new Map());
    legacyObjectPropertyScopes.push(new Map());
    wrapperFunctionScopes.push(new Map());
    branchEffectScopes.push(branchEffects);
    visit(node);
    branchEffectScopes.pop();
    wrapperFunctionScopes.pop();
    legacyObjectPropertyScopes.pop();
    legacyKnownObjectLiteralScopes.pop();
    knownUndefinedScopes.pop();
    literalTextScopes.pop();
    legacyPathScopes.pop();
    fsModulePropertyScopes.pop();
    fsModuleBindingScopes.pop();
    fsSafeJsonStoreScopes.pop();
    fsSafeStoreScopes.pop();
    fsSafeStoreFactoryAliasScopes.pop();
    fsWriteAliasScopes.pop();
    createRequireShadowScopes.pop();
    requireShadowScopes.pop();
    requireAliasScopes.pop();
    conditionalExecutionScopes.pop();
  }

  function visit(node) {
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
      if (node.elseStatement) {
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
      fsWriteAliasScopes.push(new Map());
      fsSafeStoreFactoryAliasScopes.push(new Map());
      fsSafeStoreScopes.push(new Map());
      fsSafeJsonStoreScopes.push(new Map());
      fsModuleBindingScopes.push(new Map());
      fsModulePropertyScopes.push(new Map());
      requireAliasScopes.push(new Map());
      requireShadowScopes.push(new Set());
      createRequireShadowScopes.push(new Set());
      legacyPathScopes.push(new Map());
      literalTextScopes.push(new Map());
      knownUndefinedScopes.push(new Map());
      legacyKnownObjectLiteralScopes.push(new Map());
      legacyObjectPropertyScopes.push(new Map());
      wrapperFunctionScopes.push(new Map());
      conditionalExecutionScopes.push(false);
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
      conditionalExecutionScopes.pop();
      wrapperFunctionScopes.pop();
      legacyObjectPropertyScopes.pop();
      legacyKnownObjectLiteralScopes.pop();
      knownUndefinedScopes.pop();
      literalTextScopes.pop();
      legacyPathScopes.pop();
      fsModulePropertyScopes.pop();
      fsModuleBindingScopes.pop();
      fsSafeJsonStoreScopes.pop();
      fsSafeStoreScopes.pop();
      fsSafeStoreFactoryAliasScopes.pop();
      fsWriteAliasScopes.pop();
      createRequireShadowScopes.pop();
      requireShadowScopes.pop();
      requireAliasScopes.pop();
      return;
    }

    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      visit(node.expression);
      fsWriteAliasScopes.push(new Map());
      fsSafeStoreFactoryAliasScopes.push(new Map());
      fsSafeStoreScopes.push(new Map());
      fsSafeJsonStoreScopes.push(new Map());
      fsModuleBindingScopes.push(new Map());
      fsModulePropertyScopes.push(new Map());
      requireAliasScopes.push(new Map());
      requireShadowScopes.push(new Set());
      createRequireShadowScopes.push(new Set());
      legacyPathScopes.push(new Map());
      literalTextScopes.push(new Map());
      knownUndefinedScopes.push(new Map());
      legacyKnownObjectLiteralScopes.push(new Map());
      legacyObjectPropertyScopes.push(new Map());
      wrapperFunctionScopes.push(new Map());
      conditionalExecutionScopes.push(true);
      visit(node.initializer);
      if (ts.isForOfStatement(node)) {
        markArrayBindingPatternFromForOf(node.initializer, node.expression);
      }
      visit(node.statement);
      conditionalExecutionScopes.pop();
      wrapperFunctionScopes.pop();
      legacyObjectPropertyScopes.pop();
      legacyKnownObjectLiteralScopes.pop();
      knownUndefinedScopes.pop();
      literalTextScopes.pop();
      legacyPathScopes.pop();
      fsModulePropertyScopes.pop();
      fsModuleBindingScopes.pop();
      fsSafeJsonStoreScopes.pop();
      fsSafeStoreScopes.pop();
      fsSafeStoreFactoryAliasScopes.pop();
      fsWriteAliasScopes.pop();
      createRequireShadowScopes.pop();
      requireShadowScopes.pop();
      requireAliasScopes.pop();
      return;
    }

    if (ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        registerWrapperFunction(node.name.text, node);
      }
      visitFunctionLike(node);
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
      if (node.initializer) {
        if (isFsBindingExpression(node.initializer)) {
          currentFsModuleBindingScope().set(node.name.text, true);
        } else {
          markFsModuleBindingShadows(node.name);
        }
        markFsModulePropertyShadows(node.name);
        registerFsModuleTypeProperties(node.name, node.type);
        if (!(node.name.text === "require" && isCreateRequireExpression(node.initializer))) {
          markRequireShadows(node.name);
        }
        currentRequireAliasScope().set(node.name.text, isRequireAliasExpression(node.initializer));
        markCreateRequireShadows(node.name);
        collectFsWriteAliasesFromBinding(node);
        markFsWriteAliasShadows(node.name);
        markFsSafeStoreShadows(node.name);
        currentFsWriteAliasScope().set(node.name.text, legacyFsWriteName(node.initializer));
        currentFsSafeStoreFactoryAliasScope().set(
          node.name.text,
          fsSafeStoreFactoryAliasName(node.initializer),
        );
        currentFsSafeStoreScope().set(node.name.text, isFsSafeStoreExpression(node.initializer));
        currentFsSafeJsonStoreScope().set(
          node.name.text,
          expressionContainsFsSafeJsonStoreLegacyPath(node.initializer),
        );
        refreshCurrentWrapperFunctionAliases();
        currentLiteralTextScope().set(node.name.text, literalTextsFromExpression(node.initializer));
        currentKnownUndefinedScope().set(
          node.name.text,
          isKnownUndefinedExpression(node.initializer),
        );
        currentLegacyPathScope().set(
          node.name.text,
          expressionContainsLegacyStore(node.initializer),
        );
        markKnownLegacyObjectLiteral(node.name.text, node.initializer);
        markLegacyObjectProperties(node.name.text, node.initializer);
        registerFsWriteObjectAliases(node.name.text, node.initializer);
        registerFsSafeStoreObjectAliases(node.name.text, node.initializer);
        registerFsModuleObjectProperties(node.name.text, node.initializer);
        if (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer)) {
          registerWrapperFunction(node.name.text, node.initializer);
        } else {
          currentWrapperFunctionScope().set(
            node.name.text,
            cloneWrapperFunctionValue(resolveWrapperExpression(node.initializer)),
          );
          registerWrapperObjectMethods(node.name.text, node.initializer);
          const wrapperObjectSource = callExpressionName(node.initializer);
          if (wrapperObjectSource) {
            copyWrapperObjectMethods(node.name.text, wrapperObjectSource);
          }
        }
      } else {
        currentFsModuleBindingScope().set(node.name.text, false);
        currentFsWriteAliasScope().set(node.name.text, null);
        currentFsSafeStoreFactoryAliasScope().set(node.name.text, null);
        currentFsSafeStoreScope().set(node.name.text, false);
        currentFsSafeJsonStoreScope().set(node.name.text, false);
        currentRequireAliasScope().set(node.name.text, false);
        currentLegacyPathScope().set(node.name.text, false);
        currentLegacyKnownObjectLiteralScope().set(node.name.text, false);
        currentKnownUndefinedScope().set(node.name.text, !isAmbientVariableDeclaration(node));
        currentLiteralTextScope().set(node.name.text, null);
        currentWrapperFunctionScope().set(node.name.text, null);
        markFsWriteAliasShadows(node.name);
        markFsSafeStoreShadows(node.name);
        markFsModuleBindingShadows(node.name);
        markFsModulePropertyShadows(node.name);
        registerFsModuleTypeProperties(node.name, node.type);
        markRequireShadows(node.name);
        markCreateRequireShadows(node.name);
        refreshCurrentWrapperFunctionAliases();
      }
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
        markRequireShadows(node.name);
        markCreateRequireShadows(node.name);
      }
      refreshCurrentWrapperFunctionAliases();
      for (const name of bindingPatternNames(node.name)) {
        currentFsSafeStoreFactoryAliasScope().set(name, null);
        currentFsSafeStoreScope().set(name, false);
        currentFsSafeJsonStoreScope().set(name, false);
        currentRequireAliasScope().set(name, false);
        currentLegacyPathScope().set(name, false);
        currentLegacyKnownObjectLiteralScope().set(name, false);
        currentKnownUndefinedScope().set(name, false);
        currentLiteralTextScope().set(name, null);
        currentWrapperFunctionScope().set(name, null);
      }
      if (
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer)
      ) {
        markLegacyPathsFromObjectBinding(node.name, node.initializer.text);
        markFsSafeStoresFromObjectBinding(node.name, node.initializer.text);
        markFsSafeFactoryAliasesFromObjectBinding(node.name, node.initializer.text);
      } else if (
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        rootedPropertyAccessPath(node.initializer)?.properties.length > 0
      ) {
        const propertyAccess = rootedPropertyAccessPath(node.initializer);
        const sourceName = objectPropertyKey(
          propertyAccess.rootName,
          propertyAccess.properties.join("."),
        );
        markLegacyPathsFromObjectBinding(node.name, sourceName);
        markFsSafeStoresFromObjectBinding(node.name, sourceName);
        markFsSafeFactoryAliasesFromObjectBinding(node.name, sourceName);
      } else if (
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isObjectLiteralExpression(unwrapExpression(node.initializer))
      ) {
        markLegacyPathsFromInlineObjectBinding(node.name, node.initializer);
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
        currentConditionalExecutionScope() && !conditionalExecutionScopes[index];
      pathScope.set(
        node.left.text,
        conditionalWrite ? pathScope.get(node.left.text) === true || nextPathValue : nextPathValue,
      );
      const literalScope = literalTextWriteScope(node.left.text);
      literalScope.set(
        node.left.text,
        conditionalWrite
          ? mergeConditionalLiteralTexts(literalScope.get(node.left.text), nextLiteralTexts)
          : nextLiteralTexts,
      );
      const knownUndefinedScope = knownUndefinedWriteScope(node.left.text);
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
        legacyKnownObjectLiteralScopes[index].set(
          node.left.text,
          legacyKnownObjectLiteralScopes[index].get(node.left.text) === true &&
            isKnownLegacyObjectLiteralExpression(node.right),
        );
        currentLegacyPathScope().set(node.left.text, nextPathValue);
        markKnownLegacyObjectLiteral(node.left.text, node.right);
        clearLegacyObjectProperties(currentLegacyObjectPropertyScope(), node.left.text);
        markLegacyObjectProperties(node.left.text, node.right, currentLegacyObjectPropertyScope());
      } else {
        fsModuleBindingWriteScope(node.left.text).set(node.left.text, nextFsModuleValue);
        fsWriteAliasWriteScope(node.left.text).set(node.left.text, nextFsWriteAlias);
        fsSafeStoreFactoryAliasWriteScope(node.left.text).set(
          node.left.text,
          nextFsSafeFactoryAlias,
        );
        fsSafeStoreWriteScope(node.left.text).set(node.left.text, nextFsSafeStoreValue);
        fsSafeJsonStoreWriteScope(node.left.text).set(node.left.text, nextFsSafeJsonStoreValue);
        const requireAliasTarget = requireAliasWriteTarget(node.left.text);
        requireAliasTarget.scope.set(node.left.text, nextRequireAlias);
        refreshCurrentWrapperFunctionAliases();
        refreshWrapperRequireAliasesFromScope(requireAliasTarget.index);
        markFsModulePropertyShadows(node.left);
        clearLegacyObjectProperties(propertyScope, node.left.text);
        markKnownLegacyObjectLiteral(
          node.left.text,
          node.right,
          legacyKnownObjectLiteralScopes[index],
        );
        markLegacyObjectProperties(
          node.left.text,
          node.right,
          propertyScope,
          legacyKnownObjectLiteralScopes[index],
        );
        clearFsWriteObjectAliases(fsWriteAliasScopes[index], node.left.text);
        registerFsWriteObjectAliases(node.left.text, node.right, fsWriteAliasScopes[index]);
        clearFsSafeStoreObjectAliases(
          fsSafeStoreScopes[index],
          fsSafeJsonStoreScopes[index],
          node.left.text,
        );
        registerFsSafeStoreObjectAliases(
          node.left.text,
          node.right,
          fsSafeStoreScopes[index],
          fsSafeJsonStoreScopes[index],
        );
        registerFsModuleObjectProperties(node.left.text, node.right, fsModulePropertyScopes[index]);
        clearWrapperObjectMethods(wrapperScope, node.left.text);
        registerWrapperObjectMethods(node.left.text, node.right, wrapperScope);
      }
      if (conditionalWrite) {
        const fsModuleScope = fsModuleBindingScopes[index];
        const fsWriteScope = fsWriteAliasScopes[index];
        const fsSafeFactoryAliasScope = fsSafeStoreFactoryAliasScopes[index];
        const fsSafeStoreScope = fsSafeStoreScopes[index];
        const fsSafeJsonStoreScope = fsSafeJsonStoreScopes[index];
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
        requireAliasScopes[index].set(
          node.left.text,
          requireAliasScopes[index].get(node.left.text) === true || nextRequireAlias,
        );
        currentFsModuleBindingScope().set(node.left.text, nextFsModuleValue);
        currentFsWriteAliasScope().set(node.left.text, nextFsWriteAlias);
        currentFsSafeStoreFactoryAliasScope().set(node.left.text, nextFsSafeFactoryAlias);
        currentFsSafeStoreScope().set(node.left.text, nextFsSafeStoreValue);
        currentFsSafeJsonStoreScope().set(node.left.text, nextFsSafeJsonStoreValue);
        currentRequireAliasScope().set(node.left.text, nextRequireAlias);
        refreshCurrentWrapperFunctionAliases();
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
        registerFsWriteObjectAliases(node.left.text, node.right, fsWriteAliasScopes[index], true);
        registerFsSafeStoreObjectAliases(
          node.left.text,
          node.right,
          fsSafeStoreScopes[index],
          fsSafeJsonStoreScopes[index],
          true,
        );
        registerFsModuleObjectProperties(
          node.left.text,
          node.right,
          fsModulePropertyScopes[index],
          true,
        );
        shadowVisibleFsWriteObjectAliases(node.left.text);
        registerFsWriteObjectAliases(node.left.text, node.right);
        registerFsSafeStoreObjectAliases(node.left.text, node.right);
        registerFsModuleObjectProperties(node.left.text, node.right);
        registerWrapperObjectMethods(node.left.text, node.right, wrapperScope, true);
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
      rootedPropertyAccessPath(node.left)?.properties.length > 0
    ) {
      const propertyAccess = rootedPropertyAccessPath(node.left);
      const propertyName = propertyAccess.properties.join(".");
      const target = legacyObjectPropertyWriteTarget(propertyAccess.rootName, propertyName);
      const key = objectPropertyKey(propertyAccess.rootName, propertyName);
      const nextValue = legacyObjectPropertyValueFromExpression(node.right);
      const nextKnownObjectLiteral = isKnownLegacyObjectLiteralExpression(node.right);
      const rewriteValues = legacyObjectPropertyRewriteValues(key, node.right, target.scope);
      const conditionalPropertyWrite =
        currentConditionalExecutionScope() && !conditionalExecutionScopes[target.index];
      if (conditionalPropertyWrite) {
        const previousKnownObjectLiteral = lookupKnownLegacyObjectLiteral(key);
        clearKnownLegacyObjectLiterals(legacyKnownObjectLiteralScopes[target.index], key);
        legacyKnownObjectLiteralScopes[target.index].set(
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
        clearKnownLegacyObjectLiterals(legacyKnownObjectLiteralScopes[target.index], key);
        legacyKnownObjectLiteralScopes[target.index].set(key, nextKnownObjectLiteral);
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
        currentLegacyObjectPropertyScope().set(key, nextValue);
        clearKnownLegacyObjectLiterals(currentLegacyKnownObjectLiteralScope(), key);
        currentLegacyKnownObjectLiteralScope().set(key, nextKnownObjectLiteral);
        clearLegacyObjectProperties(currentLegacyObjectPropertyScope(), key);
        for (const [propertyKey, value] of rewriteValues) {
          currentLegacyObjectPropertyScope().set(propertyKey, value);
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
        currentConditionalExecutionScope() && !conditionalExecutionScopes[wrapperTarget.index];
      setFsWriteObjectAlias(
        fsWriteAliasScopes[wrapperTarget.index],
        key,
        legacyFsWriteName(node.right),
        conditionalWrapperWrite,
      );
      setFsModuleObjectProperty(
        fsModulePropertyScopes[wrapperTarget.index],
        key,
        isFsModuleExpression(node.right),
        conditionalWrapperWrite,
      );
      if (!conditionalWrapperWrite) {
        clearFsSafeStoreObjectAliases(
          fsSafeStoreScopes[wrapperTarget.index],
          fsSafeJsonStoreScopes[wrapperTarget.index],
          key,
        );
      }
      setFsSafeStoreObjectAlias(
        fsSafeStoreScopes[wrapperTarget.index],
        fsSafeJsonStoreScopes[wrapperTarget.index],
        key,
        isFsSafeStoreExpression(node.right),
        expressionContainsFsSafeJsonStoreLegacyPath(node.right),
        conditionalWrapperWrite,
      );
      if (!conditionalWrapperWrite) {
        registerFsSafeStoreObjectAliases(
          key,
          node.right,
          fsSafeStoreScopes[wrapperTarget.index],
          fsSafeJsonStoreScopes[wrapperTarget.index],
        );
      }
      if (conditionalWrapperWrite) {
        currentFsWriteAliasScope().set(key, legacyFsWriteName(node.right));
        currentFsModulePropertyScope().set(key, isFsModuleExpression(node.right));
        shadowVisibleFsSafeStoreObjectAliases(key);
        currentFsSafeStoreScope().set(key, isFsSafeStoreExpression(node.right));
        currentFsSafeJsonStoreScope().set(
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
        currentWrapperFunctionScope().set(key, assignedWrapper);
        recordBranchWrapperAssignment(wrapperTarget.index, key, assignedWrapper);
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
      if (
        fsWriteName &&
        fsWriteCallMayWrite(fsWriteName, [...node.arguments]) &&
        pathArgumentsForFsWrite(fsWriteName, [...node.arguments]).some((argument) =>
          pathArgumentContainsLegacyStore(argument),
        )
      ) {
        addViolation(node.expression, "legacy store filesystem write", node);
      }
      if (
        fsSafeStoreWritePathArguments(node).some((argument) =>
          pathArgumentContainsLegacyStore(argument),
        )
      ) {
        addViolation(node.expression, "legacy store filesystem write", node);
      }
      if (fsSafeJsonStoreWriteContainsLegacyStore(node)) {
        addViolation(node.expression, "legacy store filesystem write", node);
      }
      const wrapperName = callExpressionName(node.expression);
      const wrapperRecord = wrapperName ? resolveWrapperFunction(wrapperName) : null;
      for (const record of wrapperRecords(wrapperRecord)) {
        const propertyParameters = collectLegacyPathPropertyParameters(
          record.node,
          record.aliases,
          record.moduleBindings,
          record.moduleProperties,
          record.requireAliases,
          record.createRequireShadows,
        );
        for (const [index, propertyNames] of propertyParameters) {
          if (
            [...propertyNames].some((propertyName) =>
              wrapperPathUseContainsLegacyStore(record, index, propertyName, node.arguments),
            )
          ) {
            addViolation(node.expression, "legacy store filesystem write", node);
            break;
          }
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
  if (
    scanOptions.enforceCurrentLegacyAllowlist &&
    !scanOptions.currentLegacyWriteAllowances &&
    currentLegacyWriteAllowances.size > 0
  ) {
    violations.push({ kind: "stale current legacy write allowlist", line: 1 });
  }
  return violations;
}

/**
 * Runs the database-first legacy-store guard.
 */
export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const sourceRoots = databaseFirstLegacyStoreSourceRoots.map((root) => path.join(repoRoot, root));
  const files = await collectDatabaseFirstLegacyStoreSourceFiles(sourceRoots);
  const violations = [];
  const currentLegacyWriteAllowances = currentLegacyWriteViolationAllowances();

  for (const filePath of files) {
    const relativePath = path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
    const content = await fs.readFile(filePath, "utf8");
    for (const violation of collectDatabaseFirstLegacyStoreViolations(content, relativePath, {
      currentLegacyWriteAllowances,
    })) {
      violations.push(`${relativePath}:${violation.line} ${violation.kind}`);
    }
  }
  for (const fingerprint of currentLegacyWriteAllowances.keys()) {
    const relativePath = currentLegacyWriteViolationPath(fingerprint) ?? "<unknown>";
    violations.push(`${relativePath}:1 stale current legacy write allowlist`);
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
