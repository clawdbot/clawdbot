#!/usr/bin/env node

import fs from "node:fs/promises";
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

const legacyReaderNames = new Set([
  "loadSessionStore",
  "readSessionEntries",
  "readSessionEntry",
  "readSessionStoreReadOnly",
  "readSessionStoreSnapshot",
  "resolveSessionStoreEntry",
]);
const legacyWholeStoreAccessNames = new Set([
  ...legacyReaderNames,
  "saveSessionStore",
  "updateSessionStore",
]);
const legacyWriterNames = new Set([
  "applySessionStoreEntryPatch",
  "recordSessionMetaFromInbound",
  "saveSessionStore",
  "updateLastRoute",
  "updateSessionStore",
  "updateSessionStoreEntry",
]);
const legacyTranscriptWriterNames = new Set([
  "appendSessionTranscriptMessage",
  "emitSessionTranscriptUpdate",
]);
const sessionCreateLifecycleWriterNames = new Set([
  "applySessionStoreEntryPatch",
  "saveSessionStore",
  "updateSessionStore",
  "updateSessionStoreEntry",
  "ensureSessionTranscriptFile",
]);
const legacyManualCompactTrimNames = new Set([
  "archiveFileOnDisk",
  "readRecentSessionTranscriptLines",
]);
const legacyLifecycleCleanupNames = new Set([
  "archiveRemovedSessionTranscripts",
  "cleanupArchivedSessionTranscripts",
]);
const sessionStoreRuntimeFileBackedCompatNames = new Set([
  "loadSessionStore",
  "readSessionEntries",
  "readSessionEntry",
  "readLatestAssistantTextFromSessionTranscript",
  "readSessionStoreReadOnly",
  "resolveAndPersistSessionFile",
  "resolveSessionFilePath",
  "resolveSessionStoreEntry",
  "saveSessionStore",
  "updateSessionStore",
]);
const embeddedAgentSessionFileRuntimeNames = new Set(["resolveSessionFilePath"]);
const materializingSessionEntryAccessorNames = new Set(["listSessionEntries", "loadSessionEntry"]);

// Shipped beta.5 official plugins import these deprecated helpers during
// doctor migrations. Remove this ratchet with the compatibility bridge once
// beta.5 is outside the supported upgrade window; do not add runtime callers.
export const allowedSessionStoreRuntimeFileBackedCompatExports = new Set([
  "loadSessionStore",
  "resolveSessionFilePath",
  "resolveSessionStoreEntry",
  "updateSessionStore",
]);

const gatewaySessionServerMethodFiles = [
  "src/gateway/server-methods/sessions-abort.ts",
  "src/gateway/server-methods/sessions-compact.ts",
  "src/gateway/server-methods/sessions-compaction-checkpoints.ts",
  "src/gateway/server-methods/sessions-compaction-queries.ts",
  "src/gateway/server-methods/sessions-compaction-runner.ts",
  "src/gateway/server-methods/sessions-create.ts",
  "src/gateway/server-methods/sessions-delete.ts",
  "src/gateway/server-methods/sessions-dispatch.ts",
  "src/gateway/server-methods/sessions-groups.ts",
  "src/gateway/server-methods/sessions-messaging.ts",
  "src/gateway/server-methods/sessions-mutations.ts",
  "src/gateway/server-methods/sessions-read.ts",
  "src/gateway/server-methods/sessions-shared.ts",
  "src/gateway/server-methods/sessions-subscriptions.ts",
  "src/gateway/server-methods/sessions.ts",
];

