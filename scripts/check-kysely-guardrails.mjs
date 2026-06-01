#!/usr/bin/env node

import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  collectTypeScriptFilesFromRoots,
  getPropertyNameText,
  resolveRepoRoot,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const repoRoot = resolveRepoRoot(import.meta.url);
const sourceRoots = [path.join(repoRoot, "src")];

const kyselyRawAllowPaths = new Set([
  "src/infra/kysely-node-sqlite.test.ts",
  "src/infra/kysely-sync.ts",
]);

const compiledRawAllowPaths = new Set([
  "src/infra/kysely-node-sqlite.ts",
  "src/infra/kysely-node-sqlite.test.ts",
]);

const rawSqliteAllowPathGroups = {
  "native Kysely adapter and sync execution": [
    "src/infra/kysely-node-sqlite.ts",
    "src/infra/kysely-sync.ts",
  ],
  "SQLite database lifecycle, schema, transactions, and pragmas": [
    "src/infra/node-sqlite.ts",
    "src/infra/sqlite-integrity.ts",
    "src/infra/sqlite-pragma.test-support.ts",
    "src/infra/sqlite-transaction.ts",
    "src/infra/sqlite-wal.ts",
    "src/state/openclaw-agent-db.ts",
    "src/state/openclaw-state-db.ts",
    "src/state/sqlite-schema-shape.test-support.ts",
  ],
  "backup snapshot maintenance": ["src/commands/backup-verify.ts", "src/infra/backup-create.ts"],
  "doctor legacy state migration": ["src/infra/state-migrations.ts"],
  "Kysely-backed stores that own a DatabaseSync boundary": [
    "src/acp/event-ledger.ts",
    "src/agents/subagent-registry.store.ts",
    "src/cron/run-log.ts",
    "src/cron/run-log/sqlite-store.ts",
    "src/cron/store.ts",
    "src/infra/outbound/current-conversation-bindings.ts",
    "src/media/store.ts",
    "src/plugin-sdk/memory-core-host-engine-storage.ts",
    "src/plugins/installed-plugin-index-record-reader.ts",
    "src/plugins/installed-plugin-index-store.ts",
    "src/plugin-state/plugin-state-store.sqlite.ts",
    "src/proxy-capture/store.sqlite.ts",
    "src/tasks/task-flow-registry.store.sqlite.ts",
    "src/tasks/task-registry.store.sqlite.ts",
    "src/tui/tui-last-session.ts",
  ],
};

const rawSqliteAllowPathReasons = new Map();
for (const [reason, paths] of Object.entries(rawSqliteAllowPathGroups)) {
  for (const allowedPath of paths) {
    if (rawSqliteAllowPathReasons.has(allowedPath)) {
      throw new Error(`Duplicate raw SQLite allowlist path: ${allowedPath}`);
    }
    rawSqliteAllowPathReasons.set(allowedPath, reason);
  }
}

function lineText(sourceFile, node) {
  const line = toLine(sourceFile, node);
  return sourceFile.text.split("\n")[line - 1] ?? "";
}

function hasAllowComment(sourceFile, node, token) {
  const line = lineText(sourceFile, node);
  if (line.includes(token)) {
    return true;
  }
  const leading = ts.getLeadingCommentRanges(sourceFile.text, node.pos) ?? [];
  return leading.some((range) => sourceFile.text.slice(range.pos, range.end).includes(token));
}

function importSource(node) {
  const moduleSpecifier = node.moduleSpecifier;
  return ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : "";
}

function collectImports(sourceFile) {
  const kyselySqlNames = new Set();
  const compiledQueryNames = new Set();
  const syncHelperNames = new Set();
  let hasKyselyContext = false;
  let hasSqliteContext = false;

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const source = importSource(statement);
    const clause = statement.importClause;
    const namedBindings = clause?.namedBindings;

    if (source === "kysely") {
      hasKyselyContext = true;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === "sql") {
            kyselySqlNames.add(element.name.text);
          }
          if (importedName === "CompiledQuery") {
            compiledQueryNames.add(element.name.text);
          }
        }
      }
    }

    if (source.endsWith("kysely-sync.js") || source.endsWith("kysely-node-sqlite.js")) {
      hasKyselyContext = true;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (
            importedName === "executeSqliteQuerySync" ||
            importedName === "executeSqliteQueryTakeFirstSync"
          ) {
            syncHelperNames.add(element.name.text);
          }
          if (importedName === "getNodeSqliteKysely") {
            hasKyselyContext = true;
            hasSqliteContext = true;
          }
        }
      }
    }

    if (
      source === "node:sqlite" ||
      source.endsWith("node-sqlite.js") ||
      source.endsWith("sqlite-transaction.js") ||
      source.endsWith("sqlite-wal.js") ||
      source.endsWith("openclaw-state-db.js")
    ) {
      hasSqliteContext = true;
    }
  }

  return {
    compiledQueryNames,
    hasKyselyContext,
    hasSqliteContext,
    kyselySqlNames,
    syncHelperNames,
  };
}

function addViolation(violations, sourceFile, node, message) {
  violations.push({
    line: toLine(sourceFile, node),
    message,
  });
}

function isIdentifierNamed(node, names) {
  const unwrapped = unwrapExpression(node);
  return ts.isIdentifier(unwrapped) && names.has(unwrapped.text);
}

function isTestPath(relativePath) {
  return (
    /\.(?:test|spec|e2e)\.ts$/u.test(relativePath) ||
    relativePath.includes(".test-helpers.") ||
    relativePath.includes(".test-support.")
  );
}

