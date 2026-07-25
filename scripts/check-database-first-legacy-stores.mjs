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
const databaseFirstNativeSourceRoots = ["apps/macos/Sources/OpenClaw"];
const nativeLegacyPortGuardianMigrationPath =
  "apps/macos/Sources/OpenClaw/PortGuardianRecordStore.swift";
const nativeLegacyPortGuardianFilenamePattern = /\bport-guard\.(?:json|lock)\b/u;

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
  "src/infra/state-migrations.commitments.ts",
  "src/infra/state-migrations.managed-outgoing-images.ts",
  "src/infra/state-migrations.apns.ts",
  "src/infra/state-migrations.mcp-oauth.ts",
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

const allowedCurrentLegacyWriteViolations = [];

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

function lastScope(scopes) {
  return scopes[scopes.length - 1];
}

function visibleMap(scopes) {
  return new Map(scopes.flatMap((scope) => [...scope]));
}

function visibleSet(scopes) {
  return new Set(scopes.flatMap((scope) => [...scope]));
}

function scopeForWrite(scopes, name) {
  return scopes.findLast((scope) => scope.has(name)) ?? lastScope(scopes);
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

async function collectNativeSourceFiles(targetPath) {
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
    return path.extname(targetPath) === ".swift" ? [targetPath] : [];
  }
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectNativeSourceFiles(entryPath)));
    } else if (entry.isFile() && path.extname(entryPath) === ".swift") {
      files.push(entryPath);
    }
  }
  return files;
}

export function collectDatabaseFirstNativeLegacyStoreViolations(content, relativePath) {
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

function importSource(node) {
  const moduleSpecifier = node.moduleSpecifier;
  return ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : "";
}

function isLegacyRestartSentinelPreflightDetection(node, relativePath) {
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
    !ts.isIdentifier(joinCall.arguments[0]) ||
    joinCall.arguments[0].text !== "stateDir"
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
    ts.isIdentifier(someCall.arguments[0]) &&
    someCall.arguments[0].text === "fileOrDirExists"
  );
}