export const migratedSessionAccessorFiles = new Set([
  "packages/memory-host-sdk/src/host/session-files.ts",
  "src/acp/control-plane/manager.background-task.ts",
  "src/acp/control-plane/manager.core.ts",
  "src/acp/runtime/session-meta.ts",
  "src/agents/acp-spawn.ts",
  "src/agents/auth-profiles/session-override.ts",
  "src/agents/embedded-agent-runner/compaction-successor-transcript.ts",
  "src/agents/embedded-agent-runner/run/attempt.ts",
  "src/agents/embedded-agent-runner/tool-result-truncation.ts",
  "src/agents/embedded-agent-runner/transcript-rewrite.ts",
  "src/agents/embedded-agent-runner/transcript-runtime-state.ts",
  "src/agents/live-model-switch.ts",
  "src/agents/subagent-control.ts",
  "src/agents/subagent-registry-helpers.ts",
  "src/auto-reply/reply/abort.ts",
  "src/auto-reply/reply/agent-runner-helpers.ts",
  "src/auto-reply/reply/agent-runner.ts",
  "src/auto-reply/reply/commands-subagents/action-info.ts",
  "src/auto-reply/reply/followup-runner.ts",
  "src/auto-reply/reply/queue/drain.ts",
  "src/commands/export-trajectory.ts",
  "src/commands/health.ts",
  "src/commands/sandbox-explain.ts",
  "src/commands/sessions-tail.ts",
  "src/commands/sessions.ts",
  "src/commands/status.agent-local.ts",
  "src/commands/status.summary.ts",
  "src/commands/tasks.ts",
  "src/config/sessions/combined-store-gateway.ts",
  "src/config/sessions/delivery-info.ts",
  "src/config/sessions/goals.ts",
  "src/cron/isolated-agent/delivery-target.ts",
  "src/cron/service/timer.ts",
  "src/gateway/session-compaction-checkpoints.ts",
  "src/gateway/session-history-state.ts",
  "src/gateway/sessions-history-http.ts",
  "src/gateway/session-utils.ts",
  "src/gateway/managed-image-attachments.ts",
  "src/gateway/boot.ts",
  "src/gateway/server-methods/artifacts.ts",
  "src/gateway/server-methods/chat.ts",
  "src/gateway/sessions-resolve.ts",
  "src/gateway/server-methods/sessions-files.ts",
  ...gatewaySessionServerMethodFiles,
  "src/gateway/server-session-events.ts",
  "src/gateway/session-reset-service.ts",
  "src/infra/outbound/message-action-tts.ts",
  "src/agents/tools/embedded-gateway-stub.ts",
  "src/agents/tools/session-status-tool.ts",
  "src/agents/tools/sessions-list-tool.ts",
  "src/plugins/host-hook-state.ts",
  "src/status/status-message.ts",
  "src/tui/embedded-backend.ts",
]);

export const migratedBundledPluginSessionAccessorFiles = new Set([
  "extensions/codex/src/conversation-binding.ts",
  "extensions/discord/src/monitor/native-command-model-picker-ui.ts",
  "extensions/discord/src/monitor/native-command-model-picker-apply.ts",
  "extensions/discord/src/monitor/thread-session-close.ts",
  "extensions/feishu/src/reasoning-preview.ts",
  "extensions/memory-core/src/dreaming-phases.ts",
  "extensions/memory-core/src/dreaming-narrative.ts",
  "extensions/mattermost/src/mattermost/model-picker.ts",
  "extensions/matrix/src/matrix/monitor/handler.ts",
  "extensions/matrix/src/session-route.ts",
  "extensions/qqbot/src/engine/group/activation.ts",
  "extensions/slack/src/monitor/slash.ts",
  "extensions/telegram/src/bot-core.ts",
  "extensions/telegram/src/bot-handlers.runtime.ts",
  "extensions/telegram/src/bot.ts",
  "extensions/telegram/src/bot-message-dispatch.ts",
  "extensions/telegram/src/bot-native-commands.ts",
  "extensions/voice-call/src/response-generator.ts",
  "extensions/whatsapp/src/auto-reply/monitor/group-activation.ts",
]);

export const migratedEmbeddedAgentSessionTargetFiles = new Set([
  "extensions/voice-call/src/response-generator.ts",
]);