function isSqliteStorePath(relativePath) {
  return relativePath.endsWith(".sqlite.ts") || relativePath.includes(".store.sqlite.ts");
}

function isLikelySqliteReceiver(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return /^(?:db|database|legacyDb|stateDb|agentDb)$/u.test(unwrapped.text);
  }
  return ts.isPropertyAccessExpression(unwrapped) && getPropertyNameText(unwrapped.name) === "db";
}

function isPersistedRowExpression(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(unwrapped)) {
    const owner = unwrapExpression(unwrapped.expression);
    return ts.isIdentifier(owner) && /^(?:row|record|entry)$/u.test(owner.text);
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    const owner = unwrapExpression(unwrapped.expression);
    return ts.isIdentifier(owner) && /^(?:row|record|entry)$/u.test(owner.text);
  }
  return false;
}

function isPersistedStringCastType(typeText) {
  return [
    /\bTaskRecord\["(?:runtime|scopeKind|status|deliveryStatus|notifyPolicy|terminalOutcome)"\]/u,
    /\bTaskFlowRecord\["(?:status|notifyPolicy)"\]/u,
    /\bTaskFlowSyncMode\b/u,
    /\bVirtualAgentFsEntryKind\b/u,
    /\b[A-Z][A-Za-z0-9]*(?:Status|Kind|Mode|Policy|Runtime|Outcome)\b/u,
  ].some((pattern) => pattern.test(typeText));
}

export function collectKyselyGuardrailViolations(content, relativePath) {
  const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true);
  const imports = collectImports(sourceFile);
  const violations = [];

  function visit(node) {
    if (
      isSqliteStorePath(relativePath) &&
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      isPersistedStringCastType(node.type.getText(sourceFile)) &&
      isPersistedRowExpression(node.expression) &&
      !hasAllowComment(sourceFile, node, "sqlite-allow-persisted-cast")
    ) {
      addViolation(
        violations,
        sourceFile,
        node,
        "persisted SQLite enum-like values must be parsed through closed validators, not cast",
      );
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      imports.syncHelperNames.has(node.expression.text) &&
      node.typeArguments?.length &&
      !hasAllowComment(sourceFile, node, "kysely-allow-raw")
    ) {
      addViolation(
        violations,
        sourceFile,
        node,
        "sync helper row generic at call site; let Kysely infer builder result rows",
      );
    }

    if (
      ts.isTaggedTemplateExpression(node) &&
      node.typeArguments?.length &&
      isIdentifierNamed(node.tag, imports.kyselySqlNames) &&
      !kyselyRawAllowPaths.has(relativePath) &&
      !hasAllowComment(sourceFile, node, "kysely-allow-raw")
    ) {
      addViolation(
        violations,
        sourceFile,
        node,
        "typed raw sql snippet needs a small helper or allowlisted boundary",
      );
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isIdentifierNamed(node.expression.expression, imports.kyselySqlNames) &&
      ["ref", "table", "id", "raw"].includes(getPropertyNameText(node.expression.name) ?? "") &&
      !hasAllowComment(sourceFile, node, "kysely-allow-raw")
    ) {
      addViolation(
        violations,
        sourceFile,
        node,
        "raw Kysely identifier helper requires a closed-set validator and local allow comment",
      );
    }

    if (
      imports.hasKyselyContext &&
      ts.isPropertyAccessExpression(node) &&
      getPropertyNameText(node.name) === "dynamic" &&
      !hasAllowComment(sourceFile, node, "kysely-allow-raw")
    ) {
      addViolation(
        violations,
        sourceFile,
        node,
        "Kysely dynamic refs bypass literal reference checking; use only behind closed unions",
      );
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isIdentifierNamed(node.expression.expression, imports.compiledQueryNames) &&
      getPropertyNameText(node.expression.name) === "raw" &&
      !compiledRawAllowPaths.has(relativePath) &&
      !hasAllowComment(sourceFile, node, "kysely-allow-raw")
    ) {
      addViolation(
        violations,
        sourceFile,
        node,
        "CompiledQuery.raw is only allowed in the native SQLite dialect/test boundary",
      );
    }

    if (
      imports.hasSqliteContext &&
      !isTestPath(relativePath) &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["prepare", "exec"].includes(getPropertyNameText(node.expression.name) ?? "") &&
      isLikelySqliteReceiver(node.expression.expression) &&
      !rawSqliteAllowPathReasons.has(relativePath) &&
      !hasAllowComment(sourceFile, node, "sqlite-allow-raw")
    ) {
      addViolation(
        violations,
        sourceFile,
        node,
        "new raw node:sqlite access requires Kysely or an explicit raw SQLite allowlist entry",
      );
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

export async function collectKyselyGuardrails() {
  const files = await collectTypeScriptFilesFromRoots(sourceRoots, { includeTests: true });
  const violations = [];
  for (const filePath of files) {
    const relativePath = path.relative(repoRoot, filePath).split(path.sep).join("/");
    const content = await fs.readFile(filePath, "utf8");
    for (const violation of collectKyselyGuardrailViolations(content, relativePath)) {
      violations.push({ path: relativePath, ...violation });
    }
  }
  return violations;
}

export async function main() {
  const violations = await collectKyselyGuardrails();
  if (violations.length === 0) {
    console.log("Kysely guardrails OK");
    return;
  }
  console.error("Kysely guardrail violations:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line}: ${violation.message}`);
  }
  process.exit(1);
}

runAsScript(import.meta.url, main);
