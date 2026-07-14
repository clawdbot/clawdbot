#!/usr/bin/env node

import path from "node:path";
import ts from "typescript";
import {
  collectFileViolations,
  resolveRepoRoot,
  resolveSourceRoots,
  runAsScript,
  toLine,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const legacyTranscriptReaderModules = new Set([
  "../gateway/session-utils.js",
  "../gateway/session-utils.fs.js",
  "../../gateway/session-utils.js",
  "../../gateway/session-utils.fs.js",
  "./session-utils.js",
  "./session-utils.fs.js",
  "../session-utils.js",
  "../session-utils.fs.js",
]);

const transcriptReaderNames = new Set([
  "attachOpenClawTranscriptMeta",
  "capArrayByJsonBytes",
  "readFirstUserMessageFromTranscript",
  "readLatestRecentSessionUsageFromTranscriptAsync",
  "readLatestSessionUsageFromTranscript",
  "readLatestSessionUsageFromTranscriptAsync",
  "readRecentSessionMessages",
  "readRecentSessionMessagesAsync",
  "readRecentSessionMessagesWithStats",
  "readRecentSessionMessagesWithStatsAsync",
  "readRecentSessionTranscriptLines",
  "readRecentSessionUsageFromTranscript",
  "readRecentSessionUsageFromTranscriptAsync",
  "readSessionMessageByIdAsync",
  "readSessionMessageCount",
  "readSessionMessageCountAsync",
  "readSessionMessages",
  "readSessionMessagesAsync",
  "readSessionMessagesWithSourceAsync",
  "readSessionPreviewItemsFromTranscript",
  "readSessionTitleFieldsFromTranscript",
  "readSessionTitleFieldsFromTranscriptAsync",
  "visitSessionMessages",
  "visitSessionMessagesAsync",
]);

const storageSpecificTranscriptReaderAliasNames = new Set(["readSessionMessagesFromFileAsync"]);

export const migratedSessionTranscriptReaderFiles = new Set([
  "src/agents/main-session-restart-recovery.ts",
  "src/agents/subagent-announce-output.test.ts",
  "src/agents/subagent-announce-output.ts",
  "src/agents/subagent-announce.runtime.ts",
  "src/agents/subagent-orphan-recovery.test.ts",
  "src/agents/subagent-orphan-recovery.ts",
  "src/agents/tools/embedded-gateway-stub.runtime.ts",
  "src/agents/tools/embedded-gateway-stub.test.ts",
  "src/agents/tools/embedded-gateway-stub.ts",
  "src/agents/tools/sessions-history-tool.ts",
  "src/agents/tools/sessions-list-tool.ts",
  "src/gateway/cli-session-history.claude.ts",
  "src/gateway/gateway-models.profiles.live.test.ts",
  "src/gateway/managed-image-attachments.test.ts",
  "src/gateway/managed-image-attachments.ts",
  "src/gateway/mcp-app-reconstruction.ts",
  "src/gateway/server-methods/artifacts.test.ts",
  "src/gateway/server-methods/artifacts.ts",
  "src/gateway/server-methods/chat.ts",
  "src/gateway/server-methods/sessions-files.test.ts",
  "src/gateway/server-methods/sessions-files.ts",
  "src/gateway/server-methods/sessions.ts",
  "src/gateway/server-session-events.ts",
  "src/gateway/session-history-state.test.ts",
  "src/gateway/session-history-state.ts",
  "src/gateway/session-reset-service.ts",
  "src/gateway/session-utils.ts",
  "src/gateway/sessions-history-http.revocation.test.ts",
  "src/gateway/sessions-history-http.ts",
  "src/status/status-message.ts",
  "src/tui/embedded-backend.test.ts",
  "src/tui/embedded-backend.ts",
]);

function normalizeRelativePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function importedModuleName(node) {
  return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null;
}

function bindingName(node) {
  if (node.propertyName && ts.isIdentifier(node.propertyName)) {
    return node.propertyName.text;
  }
  if (ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return null;
}

function destructuresLegacyNamespace(node, legacyNamespaces) {
  const pattern = node.parent;
  const declaration = pattern?.parent;
  if (
    !pattern ||
    !ts.isObjectBindingPattern(pattern) ||
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer
  ) {
    return false;
  }

  const initializer = unwrapExpression(declaration.initializer);
  return ts.isIdentifier(initializer) && legacyNamespaces.has(initializer.text);
}

export function findSessionTranscriptReaderBoundaryViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = [];
  const legacyNamespaces = new Set();

  const visit = (node) => {
    if (ts.isIdentifier(node) && storageSpecificTranscriptReaderAliasNames.has(node.text)) {
      violations.push({
        line: toLine(sourceFile, node),
        reason: `uses storage-specific transcript reader alias "${node.text}"`,
      });
    }

    if (ts.isImportDeclaration(node)) {
      const moduleName = importedModuleName(node);
      const namedBindings = node.importClause?.namedBindings;
      if (moduleName && legacyTranscriptReaderModules.has(moduleName) && namedBindings) {
        if (ts.isNamedImports(namedBindings)) {
          for (const specifier of namedBindings.elements) {
            const importedName = specifier.propertyName?.text ?? specifier.name.text;
            if (transcriptReaderNames.has(importedName)) {
              violations.push({
                line: toLine(sourceFile, specifier),
                reason: `imports transcript reader "${importedName}" from legacy module "${moduleName}"`,
              });
            }
          }
        } else if (ts.isNamespaceImport(namedBindings)) {
          legacyNamespaces.add(namedBindings.name.text);
        }
      }
    }

    if (ts.isExportDeclaration(node)) {
      const moduleName = importedModuleName(node);
      if (moduleName && legacyTranscriptReaderModules.has(moduleName)) {
        const exportClause = node.exportClause;
        if (!exportClause) {
          violations.push({
            line: toLine(sourceFile, node),
            reason: `re-exports transcript readers from legacy module "${moduleName}"`,
          });
        } else if (ts.isNamedExports(exportClause)) {
          for (const specifier of exportClause.elements) {
            const exportedName = specifier.propertyName?.text ?? specifier.name.text;
            if (transcriptReaderNames.has(exportedName)) {
              violations.push({
                line: toLine(sourceFile, specifier),
                reason: `re-exports transcript reader "${exportedName}" from legacy module "${moduleName}"`,
              });
            }
          }
        } else if (ts.isNamespaceExport(exportClause)) {
          violations.push({
            line: toLine(sourceFile, exportClause),
            reason: `re-exports transcript reader namespace from legacy module "${moduleName}"`,
          });
        }
      }
    }

    if (ts.isBindingElement(node)) {
      const name = bindingName(node);
      if (
        name &&
        transcriptReaderNames.has(name) &&
        destructuresLegacyNamespace(node, legacyNamespaces)
      ) {
        violations.push({
          line: toLine(sourceFile, node),
          reason: `aliases legacy transcript reader "${name}"`,
        });
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const receiver = unwrapExpression(node.expression);
      if (
        ts.isIdentifier(receiver) &&
        legacyNamespaces.has(receiver.text) &&
        transcriptReaderNames.has(node.name.text)
      ) {
        violations.push({
          line: toLine(sourceFile, node.name),
          reason: `references legacy transcript reader "${node.name.text}"`,
        });
      }
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(unwrapExpression(node.expression)) &&
      legacyNamespaces.has(unwrapExpression(node.expression).text) &&
      ts.isStringLiteral(node.argumentExpression) &&
      transcriptReaderNames.has(node.argumentExpression.text)
    ) {
      violations.push({
        line: toLine(sourceFile, node.argumentExpression),
        reason: `references legacy transcript reader "${node.argumentExpression.text}"`,
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const sourceRoots = resolveSourceRoots(repoRoot, [
    "src/agents",
    "src/gateway",
    "src/status",
    "src/tui",
  ]);
  const violations = await collectFileViolations({
    repoRoot,
    sourceRoots,
    includeTests: true,
    skipFile: (filePath) =>
      !migratedSessionTranscriptReaderFiles.has(
        normalizeRelativePath(path.relative(repoRoot, filePath)),
      ),
    findViolations: findSessionTranscriptReaderBoundaryViolations,
  });

  if (violations.length === 0) {
    console.log("session transcript reader boundary guard passed.");
    return;
  }

  console.error("Found legacy transcript reader usage in migrated files:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line}: ${violation.reason}`);
  }
  console.error(
    "Use src/gateway/session-transcript-readers.ts for migrated transcript reader paths. Expand this ratchet only after a slice migrates more files.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