export const migratedSessionAccessorWriteFiles = new Set([
  "src/acp/runtime/session-meta.ts",
  "src/agents/auth-profiles/session-override.ts",
  "src/agents/command/attempt-execution.shared.ts",
  "src/agents/command/session-store.ts",
  "src/agents/embedded-agent-runner/run.ts",
  "src/agents/embedded-agent-subscribe.handlers.compaction.runtime.ts",
  "src/agents/embedded-agent-runner/run/attempt.ts",
  "src/agents/live-model-switch.ts",
  "src/agents/main-session-restart-recovery.ts",
  "src/agents/session-suspension.ts",
  "src/auto-reply/reply/abort.ts",
  "src/agents/subagent-control.ts",
  "src/agents/subagent-registry-helpers.ts",
  "src/agents/tools/session-status-tool.ts",
  "src/auto-reply/reply/abort-cutoff.runtime.ts",
  "src/auto-reply/reply/agent-runner-cli-dispatch.ts",
  "src/auto-reply/reply/agent-runner-execution.ts",
  "src/auto-reply/reply/agent-runner-memory.ts",
  "src/auto-reply/reply/agent-runner-session-reset.ts",
  "src/auto-reply/reply/agent-runner.ts",
  "src/auto-reply/reply/body.ts",
  "src/auto-reply/reply/commands-acp/lifecycle.ts",
  "src/auto-reply/reply/commands-reset.ts",
  "src/auto-reply/reply/commands-session-store.ts",
  "src/auto-reply/reply/directive-handling.impl.ts",
  "src/auto-reply/reply/directive-handling.persist.ts",
  "src/auto-reply/reply/dispatch-from-config.runtime.ts",
  "src/auto-reply/reply/followup-runner.ts",
  "src/auto-reply/reply/get-reply.ts",
  "src/auto-reply/reply/model-selection.ts",
  "src/auto-reply/reply/session.ts",
  "src/auto-reply/reply/session-reset-model.ts",
  "src/auto-reply/reply/session-updates.ts",
  "src/auto-reply/reply/session-usage.ts",
  "src/commands/tasks.ts",
  "src/config/sessions/cleanup-service.ts",
  "src/config/sessions/goals.ts",
  "src/gateway/boot.ts",
  "src/gateway/server-methods/chat.ts",
  ...gatewaySessionServerMethodFiles,
  "src/gateway/server-node-events.ts",
  "src/gateway/session-compaction-checkpoints.ts",
  "src/infra/outbound/outbound-session.ts",
  "src/plugins/host-hook-cleanup.ts",
  "src/plugins/host-hook-state.ts",
  "src/plugins/runtime/runtime-channel.ts",
  "src/tui/embedded-backend.ts",
]);

export const migratedTranscriptWriterFiles = new Set([
  "src/agents/command/attempt-execution.ts",
  "src/agents/embedded-agent-runner/context-engine-maintenance.ts",
  "src/auto-reply/reply/session-fork.runtime.ts",
  "src/config/sessions/transcript.ts",
  "src/gateway/server-methods/chat.ts",
  "src/gateway/server-methods/chat-transcript-inject.ts",
  "src/sessions/user-turn-transcript.ts",
]);

export const migratedSessionCompactManualTrimFiles = new Set([
  "src/gateway/server-methods/sessions-compact.ts",
]);

export const migratedSessionLifecycleCleanupFiles = new Set([
  "src/config/sessions/cleanup-service.ts",
  "src/cron/session-reaper.ts",
  "src/infra/heartbeat-runner.ts",
]);

export const readOnlyGatewaySessionAccessorFiles = new Set([
  "src/gateway/approval-session-audience.ts",
  "src/gateway/control-ui-session-prs.ts",
  "src/gateway/managed-image-attachments.ts",
  "src/gateway/mcp-app-reconstruction.ts",
  "src/gateway/server-chat.ts",
  "src/gateway/server-methods/artifacts.ts",
  "src/gateway/server-methods/chat-history-handler.ts",
  "src/gateway/server-methods/chat-message-get-handler.ts",
  "src/gateway/server-methods/sessions-diff.ts",
  "src/gateway/server-methods/sessions-files.ts",
  "src/gateway/server-methods/sessions-read.ts",
  "src/gateway/server-methods/sessions-subscriptions.ts",
  "src/gateway/server-methods/task-suggestions.ts",
  "src/gateway/server-methods/tools-effective.ts",
  "src/gateway/server-methods/usage.ts",
  "src/gateway/server-session-events.ts",
]);

export const migratedMemoryHostSessionCorpusFiles = new Set([
  "packages/memory-host-sdk/src/host/session-files.ts",
  "packages/memory-host-sdk/src/host/session-transcript-corpus.ts",
]);

const memoryHostSessionCorpusFunctionNames = new Set([
  "listSessionTranscriptCorpusEntriesForAgentSync",
  "listSessionTranscriptCorpusEntriesForAgent",
  "loadDreamingNarrativeTranscriptPathSetForAgent",
  "loadSessionTranscriptClassificationForAgent",
  "listSessionFilesForAgent",
]);

const legacyMemoryHostSessionCorpusNames = new Set([
  "loadSessionTranscriptClassificationForSessionsDir",
  "readSessionTranscriptClassificationStore",
]);

function normalizeRelativePath(filePath) {
  return filePath.replaceAll(path.sep, "/");
}

function legacyNamesForFile(fileName) {
  const normalized = normalizeRelativePath(fileName);
  if (
    fileName === "source.ts" ||
    [...migratedBundledPluginSessionAccessorFiles].some((filePath) => normalized.endsWith(filePath))
  ) {
    return legacyWholeStoreAccessNames;
  }
  return legacyReaderNames;
}