function collectLegacyRestartSentinelBoundaryViolations(sourceFile, relativePath) {
  if (relativePath === legacyRestartSentinelMigrationPath) {
    return [];
  }

  const violations = [];
  const seen = new Set();
  function add(node, kind) {
    const line = toLine(sourceFile, node);
    const key = `${line}:${kind}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    violations.push({ kind, line });
  }

  function visit(node) {
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
  inputRelativePath = "source.ts",
  scanOptions = {},
) {
  const relativePath = inputRelativePath.replaceAll("\\", "/");
  const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true);
  const boundaryViolations = collectLegacyRestartSentinelBoundaryViolations(
    sourceFile,
    relativePath,
  );
  if (isAllowedLegacyOwnerPath(relativePath)) {
    return boundaryViolations;
  }

  const currentLegacyWriteAllowances =
    scanOptions.currentLegacyWriteAllowances ?? currentLegacyWriteViolationAllowances(relativePath);
  const createRequireBindings = collectCreateRequireBindings(sourceFile);
  const { fsModuleBindings, fsWriteAliases, fsSafeStoreFactoryAliases } =
    collectFsBindings(sourceFile);
  const violations = [...boundaryViolations];
  const seenViolations = new Set(
    boundaryViolations.map((violation) => `${violation.line}:${violation.kind}`),
  );
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
    targetScope = lastScope(legacyKnownObjectLiteralScopes),
  ) {
    targetScope.set(name, isKnownLegacyObjectLiteralExpression(initializer));
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

  function resolveKnownUndefinedIdentifier(name) {
    for (let index = knownUndefinedScopes.length - 1; index >= 0; index--) {
      const scope = knownUndefinedScopes[index];
      if (scope.has(name)) {
        return scope.get(name) === true;
      }
    }
    return false;
  }

  function requireAliasWriteTarget(name) {
    for (let index = requireAliasScopes.length - 1; index >= 0; index--) {
      const scope = requireAliasScopes[index];
      if (scope.has(name)) {
        return { index, scope };
      }
    }
    return { index: requireAliasScopes.length - 1, scope: lastScope(requireAliasScopes) };
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
      scope: lastScope(legacyObjectPropertyScopes),
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
      pathScope: lastScope(legacyPathScopes),
      propertyScope: lastScope(legacyObjectPropertyScopes),
      wrapperScope: lastScope(wrapperFunctionScopes),
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
      lastScope(conditionalExecutionScopes) || isConditionallyExecutedScope(node),
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
        lastScope(fsWriteAliasScopes).set(element.name.text, importedName);
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
        lastScope(fsWriteAliasScopes).set(bindingName, null);
      }
      shadowVisibleFsWriteObjectAliases(bindingName);
    }
  }

  function markFsSafeStoreShadows(name) {
    for (const bindingName of bindingPatternNames(name)) {
      if (resolveFsSafeStoreFactoryAlias(bindingName)) {
        lastScope(fsSafeStoreFactoryAliasScopes).set(bindingName, null);
      }
      const prefix = `${bindingName}.`;
      for (const scope of fsSafeStoreFactoryAliasScopes) {
        for (const alias of scope.keys()) {
          if (alias.startsWith(prefix)) {
            lastScope(fsSafeStoreFactoryAliasScopes).set(alias, null);
          }
        }
      }
      if (resolveFsSafeStore(bindingName)) {
        lastScope(fsSafeStoreScopes).set(bindingName, false);
      }
      if (resolveFsSafeJsonStore(bindingName)) {
        lastScope(fsSafeJsonStoreScopes).set(bindingName, false);
      }
      const storePrefix = `${bindingName}.`;
      for (const scope of fsSafeStoreScopes) {
        for (const alias of scope.keys()) {
          if (alias.startsWith(storePrefix)) {
            lastScope(fsSafeStoreScopes).set(alias, false);
          }
        }
      }
      for (const scope of fsSafeJsonStoreScopes) {
        for (const alias of scope.keys()) {
          if (alias.startsWith(storePrefix)) {
            lastScope(fsSafeJsonStoreScopes).set(alias, false);
          }
        }
      }
    }
  }

  function markFsModuleBindingShadows(name) {
    for (const bindingName of bindingPatternNames(name)) {
      if (resolveFsModuleBinding(bindingName)) {
        lastScope(fsModuleBindingScopes).set(bindingName, false);
      }
    }
  }

  function markFsModulePropertyShadows(name) {
    for (const bindingName of bindingPatternNames(name)) {
      clearFsModuleObjectProperties(lastScope(fsModulePropertyScopes), bindingName);
    }
  }

  function markRequireShadows(name) {
    if (bindingPatternNames(name).includes("require")) {
      lastScope(requireShadowScopes).add("require");
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
      lastScope(fsModuleBindingScopes).set(name.text, true);
    }
    for (const pathParts of fsModulePropertyPathsFromType(type)) {
      lastScope(fsModulePropertyScopes).set([name.text, ...pathParts].join("."), true);
    }
  }

  function collectFsWriteAliasesFromBinding(node) {
    collectFsWriteAliasesFromBindingInto(node, lastScope(fsWriteAliasScopes));
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
    const currentScope = lastScope(fsWriteAliasScopes);
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
    scope = lastScope(fsWriteAliasScopes),
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
    const currentStoreScope = lastScope(fsSafeStoreScopes);
    const currentJsonStoreScope = lastScope(fsSafeJsonStoreScopes);
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
    storeScope = lastScope(fsSafeStoreScopes),
    jsonStoreScope = lastScope(fsSafeJsonStoreScopes),
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
    storeScope = lastScope(fsSafeStoreScopes),
    jsonStoreScope = lastScope(fsSafeJsonStoreScopes),
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
    scope = lastScope(fsModulePropertyScopes),
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
        lastScope(fsModuleBindingScopes).set(bindingName.text, true);
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
    index,
    objectName,
    propertyName,
    value,
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

  function recordBranchWrapperAssignment(index, name, value) {
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
    index,
    objectName,
    propertyName,
    storeValue,
    jsonStoreValue,
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
    const parentEffect = lastScope(branchEffectScopes);
    const applyToTargetScopes = !lastScope(conditionalExecutionScopes) && !parentEffect;
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
      lastScope(fsModuleBindingScopes).set(name, mergedModuleValue);
      lastScope(fsWriteAliasScopes).set(name, mergedWriteAlias);
      lastScope(fsSafeStoreFactoryAliasScopes).set(name, mergedFsSafeFactoryAlias);
      lastScope(fsSafeStoreScopes).set(name, mergedFsSafeStoreValue);
      lastScope(fsSafeJsonStoreScopes).set(name, mergedFsSafeJsonStoreValue);
      lastScope(requireAliasScopes).set(name, mergedRequireAlias);
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
      if (!elseAssignment) {
        continue;
      }
      const { index, name } = thenAssignment;
      const mergedValue = mergeWrapperAssignmentValues(thenAssignment.value, elseAssignment.value);
      if (applyToTargetScopes) {
        wrapperFunctionScopes[index].set(name, cloneWrapperFunctionValue(mergedValue));
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
    objectName,
    initializer,
    targetScope = lastScope(legacyObjectPropertyScopes),
    knownObjectLiteralScope = lastScope(legacyKnownObjectLiteralScopes),
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
    targetScope = lastScope(legacyObjectPropertyScopes),
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
    targetScope = lastScope(legacyKnownObjectLiteralScopes),
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
      clearLegacyObjectProperties(lastScope(legacyObjectPropertyScopes), key);
      lastScope(legacyObjectPropertyScopes).set(key, value);
    }
  }

  function copyScopedKnownLegacyObjectLiterals(targetName, sourceName, sourceScope) {
    lastScope(legacyKnownObjectLiteralScopes).set(targetName, sourceScope.get(sourceName) === true);
    const sourcePrefix = `${sourceName}.`;
    const copiedEntries = [];
    for (const [key, value] of sourceScope) {
      if (key.startsWith(sourcePrefix)) {
        copiedEntries.push([`${targetName}.${key.slice(sourcePrefix.length)}`, value]);
      }
    }
    copiedEntries.sort((left, right) => left[0].length - right[0].length);
    for (const [key, value] of copiedEntries) {
      clearKnownLegacyObjectLiterals(lastScope(legacyKnownObjectLiteralScopes), key);
      lastScope(legacyKnownObjectLiteralScopes).set(key, value);
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

  function parameterPropertyDestructureIndex(node, resolveParameterIndex) {
    if (
      !ts.isObjectBindingPattern(node.name) ||
      !node.initializer ||
      !ts.isIdentifier(node.initializer)
    ) {
      return null;
    }
    return resolveParameterIndex(node.initializer.text);
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
        lastScope(legacyPathScopes).set(element.name.text, propertyValue);
        lastScope(knownUndefinedScopes).set(
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
        lastScope(wrapperFunctionScopes).set(
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
          lastScope(legacyPathScopes).set(element.name.text, propertyValue);
          lastScope(knownUndefinedScopes).set(
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
        lastScope(fsSafeStoreScopes).set(
          element.name.text,
          trackedStore ??
            (element.initializer ? isFsSafeStoreExpression(element.initializer) : false),
        );
        lastScope(fsSafeJsonStoreScopes).set(
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
        lastScope(fsSafeStoreFactoryAliasScopes).set(element.name.text, factoryAlias);
      }
    }
  }

  function collectForwardedPropertyUses({
    argument,
    propertyName,
    parameter = null,
    wrapperNode = null,
    argumentsList = [],
    options = {},
    resolveParameterIndex,
    resolveDestructuredParameterProperty,
    resolveParameterPropertyUse,
    resolveDestructuredParameterPropertyUses,
    resolveSpreadProperty,
  }) {
    const collectUses = (expression) =>
      collectPathPropertyUses(
        expression,
        "writeFile",
        resolveParameterIndex,
        resolveDestructuredParameterProperty,
        resolveParameterPropertyUse,
        resolveDestructuredParameterPropertyUses,
      );
    if (propertyName === null) {
      return collectUses(argument);
    }

    const propertyPath = propertyName.split(".");
    function collectBindingDefaultUses(sourceExpression) {
      if (!parameter || !ts.isObjectBindingPattern(parameter.name)) {
        return [];
      }
      const initializer = appliedBindingElementDefaultInitializer(
        parameter.name,
        propertyPath,
        sourceExpression,
        resolveSpreadProperty,
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
      return defaultExpression ? collectUses(defaultExpression) : [];
    }

    function collectPropertyUseState(currentArgument, currentPropertyPath) {
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
      if (!ts.isObjectLiteralExpression(currentUnwrapped)) {
        const uses = collectUses(currentArgument);
        return uses.length > 0 ? uses : null;
      }

      let result = null;
      for (const property of currentUnwrapped.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spreadUses = collectPropertyUseState(property.expression, currentPropertyPath);
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
          } else if (remainingPropertyPath.length > 0) {
            result = collectPropertyUseState(property.initializer, remainingPropertyPath);
          } else {
            result = collectUses(property.initializer);
          }
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === nextPropertyName) {
          result =
            remainingPropertyPath.length > 0
              ? collectPropertyUseState(property.name, remainingPropertyPath)
              : collectUses(property.name);
        }
      }
      return result;
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
        collectPropertyUseState(unwrapped, propertyPath) ?? collectBindingDefaultUses(unwrapped)
      );
    }
    return collectUses(argument);
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
  }) {
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

      const propertyName =
        ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property)
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

  function collectLegacyPathPropertyParameters(
    node,
    baseFsWriteAliases,
    baseFsModuleBindings,
    baseFsModuleProperties,
    baseRequireAliases,
    baseCreateRequireShadows,
    activeWrapperNodes = new Set(),
    baseNestedWrapperFunctions = null,
    closure = null,
  ) {
    if (activeWrapperNodes.has(node)) {
      return new Map();
    }
    activeWrapperNodes.add(node);
    const parameterIndexes = new Map();
    const parameterBindingNames = new Set();
    // Opaque keys keep captured parameters distinct from the nested wrapper's own indexes.
    // The closure adapter unwraps exactly one level when returning uses to its caller.
    const closureIndexKeys = new Map();
    const closureIndex = (index) => {
      if (!closureIndexKeys.has(index)) {
        closureIndexKeys.set(index, { closureIndex: index });
      }
      return closureIndexKeys.get(index);
    };
    const closureBinding = (binding) => {
      if (Array.isArray(binding)) {
        return binding.map(closureBinding);
      }
      return binding && typeof binding === "object" && "index" in binding
        ? { ...binding, index: closureIndex(binding.index) }
        : binding;
    };
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
    const inheritedNestedWrapperFunctionScopes = Array.isArray(baseNestedWrapperFunctions)
      ? baseNestedWrapperFunctions
      : baseNestedWrapperFunctions
        ? [baseNestedWrapperFunctions]
        : [];
    // Closed-over assignments update the enclosing scope, while local/self shadows stay isolated.
    const localNestedWrapperFunctionScope = closure
      ? new Map()
      : new Map(inheritedNestedWrapperFunctionScopes.flatMap((scope) => [...scope]));
    const nestedWrapperFunctionScopes = closure
      ? [...inheritedNestedWrapperFunctionScopes, localNestedWrapperFunctionScope]
      : [localNestedWrapperFunctionScope];
    const nestedWrapperFunctionScopeParents = new Map();
    for (const [index, scope] of nestedWrapperFunctionScopes.entries()) {
      nestedWrapperFunctionScopeParents.set(scope, nestedWrapperFunctionScopes[index - 1] ?? null);
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
      const effects = lastScope(wrapperBranchEffectScopes);
      if (effects) {
        effects.parameterObjectAssignments.set(name, bindingUses(objectIndex));
      }
    }

    function recordWrapperBranchParameterPropertyAssignment(key, binding) {
      const effects = lastScope(wrapperBranchEffectScopes);
      if (effects) {
        effects.parameterPropertyAssignments.set(key, bindingUses(binding));
      }
    }

    function recordWrapperBranchDestructuredAssignment(name, binding) {
      const effects = lastScope(wrapperBranchEffectScopes);
      if (effects) {
        effects.destructuredAssignments.set(name, bindingUses(binding));
      }
    }

    function recordWrapperBranchNestedWrapperAssignment(name, value, targetScope) {
      const effects = lastScope(wrapperBranchEffectScopes);
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
      const effects = lastScope(wrapperBranchEffectScopes);
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
      lastScope(parameterPropertyUseScopes).set(key, null);
      for (const use of uses) {
        appendConditionalUse(lastScope(conditionalParameterPropertyUseScopes), key, use);
      }
      recordWrapperBranchParameterPropertyAssignment(key, uses[0] ?? null);
      const parentEffect = lastScope(wrapperBranchEffectScopes);
      if (parentEffect && uses.length > 1) {
        parentEffect.parameterPropertyAssignments.set(key, uses);
      }
    }

    function applyMergedDestructuredAssignment(name, uses) {
      lastScope(destructuredParameterPropertyScopes).set(name, null);
      lastScope(destructuredParameterPropertyMergeScopes).set(name, null);
      for (const use of uses) {
        appendConditionalUse(lastScope(conditionalDestructuredParameterPropertyScopes), name, use);
      }
      recordWrapperBranchDestructuredAssignment(name, uses[0] ?? null);
      const parentEffect = lastScope(wrapperBranchEffectScopes);
      if (parentEffect && uses.length > 1) {
        parentEffect.destructuredAssignments.set(name, uses);
      }
    }

    function applyMergedParameterObjectAssignment(name, uses) {
      if (uses.length === 0) {
        lastScope(parameterObjectShadowScopes).add(name);
        lastScope(parameterObjectAssignmentShadowScopes).add(name);
      } else {
        lastScope(parameterObjectBindingScopes).set(name, uses[0]);
        for (const use of uses.slice(1)) {
          appendConditionalUse(lastScope(conditionalParameterObjectScopes), name, use);
        }
      }
      const parentEffect = lastScope(wrapperBranchEffectScopes);
      if (parentEffect) {
        parentEffect.parameterObjectAssignments.set(name, uses);
      }
    }

    function applyMergedNestedWrapperAssignment(name, value, targetScope = null) {
      const resolvedTargetScope = targetScope ?? scopeForWrite(nestedWrapperFunctionScopes, name);
      if (!resolvedTargetScope) {
        return;
      }
      clearNestedWrapperObjectMethods(resolvedTargetScope, name);
      resolvedTargetScope.set(name, cloneWrapperFunctionValue(value));
      const parentEffect = lastScope(wrapperBranchEffectScopes);
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
      const parentEffect = lastScope(wrapperBranchEffectScopes);
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

    function mergeOptionalWrapperBranchEffects(effects) {
      for (const assignment of effects.fsIdentifierAssignments.values()) {
        applyMergedFsIdentifierAssignment(assignment, {
          ...assignment,
          moduleValue: assignment.moduleScope?.get(assignment.name) === true,
          requireAlias: assignment.requireAliasScope?.get(assignment.name) === true,
          writeAlias: assignment.writeAliasScope?.get(assignment.name) ?? null,
        });
      }
      for (const [name, value] of effects.nestedWrapperAssignments) {
        const targetScope = effects.nestedWrapperAssignmentScopes.get(name);
        if (targetScope) {
          applyMergedNestedWrapperAssignment(
            name,
            mergeWrapperAssignmentValues(targetScope.get(name), value),
            targetScope,
          );
        }
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
      if (parameterIndexes.has(name)) {
        return parameterIndexes.get(name);
      }
      const index = closure?.resolveParameterIndex(name) ?? null;
      return index === null ? null : closureIndex(index);
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
      return closureBinding(closure?.resolveDestructuredParameterProperty(name) ?? null);
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
        return baseUse === undefined
          ? closureBinding(closure?.resolveParameterPropertyUse(objectName, propertyName))
          : baseUse;
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
        return (
          baseUse ?? closureBinding(closure?.resolveDestructuredParameterPropertyUses(name) ?? null)
        );
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
      return collectForwardedPropertyUses({
        argument,
        propertyName,
        parameter,
        wrapperNode,
        argumentsList,
        options,
        resolveParameterIndex,
        resolveDestructuredParameterProperty,
        resolveParameterPropertyUse,
        resolveDestructuredParameterPropertyUses,
        resolveSpreadProperty: nestedWrapperObjectLiteralSpreadPropertyState,
      });
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
          if (lastScope(conditionalWrapperBodyScopes)) {
            recordWrapperBranchParameterObjectAssignment(assignmentNode.left.text, objectIndex);
            if (objectIndex !== null) {
              appendConditionalUse(
                lastScope(conditionalParameterObjectScopes),
                assignmentNode.left.text,
                objectIndex,
              );
            }
          } else if (objectIndex !== null) {
            lastScope(parameterObjectBindingScopes).set(assignmentNode.left.text, objectIndex);
          } else {
            lastScope(parameterObjectShadowScopes).add(assignmentNode.left.text);
            lastScope(parameterObjectAssignmentShadowScopes).add(assignmentNode.left.text);
          }
        }
        if (resolveDestructuredParameterProperty(assignmentNode.left.text)) {
          const binding = resolveParameterPropertyBinding(assignmentNode.right);
          if (lastScope(conditionalWrapperBodyScopes)) {
            recordWrapperBranchDestructuredAssignment(assignmentNode.left.text, binding);
            if (binding) {
              appendConditionalUse(
                lastScope(conditionalDestructuredParameterPropertyScopes),
                assignmentNode.left.text,
                binding,
              );
            }
          } else {
            const updatesOuterBinding = !lastScope(destructuredParameterPropertyScopes).has(
              assignmentNode.left.text,
            );
            lastScope(destructuredParameterPropertyScopes).set(assignmentNode.left.text, binding);
            if (updatesOuterBinding) {
              lastScope(destructuredParameterPropertyMergeScopes).set(
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
        if (lastScope(conditionalWrapperBodyScopes)) {
          recordWrapperBranchParameterPropertyAssignment(key, binding);
          if (binding) {
            appendConditionalUse(lastScope(conditionalParameterPropertyUseScopes), key, binding);
          }
        } else {
          lastScope(parameterPropertyUseScopes).set(key, binding);
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
        if (parameterIndexes.has(key) || (closure && closure.resolveParameterIndex(key) !== null)) {
          target.set(key, value);
        }
      }
    }

    function pushWrapperBodyScope(
      conditional = lastScope(conditionalWrapperBodyScopes),
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
        lastScope(nestedWrapperFunctionScopes),
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
        mergeConditionalUses(
          parameterPropertyUses,
          lastScope(conditionalParameterPropertyUseScopes),
        );
        mergeConditionalUses(parameterObjectUses, lastScope(conditionalParameterObjectScopes));
        mergeConditionalUses(
          destructuredUses,
          lastScope(conditionalDestructuredParameterPropertyScopes),
        );
      } else {
        mergeMapEntries(directParameterPropertyUses, lastScope(parameterPropertyUseScopes));
        mergeParameterObjectBindings(
          directParameterObjectBindings,
          lastScope(parameterObjectBindingScopes),
        );
        for (const name of parameterObjectAssignmentShadows) {
          lastScope(parameterObjectShadowScopes).add(name);
          lastScope(parameterObjectAssignmentShadowScopes).add(name);
        }
        mergeMapEntries(directDestructuredBindings, lastScope(destructuredParameterPropertyScopes));
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
        lastScope(bodyRequireAliasScopes).set(bindingName, false);
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

    function markWrapperCreateRequireShadows(
      name,
      scope = lastScope(wrapperCreateRequireShadowScopes),
    ) {
      for (const bindingName of bindingPatternNames(name)) {
        if (createRequireBindings.has(bindingName)) {
          scope.add(bindingName);
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

    function shadowVisibleBodyFsWriteObjectAliases(objectName) {
      const prefix = `${objectName}.`;
      const currentScope = lastScope(bodyFsWriteAliasScopes);
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
      scope = lastScope(bodyFsWriteAliasScopes),
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
          lastScope(fsAliasShadowScopes).add(bindingName);
        }
      }
    }

    function markFsModuleShadows(name) {
      for (const bindingName of bindingPatternNames(name)) {
        if (resolveBodyFsModuleBinding(bindingName)) {
          lastScope(fsModuleShadowScopes).add(bindingName);
          lastScope(bodyFsModuleBindingScopes).set(bindingName, false);
        }
        lastScope(bodyFsModulePropertyScopes).set(bindingName, false);
      }
    }

    function registerBodyFsModuleTypeProperties(name, type) {
      if (!ts.isIdentifier(name) || !type) {
        return;
      }
      if (isFsModuleTypeNode(type)) {
        lastScope(bodyFsModuleBindingScopes).set(name.text, true);
      }
      for (const pathParts of fsModulePropertyPathsFromType(type)) {
        lastScope(bodyFsModulePropertyScopes).set([name.text, ...pathParts].join("."), true);
      }
    }

    if (closure && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
      const name = node.name.text;
      lastScope(shadowScopes).add(name);
      lastScope(parameterObjectShadowScopes).add(name);
      lastScope(bodyFsWriteAliasScopes).set(name, null);
      lastScope(bodyFsModuleBindingScopes).set(name, false);
      lastScope(bodyRequireAliasScopes).set(name, false);
      lastScope(nestedWrapperFunctionScopes).set(name, null);
      markWrapperCreateRequireShadows(node.name);
    }

    node.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        parameterIndexes.set(parameter.name.text, index);
      }
      for (const bindingName of bindingPatternNames(parameter.name)) {
        parameterBindingNames.add(bindingName);
        lastScope(nestedWrapperFunctionScopes).set(bindingName, null);
      }
      markFsAliasShadows(parameter.name);
      markFsModuleShadows(parameter.name);
      markWrapperRequireShadows(parameter.name);
      markWrapperCreateRequireShadows(parameter.name);
      registerBodyFsModuleTypeProperties(parameter.name, parameter.type);
      for (const [name, binding] of parameterPropertyBindings(parameter, index)) {
        lastScope(destructuredParameterPropertyScopes).set(name, binding);
      }
    });

    if (closure?.argumentsList) {
      node.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name) || !parameter.initializer) {
          return;
        }
        const providedArgument = closure.argumentsList[index] ?? null;
        if (providedArgument && !isKnownUndefinedExpression(providedArgument)) {
          return;
        }
        const initializer = unwrapExpression(parameter.initializer);
        if (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer)) {
          lastScope(nestedWrapperFunctionScopes).set(
            parameter.name.text,
            nestedWrapperRecordForNode(initializer),
          );
        }
      });
    }

    const propertyUses = new Map();

    function nestedWrapperRecordForNode(nestedNode) {
      const requireAliasSnapshot = visibleBodyRequireAliasSnapshot();
      return {
        aliases: visibleMap(bodyFsWriteAliasScopes),
        closesOverCurrentWrapper: true,
        createRequireShadows: visibleSet(wrapperCreateRequireShadowScopes),
        lexicalScope: lastScope(nestedWrapperFunctionScopes),
        lexicalScopes: [...nestedWrapperFunctionScopes],
        moduleBindings: visibleMap(bodyFsModuleBindingScopes),
        moduleProperties: visibleMap(bodyFsModulePropertyScopes),
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
      const aliases = visibleMap(bodyFsWriteAliasScopes);
      const moduleBindings = visibleMap(bodyFsModuleBindingScopes);
      const moduleProperties = visibleMap(bodyFsModulePropertyScopes);
      const requireAliasSnapshot = visibleBodyRequireAliasSnapshot();
      const createRequireShadows = visibleSet(wrapperCreateRequireShadowScopes);
      const currentLexicalScope = lastScope(nestedWrapperFunctionScopes);
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
      const branchEffects = lastScope(wrapperBranchEffectScopes);
      if (branchEffects) {
        refreshNestedWrapperRecords(branchEffects.nestedWrapperAssignments.values());
      }
    }

    function nestedWrapperObjectMethodWriteScope(objectName, propertyName) {
      const key = objectPropertyKey(objectName, propertyName);
      for (let index = nestedWrapperFunctionScopes.length - 1; index >= 0; index--) {
        const scope = nestedWrapperFunctionScopes[index];
        if (scope.has(key) || scope.has(objectName)) {
          return scope;
        }
      }
      return lastScope(nestedWrapperFunctionScopes);
    }

    function markNestedWrapperFunctionShadows(name) {
      for (const bindingName of bindingPatternNames(name)) {
        lastScope(nestedWrapperFunctionScopes).set(bindingName, null);
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
      const currentScope = lastScope(nestedWrapperFunctionScopes);
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
      scope = lastScope(nestedWrapperFunctionScopes),
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
      scope = lastScope(nestedWrapperFunctionScopes),
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
      scope = lastScope(nestedWrapperFunctionScopes),
      recordBranchAssignments = false,
      recordBranchAssignmentScope = scope,
    ) {
      const registeredMethods = new Map();
      const remember = (key, value, clear = true) => {
        if (clear) {
          clearNestedWrapperObjectMethods(scope, key);
        }
        scope.set(key, value);
        registeredMethods.set(key, value);
        if (recordBranchAssignments) {
          recordWrapperBranchNestedWrapperAssignment(key, value, recordBranchAssignmentScope);
        }
      };
      const copy = (targetName, sourceName) => {
        const copied = copyNestedWrapperObjectMethods(
          targetName,
          sourceName,
          scope,
          recordBranchAssignments,
          recordBranchAssignmentScope,
        );
        for (const entry of copied) {
          registeredMethods.set(...entry);
        }
        return copied;
      };
      const sourceName = (expression) =>
        ts.isIdentifier(expression) ? expression.text : callExpressionName(expression);

      registerTrackedObjectMethods({
        objectName,
        initializer,
        directSourceName: sourceName,
        spreadSourceName: sourceName,
        onAlias: copy,
        onUnknownSpread: (targetName) =>
          markNestedWrapperObjectUnknown(
            targetName,
            scope,
            recordBranchAssignments,
            recordBranchAssignmentScope,
          ),
        onSpread: (targetName, spreadSource) => {
          if (!isKnownNestedWrapperObjectSource(spreadSource)) {
            markNestedWrapperObjectUnknown(
              targetName,
              scope,
              recordBranchAssignments,
              recordBranchAssignmentScope,
            );
          }
          copy(targetName, spreadSource);
        },
        onMethod: (key, method) => remember(key, nestedWrapperRecordForNode(method)),
        onIdentifier: (key, identifier, expression) => {
          clearNestedWrapperObjectMethods(scope, key);
          if (isKnownUndefinedExpression(expression)) {
            remember(key, explicitUndefinedNestedWrapperValue);
            return;
          }
          const wrapper = resolveNestedWrapperValue(identifier);
          if (closure && isNestedWrapperObjectMarker(wrapper)) {
            remember(key, wrapper);
            copy(key, identifier);
            return;
          }
          if (wrapper) {
            remember(
              key,
              wrapperRecords(wrapper).length > 0 ? cloneWrapperFunctionValue(wrapper) : null,
            );
            if (wrapperRecords(wrapper).length === 0) {
              copy(key, identifier);
            }
            return;
          }
          if (copy(key, identifier).size === 0) {
            remember(key, null);
          }
        },
        onNested: (key, nested) => {
          clearNestedWrapperObjectMethods(scope, key);
          registerNestedWrapperObjectMethods(
            key,
            nested,
            scope,
            recordBranchAssignments,
            recordBranchAssignmentScope,
          );
        },
        onOther: (key, expression, hasNestedObject) => {
          const wrapper = isKnownUndefinedExpression(expression)
            ? explicitUndefinedNestedWrapperValue
            : resolveNestedWrapperExpression(expression);
          remember(key, wrapper ? cloneWrapperFunctionValue(wrapper) : null, !hasNestedObject);
        },
      });
      return registeredMethods;
    }
    function registerNestedWrapperObjectBinding(
      bindingPattern,
      sourceName,
      propertyPath = [],
      scope = lastScope(nestedWrapperFunctionScopes),
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
      scope = lastScope(nestedWrapperFunctionScopes),
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
      scope = lastScope(nestedWrapperFunctionScopes),
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

    function collectClosedOverPathPropertyUses(
      record,
      activeClosedOverNodes = new Set(),
      argumentsList = null,
    ) {
      const uses = collectLegacyPathPropertyParameters(
        record.node,
        record.aliases,
        record.moduleBindings,
        record.moduleProperties,
        record.requireAliases,
        record.createRequireShadows,
        activeClosedOverNodes,
        record.lexicalScopes ?? record.lexicalScope ?? null,
        {
          argumentsList,
          resolveParameterIndex,
          resolveDestructuredParameterProperty,
          resolveParameterPropertyUse,
          resolveDestructuredParameterPropertyUses,
        },
      );
      const closedOverUses = new Map();
      for (const [key, propertyNames] of uses) {
        if (!key || typeof key !== "object" || !("closureIndex" in key)) {
          continue;
        }
        const properties = closedOverUses.get(key.closureIndex) ?? new Set();
        for (const propertyName of propertyNames) {
          properties.add(propertyName);
        }
        closedOverUses.set(key.closureIndex, properties);
      }
      return closedOverUses;
    }
    function registerHoistedWrapperFunctionShadows(statements) {
      for (const statement of statements) {
        if (closure && ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            const isVar = isVarVariableDeclaration(declaration);
            const fsWriteScope = isVar
              ? bodyFsWriteAliasScopes[0]
              : lastScope(bodyFsWriteAliasScopes);
            const fsModuleScope = isVar
              ? bodyFsModuleBindingScopes[0]
              : lastScope(bodyFsModuleBindingScopes);
            const requireScope = isVar
              ? bodyRequireAliasScopes[0]
              : lastScope(bodyRequireAliasScopes);
            const nestedScope = isVar
              ? localNestedWrapperFunctionScope
              : lastScope(nestedWrapperFunctionScopes);
            const parameterShadowScope = isVar
              ? parameterObjectShadowScopes[0]
              : lastScope(parameterObjectShadowScopes);
            const destructuredShadowScope = isVar ? shadowScopes[0] : lastScope(shadowScopes);
            for (const name of bindingPatternNames(declaration.name)) {
              fsWriteScope.set(name, null);
              fsModuleScope.set(name, false);
              requireScope.set(name, false);
              if (!(isVar && parameterBindingNames.has(name))) {
                nestedScope.set(name, null);
              }
              parameterShadowScope.add(name);
              destructuredShadowScope.add(name);
            }
            markWrapperCreateRequireShadows(
              declaration.name,
              isVar
                ? wrapperCreateRequireShadowScopes[0]
                : lastScope(wrapperCreateRequireShadowScopes),
            );
          }
        }
        if (ts.isFunctionDeclaration(statement) && statement.name) {
          if (closure) {
            const name = statement.name.text;
            lastScope(shadowScopes).add(name);
            lastScope(parameterObjectShadowScopes).add(name);
            lastScope(bodyFsWriteAliasScopes).set(name, null);
            lastScope(bodyFsModuleBindingScopes).set(name, false);
            lastScope(bodyRequireAliasScopes).set(name, false);
          }
          markWrapperRequireShadows(statement.name);
          markWrapperCreateRequireShadows(statement.name);
          lastScope(nestedWrapperFunctionScopes).set(
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
        const thenEffects = current.elseStatement || closure ? createWrapperBranchEffects() : null;
        const elseEffects = current.elseStatement ? createWrapperBranchEffects() : null;
        pushWrapperBodyScope(true, thenEffects);
        visitBody(current.thenStatement);
        popWrapperBodyScope();
        if (current.elseStatement) {
          pushWrapperBodyScope(true, elseEffects);
          visitBody(current.elseStatement);
          popWrapperBodyScope();
          mergeExhaustiveWrapperBranchEffects(thenEffects, elseEffects);
        } else if (thenEffects) {
          mergeOptionalWrapperBranchEffects(thenEffects);
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
        const branchBlockEffects = lastScope(conditionalWrapperBodyScopes)
          ? lastScope(wrapperBranchEffectScopes)
          : null;
        pushWrapperBodyScope(lastScope(conditionalWrapperBodyScopes), branchBlockEffects);
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
        const declarationWrapperBranchEffects = lastScope(wrapperBranchEffectScopes);
        const declarationUsesConditionalScope =
          declarationIsVar && lastScope(conditionalWrapperBodyScopes);
        const declarationUsesBranchEffects =
          declarationIsVar && Boolean(declarationWrapperBranchEffects);
        const declarationFsWriteAliasOwnerScope = declarationIsVar
          ? bodyFsWriteAliasScopes[0]
          : lastScope(bodyFsWriteAliasScopes);
        const declarationFsModuleBindingOwnerScope = declarationIsVar
          ? bodyFsModuleBindingScopes[0]
          : lastScope(bodyFsModuleBindingScopes);
        const declarationRequireAliasOwnerScope = declarationIsVar
          ? bodyRequireAliasScopes[0]
          : lastScope(bodyRequireAliasScopes);
        const declarationNestedWrapperOwnerScope = declarationIsVar
          ? closure
            ? localNestedWrapperFunctionScope
            : nestedWrapperFunctionScopes[0]
          : lastScope(nestedWrapperFunctionScopes);
        const declarationFsWriteAliasScope = declarationUsesConditionalScope
          ? lastScope(bodyFsWriteAliasScopes)
          : declarationFsWriteAliasOwnerScope;
        const declarationFsModuleBindingScope = declarationUsesConditionalScope
          ? lastScope(bodyFsModuleBindingScopes)
          : declarationFsModuleBindingOwnerScope;
        const declarationRequireAliasScope = declarationUsesConditionalScope
          ? lastScope(bodyRequireAliasScopes)
          : declarationRequireAliasOwnerScope;
        const declarationNestedWrapperScope = declarationUsesConditionalScope
          ? lastScope(nestedWrapperFunctionScopes)
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
            const preservesParameterValue =
              declarationIsVar &&
              !current.initializer &&
              parameterBindingNames.has(current.name.text);
            if (!preservesParameterValue) {
              declarationNestedWrapperScope.set(
                current.name.text,
                current.initializer && ts.isObjectLiteralExpression(nestedFunctionInitializer)
                  ? knownObjectLiteralNestedWrapperValue
                  : current.initializer
                    ? cloneWrapperFunctionValue(resolveNestedWrapperExpression(current.initializer))
                    : null,
              );
            }
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
        const destructuredParameterIndex = parameterPropertyDestructureIndex(
          current,
          resolveParameterIndex,
        );
        if (destructuredParameterIndex !== null) {
          for (const [name, binding] of objectBindingParameterProperties(
            current.name,
            destructuredParameterIndex,
          )) {
            lastScope(destructuredParameterPropertyScopes).set(name, binding);
          }
        } else if (
          ts.isIdentifier(current.name) &&
          initializerPropertyAccess &&
          initializerParameterIndex !== null
        ) {
          lastScope(destructuredParameterPropertyScopes).set(current.name.text, {
            index: initializerParameterIndex,
            propertyName: initializerPropertyAccess.propertyName,
          });
        } else if (ts.isIdentifier(current.name) && initializerObjectIndex !== null) {
          lastScope(parameterObjectBindingScopes).set(current.name.text, initializerObjectIndex);
        } else {
          for (const name of bindingPatternNames(current.name)) {
            if (resolveDestructuredParameterProperty(name)) {
              lastScope(shadowScopes).add(name);
            }
            if (
              parameterIndexes.has(name) ||
              (closure && closure.resolveParameterIndex(name) !== null)
            ) {
              lastScope(parameterObjectShadowScopes).add(name);
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
        const fsModuleBindingScope = scopeForWrite(bodyFsModuleBindingScopes, current.left.text);
        const fsWriteAliasScope = scopeForWrite(bodyFsWriteAliasScopes, current.left.text);
        const requireAliasScope = scopeForWrite(bodyRequireAliasScopes, current.left.text);
        const nextFsModuleBinding = isWrapperFsBindingExpression(current.right);
        const nextFsWriteAlias = legacyWrapperFsWriteName(current.right);
        const nextRequireAlias = isWrapperRequireAliasExpression(current.right);
        const wrapperBranchEffects = lastScope(wrapperBranchEffectScopes);
        if (wrapperBranchEffects) {
          lastScope(bodyFsModuleBindingScopes).set(current.left.text, nextFsModuleBinding);
          lastScope(bodyFsWriteAliasScopes).set(current.left.text, nextFsWriteAlias);
          lastScope(bodyRequireAliasScopes).set(current.left.text, nextRequireAlias);
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
            lastScope(conditionalWrapperBodyScopes)
              ? fsModuleBindingScope.get(current.left.text) === true || nextFsModuleBinding
              : nextFsModuleBinding,
          );
          fsWriteAliasScope.set(
            current.left.text,
            lastScope(conditionalWrapperBodyScopes)
              ? (fsWriteAliasScope.get(current.left.text) ?? nextFsWriteAlias)
              : nextFsWriteAlias,
          );
          requireAliasScope.set(
            current.left.text,
            lastScope(conditionalWrapperBodyScopes)
              ? requireAliasScope.get(current.left.text) === true || nextRequireAlias
              : nextRequireAlias,
          );
        }
        shadowVisibleBodyFsWriteObjectAliases(current.left.text);
        clearBodyFsWriteObjectAliases(lastScope(bodyFsWriteAliasScopes), current.left.text);
        registerBodyFsWriteObjectAliases(current.left.text, current.right);
        const exhaustiveNestedWrapperBranch = Boolean(wrapperBranchEffects);
        const optionalNestedWrapperBranch =
          lastScope(conditionalWrapperBodyScopes) && !exhaustiveNestedWrapperBranch;
        const nestedWrapperOwnerScope = scopeForWrite(
          nestedWrapperFunctionScopes,
          current.left.text,
        );
        const nestedWrapperTargetScope = lastScope(conditionalWrapperBodyScopes)
          ? lastScope(nestedWrapperFunctionScopes)
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
            lastScope(bodyFsWriteAliasScopes),
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
        const exhaustiveNestedWrapperBranch = Boolean(lastScope(wrapperBranchEffectScopes));
        const optionalNestedWrapperBranch =
          lastScope(conditionalWrapperBodyScopes) && !exhaustiveNestedWrapperBranch;
        const nestedWrapperOwnerScope = nestedWrapperObjectMethodWriteScope(
          propertyAccess.rootName,
          propertyName,
        );
        const nestedWrapperTargetScope = lastScope(conditionalWrapperBodyScopes)
          ? lastScope(nestedWrapperFunctionScopes)
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
            record.lexicalScopes ?? record.lexicalScope ?? null,
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
    if (closure) {
      for (const parameter of node.parameters) {
        if (parameter.initializer) {
          visitBody(parameter.initializer);
        }
      }
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
      aliases: visibleMap(fsWriteAliasScopes),
      createRequireShadows: visibleSet(createRequireShadowScopes),
      lexicalScopeIndex: wrapperFunctionScopes.length - 1,
      moduleBindings: visibleMap(fsModuleBindingScopes),
      moduleProperties: visibleMap(fsModulePropertyScopes),
      node,
      requireAliases: requireAliasSnapshot.aliases,
      requireAliasSourceScopes: requireAliasSnapshot.sourceScopes,
    };
  }

  function registerWrapperFunction(name, node) {
    lastScope(wrapperFunctionScopes).set(name, wrapperRecordForNode(node));
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
    const currentScope = lastScope(wrapperFunctionScopes);
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
    scope = lastScope(wrapperFunctionScopes),
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
    scope = lastScope(wrapperFunctionScopes),
    conditionalWrite = false,
  ) {
    const seenProperties = new Set();
    const remember = (key, value) => setWrapperFunctionValue(scope, key, value, conditionalWrite);
    const copy = (targetName, sourceName) =>
      copyWrapperObjectMethods(targetName, sourceName, scope, conditionalWrite);

    registerTrackedObjectMethods({
      objectName,
      initializer,
      onUnknownSpread: () => clearWrapperObjectMethods(scope, objectName),
      onSpread: (targetName, sourceName) => {
        if (copy(targetName, sourceName) === 0) {
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
    });
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
      lexicalScopes: record.lexicalScopes ? [...record.lexicalScopes] : undefined,
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
    const aliases = visibleMap(fsWriteAliasScopes);
    const moduleBindings = visibleMap(fsModuleBindingScopes);
    const moduleProperties = visibleMap(fsModulePropertyScopes);
    const requireAliasSnapshot = visibleRequireAliasSnapshot();
    const createRequireShadows = visibleSet(createRequireShadowScopes);
    const currentLexicalScopeIndex = wrapperFunctionScopes.length - 1;
    for (const value of lastScope(wrapperFunctionScopes).values()) {
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
        lastScope(requireAliasScopes).set(statement.name.text, false);
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
          lastScope(fsModuleBindingScopes).set(node.name.text, true);
        } else {
          markFsModuleBindingShadows(node.name);
        }
        markFsModulePropertyShadows(node.name);
        registerFsModuleTypeProperties(node.name, node.type);
        if (!(node.name.text === "require" && isCreateRequireExpression(node.initializer))) {
          markRequireShadows(node.name);
        }
        lastScope(requireAliasScopes).set(
          node.name.text,
          isRequireAliasExpression(node.initializer),
        );
        markCreateRequireShadows(node.name);
        collectFsWriteAliasesFromBinding(node);
        markFsWriteAliasShadows(node.name);
        markFsSafeStoreShadows(node.name);
        lastScope(fsWriteAliasScopes).set(node.name.text, legacyFsWriteName(node.initializer));
        lastScope(fsSafeStoreFactoryAliasScopes).set(
          node.name.text,
          fsSafeStoreFactoryAliasName(node.initializer),
        );
        lastScope(fsSafeStoreScopes).set(node.name.text, isFsSafeStoreExpression(node.initializer));
        lastScope(fsSafeJsonStoreScopes).set(
          node.name.text,
          expressionContainsFsSafeJsonStoreLegacyPath(node.initializer),
        );
        refreshCurrentWrapperFunctionAliases();
        lastScope(literalTextScopes).set(
          node.name.text,
          literalTextsFromExpression(node.initializer),
        );
        lastScope(knownUndefinedScopes).set(
          node.name.text,
          isKnownUndefinedExpression(node.initializer),
        );
        lastScope(legacyPathScopes).set(
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
          lastScope(wrapperFunctionScopes).set(
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
        lastScope(fsModuleBindingScopes).set(node.name.text, false);
        lastScope(fsWriteAliasScopes).set(node.name.text, null);
        lastScope(fsSafeStoreFactoryAliasScopes).set(node.name.text, null);
        lastScope(fsSafeStoreScopes).set(node.name.text, false);
        lastScope(fsSafeJsonStoreScopes).set(node.name.text, false);
        lastScope(requireAliasScopes).set(node.name.text, false);
        lastScope(legacyPathScopes).set(node.name.text, false);
        lastScope(legacyKnownObjectLiteralScopes).set(node.name.text, false);
        lastScope(knownUndefinedScopes).set(node.name.text, !isAmbientVariableDeclaration(node));
        lastScope(literalTextScopes).set(node.name.text, null);
        lastScope(wrapperFunctionScopes).set(node.name.text, null);
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
        legacyKnownObjectLiteralScopes[index].set(
          node.left.text,
          legacyKnownObjectLiteralScopes[index].get(node.left.text) === true &&
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
        lastScope(fsModuleBindingScopes).set(node.left.text, nextFsModuleValue);
        lastScope(fsWriteAliasScopes).set(node.left.text, nextFsWriteAlias);
        lastScope(fsSafeStoreFactoryAliasScopes).set(node.left.text, nextFsSafeFactoryAlias);
        lastScope(fsSafeStoreScopes).set(node.left.text, nextFsSafeStoreValue);
        lastScope(fsSafeJsonStoreScopes).set(node.left.text, nextFsSafeJsonStoreValue);
        lastScope(requireAliasScopes).set(node.left.text, nextRequireAlias);
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
        lastScope(conditionalExecutionScopes) && !conditionalExecutionScopes[target.index];
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
  const nativeSourceRoots = databaseFirstNativeSourceRoots.map((root) => path.join(repoRoot, root));
  const nativeFiles = (await Promise.all(nativeSourceRoots.map(collectNativeSourceFiles))).flat();
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