function propertyAccessName(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    return unwrapped.name.text;
  }
  if (ts.isElementAccessExpression(unwrapped) && ts.isStringLiteral(unwrapped.argumentExpression)) {
    return unwrapped.argumentExpression.text;
  }
  return null;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
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

function findNamedBoundaryViolations(content, fileName, legacyNames, subject) {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = [];

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const namedBindings = node.importClause?.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const specifier of namedBindings.elements) {
          const importedName = specifier.propertyName?.text ?? specifier.name.text;
          if (legacyNames.has(importedName)) {
            violations.push({
              line: toLine(sourceFile, specifier),
              reason: `imports ${subject} "${importedName}"`,
            });
          }
        }
      }
    }

    if (ts.isBindingElement(node)) {
      const name = bindingName(node);
      if (name && legacyNames.has(name)) {
        violations.push({
          line: toLine(sourceFile, node),
          reason: `aliases ${subject} "${name}"`,
        });
      }
    }

    if (ts.isPropertyAccessExpression(node) && legacyNames.has(node.name.text)) {
      violations.push({
        line: toLine(sourceFile, node.name),
        reason: `references ${subject} "${node.name.text}"`,
      });
    }

    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      legacyNames.has(node.argumentExpression.text)
    ) {
      violations.push({
        line: toLine(sourceFile, node.argumentExpression),
        reason: `references ${subject} "${node.argumentExpression.text}"`,
      });
    }

    if (ts.isCallExpression(node)) {
      const calleeName = propertyAccessName(node.expression);
      if (
        calleeName &&
        legacyNames.has(calleeName) &&
        ts.isIdentifier(unwrapExpression(node.expression))
      ) {
        violations.push({
          line: toLine(sourceFile, node.expression),
          reason: `calls ${subject} "${calleeName}"`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

function findNamedSessionStoreViolations(content, fileName, legacyNames, legacyKind) {
  return findNamedBoundaryViolations(
    content,
    fileName,
    legacyNames,
    `legacy session store ${legacyKind}`,
  );
}

export function collectSessionStoreRuntimeFileBackedCompatExports(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const exports = new Map();

  const rememberExport = (node, exportedName, sourceName = exportedName) => {
    if (!sessionStoreRuntimeFileBackedCompatNames.has(sourceName)) {
      return;
    }
    exports.set(exportedName, {
      line: toLine(sourceFile, node),
      sourceName,
    });
  };

  for (const statement of sourceFile.statements) {
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (isExported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          rememberExport(declaration.name, declaration.name.text);
        }
      }
      continue;
    }
    if (isExported && ts.isFunctionDeclaration(statement) && statement.name) {
      rememberExport(statement.name, statement.name.text);
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const specifier of statement.exportClause.elements) {
        rememberExport(
          specifier,
          specifier.name.text,
          specifier.propertyName?.text ?? specifier.name.text,
        );
      }
    }
  }

  return exports;
}

export function findSessionStoreRuntimeFileBackedCompatExportViolations(
  content,
  fileName = "source.ts",
) {
  const exports = collectSessionStoreRuntimeFileBackedCompatExports(content, fileName);
  const violations = [];
  for (const [exportedName, exported] of exports) {
    if (
      exportedName !== exported.sourceName ||
      !allowedSessionStoreRuntimeFileBackedCompatExports.has(exportedName)
    ) {
      violations.push({
        line: exported.line,
        reason: `exports unratcheted file-backed SDK session helper "${exported.sourceName}"`,
      });
    }
  }
  return violations;
}

export function findSessionAccessorBoundaryViolations(content, fileName = "source.ts") {
  const legacyNames = legacyNamesForFile(fileName);
  const legacyKind = legacyNames === legacyWholeStoreAccessNames ? "access" : "reader";
  return findNamedSessionStoreViolations(content, fileName, legacyNames, legacyKind);
}

export function findReadOnlySessionAccessorViolations(content, fileName = "source.ts") {
  return findNamedBoundaryViolations(
    content,
    fileName,
    materializingSessionEntryAccessorNames,
    "materializing session entry accessor",
  );
}

export function findEmbeddedAgentSessionTargetViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = findNamedBoundaryViolations(
    content,
    fileName,
    embeddedAgentSessionFileRuntimeNames,
    "legacy embedded-agent session file resolver",
  );

  const recordDeprecatedSessionFile = (name) => {
    violations.push({
      line: toLine(sourceFile, name),
      reason:
        'passes deprecated embedded-agent runtime identity field "sessionFile"; use sessionTarget',
    });
  };

  const visitRunOptions = (options) => {
    for (const property of options.properties) {
      if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === "sessionFile") {
        recordDeprecatedSessionFile(property.name);
      } else if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === "sessionFile"
      ) {
        recordDeprecatedSessionFile(property.name);
      }
    }
  };

  const visit = (node) => {
    if (ts.isCallExpression(node) && propertyAccessName(node.expression) === "runEmbeddedAgent") {
      const options = unwrapExpression(node.arguments[0]);
      if (options && ts.isObjectLiteralExpression(options)) {
        visitRunOptions(options);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function findSessionAccessorWriteBoundaryViolations(content, fileName = "source.ts") {
  return findNamedSessionStoreViolations(content, fileName, legacyWriterNames, "writer");
}

export function findTranscriptWriterBoundaryViolations(content, fileName = "source.ts") {
  return findNamedBoundaryViolations(
    content,
    fileName,
    legacyTranscriptWriterNames,
    "legacy transcript writer",
  );
}

export function findGatewaySessionCreateLifecycleViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = [];

  const visitCreateHandler = (node) => {
    if (ts.isCallExpression(node)) {
      const calleeName = propertyAccessName(node.expression);
      if (calleeName && sessionCreateLifecycleWriterNames.has(calleeName)) {
        violations.push({
          line: toLine(sourceFile, node.expression),
          reason: `calls legacy sessions.create lifecycle writer "${calleeName}"`,
        });
      }
    }
    ts.forEachChild(node, visitCreateHandler);
  };

  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteralLike(node.name) &&
      node.name.text === "sessions.create"
    ) {
      visitCreateHandler(node.initializer);
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function findSessionCompactManualTrimBoundaryViolations(content, fileName = "source.ts") {
  return findNamedSessionStoreViolations(
    content,
    fileName,
    legacyManualCompactTrimNames,
    "manual compact trim",
  );
}

export function findSessionLifecycleCleanupBoundaryViolations(content, fileName = "source.ts") {
  return findNamedSessionStoreViolations(
    content,
    fileName,
    legacyLifecycleCleanupNames,
    "lifecycle cleanup",
  );
}

// Source roots shared by the enforced boundary checks in main() and the debt
// ratchet below; keeping one list prevents the two scans from drifting apart.
const readSourceRootPaths = [
  "packages/memory-host-sdk/src/host",
  "extensions/discord/src/monitor",
  "extensions/memory-core/src",
  "extensions/telegram/src",
  "extensions/voice-call/src",
  "src/acp",
  "src/agents",
  "src/auto-reply",
  "src/commands",
  "src/config/sessions",
  "src/cron",
  "src/gateway",
  "src/infra",
  "src/plugins",
  "src/tui",
];
const writeSourceRootPaths = [
  "src/acp",
  "src/agents",
  "src/auto-reply",
  "src/commands",
  "src/config/sessions",
  "src/gateway",
  "src/infra",
  "src/plugins",
  "src/tui",
];
const transcriptWriterSourceRootPaths = [
  "src/agents/command",
  "src/agents/embedded-agent-runner",
  "src/auto-reply/reply",
  "src/config/sessions",
  "src/gateway/server-methods",
  "src/sessions",
];

function declarationName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (!ts.isVariableStatement(node)) {
    return null;
  }
  const declaration = node.declarationList.declarations[0];
  return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
}

function functionBodyForDeclaration(node) {
  if (ts.isFunctionDeclaration(node)) {
    return node.body ?? null;
  }
  if (!ts.isVariableStatement(node)) {
    return null;
  }
  const declaration = node.declarationList.declarations[0];
  const initializer = declaration?.initializer;
  if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
    return initializer.body;
  }
  return null;
}

function collectTopLevelFunctionBodies(sourceFile) {
  const bodies = new Map();
  for (const statement of sourceFile.statements) {
    const name = declarationName(statement);
    const body = functionBodyForDeclaration(statement);
    if (name && body) {
      bodies.set(name, body);
    }
  }
  return bodies;
}

export function findMemoryHostSessionCorpusBoundaryViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const functionBodies = collectTopLevelFunctionBodies(sourceFile);
  const visitedFunctions = new Set();
  const violationKeys = new Set();
  const violations = [];

  const visitCorpusBody = (node) => {
    if (ts.isCallExpression(node)) {
      const calleeName = propertyAccessName(node.expression);
      if (calleeName && legacyMemoryHostSessionCorpusNames.has(calleeName)) {
        const line = toLine(sourceFile, node.expression);
        const reason = `calls legacy memory-host session corpus helper "${calleeName}"`;
        const key = `${line}:${reason}`;
        if (!violationKeys.has(key)) {
          violationKeys.add(key);
          violations.push({ line, reason });
        }
      }
      if (calleeName && ts.isIdentifier(unwrapExpression(node.expression))) {
        const localBody = functionBodies.get(calleeName);
        if (localBody && !visitedFunctions.has(calleeName)) {
          visitedFunctions.add(calleeName);
          visitCorpusBody(localBody);
        }
      }
    }
    ts.forEachChild(node, visitCorpusBody);
  };

  for (const name of memoryHostSessionCorpusFunctionNames) {
    const body = functionBodies.get(name);
    if (!body || visitedFunctions.has(name)) {
      continue;
    }
    visitedFunctions.add(name);
    visitCorpusBody(body);
  }

  return violations;
}

// Debt ratchet: the boundary checks above only scan files already on the
// migrated lists, so unmigrated files could quietly gain new legacy call
// sites. The checked-in baseline locks each unmigrated file's current legacy
// call-site count per concern; any drift from the baseline fails the guard.
const sessionAccessorDebtBaselineRelativePath = "scripts/lib/session-accessor-debt-baseline.json";
const debtBaselineRegenCommand = "pnpm lint:tmp:session-accessor-boundary:gen";

// Keys sorted alphabetically so the generated baseline JSON stays deterministic.
const sessionAccessorDebtConcerns = [
  {
    key: "embeddedAgentSessionTarget",
    sourceRootPaths: ["extensions/voice-call/src"],
    migratedFiles: migratedEmbeddedAgentSessionTargetFiles,
    findViolations: findEmbeddedAgentSessionTargetViolations,
  },
  {
    key: "memoryHostSessionCorpus",
    sourceRootPaths: ["packages/memory-host-sdk/src/host"],
    migratedFiles: migratedMemoryHostSessionCorpusFiles,
    findViolations: findMemoryHostSessionCorpusBoundaryViolations,
  },
  {
    key: "sessionAccessorRead",
    sourceRootPaths: readSourceRootPaths,
    migratedFiles: new Set([
      ...migratedSessionAccessorFiles,
      ...migratedBundledPluginSessionAccessorFiles,
    ]),
    findViolations: findSessionAccessorBoundaryViolations,
  },
  {
    key: "sessionAccessorWrite",
    sourceRootPaths: writeSourceRootPaths,
    migratedFiles: migratedSessionAccessorWriteFiles,
    findViolations: findSessionAccessorWriteBoundaryViolations,
  },
  {
    key: "sessionCompactManualTrim",
    sourceRootPaths: ["src/gateway/server-methods"],
    migratedFiles: migratedSessionCompactManualTrimFiles,
    findViolations: findSessionCompactManualTrimBoundaryViolations,
  },
  {
    key: "sessionLifecycleCleanup",
    sourceRootPaths: readSourceRootPaths,
    migratedFiles: migratedSessionLifecycleCleanupFiles,
    findViolations: findSessionLifecycleCleanupBoundaryViolations,
  },
  {
    key: "transcriptWriter",
    sourceRootPaths: transcriptWriterSourceRootPaths,
    migratedFiles: migratedTranscriptWriterFiles,
    findViolations: findTranscriptWriterBoundaryViolations,
  },
];

function sortRecordByKey(record) {
  return Object.fromEntries(
    Object.entries(record).toSorted(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

/** Counts legacy call sites per unmigrated file for every debt concern. */
async function collectSessionAccessorDebtCounts(repoRoot) {
  const counts = {};
  for (const concern of sessionAccessorDebtConcerns) {
    const violations = await collectFileViolations({
      repoRoot,
      sourceRoots: resolveSourceRoots(repoRoot, concern.sourceRootPaths),
      // Inverse of the enforcement skip: migrated files are held at zero by the
      // boundary checks, so the ratchet tracks only the unmigrated rest.
      skipFile: (filePath) =>
        concern.migratedFiles.has(normalizeRelativePath(path.relative(repoRoot, filePath))),
      findViolations: concern.findViolations,
    });
    const fileCounts = {};
    for (const violation of violations) {
      const relativePath = normalizeRelativePath(violation.path);
      fileCounts[relativePath] = (fileCounts[relativePath] ?? 0) + 1;
    }
    counts[concern.key] = sortRecordByKey(fileCounts);
  }
  return sortRecordByKey(counts);
}

/** Ratchet compare: counts above baseline are regressions, below are improvements. */
export function compareSessionAccessorDebt(currentCounts, baselineCounts) {
  const regressions = [];
  const improvements = [];
  const concerns = [
    ...new Set([...Object.keys(baselineCounts), ...Object.keys(currentCounts)]),
  ].toSorted();
  for (const concern of concerns) {
    const current = currentCounts[concern] ?? {};
    const baseline = baselineCounts[concern] ?? {};
    const filePaths = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].toSorted();
    for (const filePath of filePaths) {
      const currentCount = current[filePath] ?? 0;
      const baselineCount = baseline[filePath] ?? 0;
      if (currentCount === baselineCount) {
        continue;
      }
      const entry = { concern, path: filePath, currentCount, baselineCount };
      if (currentCount > baselineCount) {
        regressions.push(entry);
      } else {
        improvements.push(entry);
      }
    }
  }
  return { regressions, improvements };
}

// Improvements fail the guard too: passing silently would leave the baseline
// stale, letting a later change reintroduce legacy call sites up to the old
// count without tripping the ratchet.
export function formatSessionAccessorDebtImprovements(improvements) {
  return [
    `Legacy session accessor debt dropped below ${sessionAccessorDebtBaselineRelativePath}:`,
    ...improvements.map(
      (improvement) =>
        `- ${improvement.path} [${improvement.concern}]: ${improvement.currentCount} legacy call site(s), stale baseline allows ${improvement.baselineCount}`,
    ),
    `Run \`${debtBaselineRegenCommand}\` to ratchet the baseline down and commit it.`,
  ];
}

function resolveDebtBaselinePath(repoRoot) {
  return path.join(repoRoot, ...sessionAccessorDebtBaselineRelativePath.split("/"));
}

async function readSessionAccessorDebtBaseline(repoRoot) {
  try {
    return JSON.parse(await fs.readFile(resolveDebtBaselinePath(repoRoot), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeSessionAccessorDebtBaseline(repoRoot) {
  const counts = await collectSessionAccessorDebtCounts(repoRoot);
  await fs.writeFile(resolveDebtBaselinePath(repoRoot), `${JSON.stringify(counts, null, 2)}\n`);
}

export async function main() {
  const repoRoot = resolveRepoRoot(import.meta.url);
  if (process.argv.includes("--update-debt-baseline")) {
    await writeSessionAccessorDebtBaseline(repoRoot);
    console.log(`Wrote ${sessionAccessorDebtBaselineRelativePath}`);
    return;
  }
  const readSourceRoots = resolveSourceRoots(repoRoot, readSourceRootPaths);
  const writeSourceRoots = resolveSourceRoots(repoRoot, writeSourceRootPaths);
  const transcriptWriterSourceRoots = resolveSourceRoots(repoRoot, transcriptWriterSourceRootPaths);
  const readViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: readSourceRoots,
    skipFile: (filePath) => {
      const relativePath = normalizeRelativePath(path.relative(repoRoot, filePath));
      return (
        !migratedSessionAccessorFiles.has(relativePath) &&
        !migratedBundledPluginSessionAccessorFiles.has(relativePath)
      );
    },
    findViolations: findSessionAccessorBoundaryViolations,
  });
  const writeViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: writeSourceRoots,
    skipFile: (filePath) =>
      !migratedSessionAccessorWriteFiles.has(
        normalizeRelativePath(path.relative(repoRoot, filePath)),
      ),
    findViolations: findSessionAccessorWriteBoundaryViolations,
  });
  const transcriptWriterViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: transcriptWriterSourceRoots,
    skipFile: (filePath) =>
      !migratedTranscriptWriterFiles.has(normalizeRelativePath(path.relative(repoRoot, filePath))),
    findViolations: findTranscriptWriterBoundaryViolations,
  });
  const sessionCreateLifecycleViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: resolveSourceRoots(repoRoot, ["src/gateway/server-methods"]),
    skipFile: (filePath) =>
      normalizeRelativePath(path.relative(repoRoot, filePath)) !==
      "src/gateway/server-methods/sessions-create.ts",
    findViolations: findGatewaySessionCreateLifecycleViolations,
  });
  const manualCompactTrimViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: resolveSourceRoots(repoRoot, ["src/gateway/server-methods"]),
    skipFile: (filePath) =>
      !migratedSessionCompactManualTrimFiles.has(
        normalizeRelativePath(path.relative(repoRoot, filePath)),
      ),
    findViolations: findSessionCompactManualTrimBoundaryViolations,
  });
  const lifecycleCleanupViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: readSourceRoots,
    skipFile: (filePath) =>
      !migratedSessionLifecycleCleanupFiles.has(
        normalizeRelativePath(path.relative(repoRoot, filePath)),
      ),
    findViolations: findSessionLifecycleCleanupBoundaryViolations,
  });
  const memoryHostSessionCorpusViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: resolveSourceRoots(repoRoot, ["packages/memory-host-sdk/src/host"]),
    skipFile: (filePath) =>
      !migratedMemoryHostSessionCorpusFiles.has(
        normalizeRelativePath(path.relative(repoRoot, filePath)),
      ),
    findViolations: findMemoryHostSessionCorpusBoundaryViolations,
  });
  const embeddedAgentSessionTargetViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: resolveSourceRoots(repoRoot, ["extensions/voice-call/src"]),
    skipFile: (filePath) =>
      !migratedEmbeddedAgentSessionTargetFiles.has(
        normalizeRelativePath(path.relative(repoRoot, filePath)),
      ),
    findViolations: findEmbeddedAgentSessionTargetViolations,
  });
  const readOnlyGatewaySessionAccessorViolations = await collectFileViolations({
    repoRoot,
    sourceRoots: resolveSourceRoots(repoRoot, ["src/gateway"]),
    skipFile: (filePath) =>
      !readOnlyGatewaySessionAccessorFiles.has(
        normalizeRelativePath(path.relative(repoRoot, filePath)),
      ),
    findViolations: findReadOnlySessionAccessorViolations,
  });
  const sessionStoreRuntimePath = path.join(repoRoot, "src/plugin-sdk/session-store-runtime.ts");
  const sessionStoreRuntimeCompatViolations =
    findSessionStoreRuntimeFileBackedCompatExportViolations(
      await fs.readFile(sessionStoreRuntimePath, "utf8"),
      sessionStoreRuntimePath,
    ).map((violation) =>
      Object.assign({ path: "src/plugin-sdk/session-store-runtime.ts" }, violation),
    );
  const violations = [
    ...readViolations,
    ...writeViolations,
    ...transcriptWriterViolations,
    ...sessionCreateLifecycleViolations,
    ...manualCompactTrimViolations,
    ...lifecycleCleanupViolations,
    ...memoryHostSessionCorpusViolations,
    ...embeddedAgentSessionTargetViolations,
    ...readOnlyGatewaySessionAccessorViolations,
    ...sessionStoreRuntimeCompatViolations,
  ];

  const baselineCounts = await readSessionAccessorDebtBaseline(repoRoot);
  if (!baselineCounts) {
    console.error(
      `Missing ${sessionAccessorDebtBaselineRelativePath}; run \`${debtBaselineRegenCommand}\` and commit it.`,
    );
    process.exit(1);
  }
  const debt = compareSessionAccessorDebt(
    await collectSessionAccessorDebtCounts(repoRoot),
    baselineCounts,
  );

  if (violations.length === 0 && debt.regressions.length === 0 && debt.improvements.length === 0) {
    console.log("session accessor boundary guard passed.");
    return;
  }

  if (violations.length > 0) {
    console.error("Found legacy session store usage in session-accessor migrated files:");
    for (const violation of violations) {
      console.error(`- ${violation.path}:${violation.line}: ${violation.reason}`);
    }
    console.error(
      "Use src/config/sessions/session-accessor.ts helpers for migrated read/write and transcript-writer paths. Expand file-backed SDK compatibility only as an explicit pre-SQLite migration decision.",
    );
  }
  if (debt.regressions.length > 0) {
    console.error(
      `Found new legacy session call sites in unmigrated files (counts exceed ${sessionAccessorDebtBaselineRelativePath}):`,
    );
    for (const regression of debt.regressions) {
      console.error(
        `- ${regression.path} [${regression.concern}]: ${regression.currentCount} legacy call site(s), baseline allows ${regression.baselineCount}`,
      );
    }
    console.error(
      `Use src/config/sessions/session-accessor.ts helpers instead of adding legacy call sites. If the increase is an intentional seam-owner change, run \`${debtBaselineRegenCommand}\` and commit the updated baseline.`,
    );
  }
  if (debt.improvements.length > 0) {
    for (const line of formatSessionAccessorDebtImprovements(debt.improvements)) {
      console.error(line);
    }
  }
  process.exit(1);
}

runAsScript(import.meta.url, main);
