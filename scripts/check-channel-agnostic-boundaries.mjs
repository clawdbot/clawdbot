#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  collectTypeScriptFiles,
  getPropertyNameText,
  resolveRepoRoot,
  runAsScript,
  toLine,
} from "./lib/ts-guard-utils.mjs";

const repoRoot = resolveRepoRoot(import.meta.url);

const acpCoreProtectedSources = [
  path.join(repoRoot, "src", "acp"),
  path.join(repoRoot, "src", "agents", "acp-spawn.ts"),
  path.join(repoRoot, "src", "auto-reply", "reply", "commands-acp"),
  path.join(repoRoot, "src", "infra", "outbound", "conversation-id.ts"),
];

const channelCoreProtectedSources = [
  path.join(repoRoot, "src", "channels", "thread-bindings-policy.ts"),
  path.join(repoRoot, "src", "channels", "thread-bindings-messages.ts"),
  path.join(repoRoot, "src", "sessions", "send-policy.ts"),
  path.join(repoRoot, "src", "sessions", "session-chat-type-shared.ts"),
  path.join(repoRoot, "src", "utils", "delivery-context.ts"),
];
const acpUserFacingTextSources = [
  path.join(repoRoot, "src", "auto-reply", "reply", "commands-acp"),
];
const systemMarkLiteralGuardSources = [
  path.join(repoRoot, "src", "auto-reply", "reply", "commands-acp"),
  path.join(repoRoot, "src", "auto-reply", "reply", "dispatch-acp.ts"),
  path.join(repoRoot, "src", "auto-reply", "reply", "directive-handling.shared.ts"),
  path.join(repoRoot, "src", "channels", "thread-bindings-messages.ts"),
];

const channelIds = [
  "discord",
  "googlechat",
  "imessage",
  "irc",
  "line",
  "mattermost",
  "matrix",
  "msteams",
  "nextcloud-talk",
  "nostr",
  "qqbot",
  "signal",
  "slack",
  "synology-chat",
  "telegram",
  "tlon",
  "twitch",
  "web",
  "whatsapp",
  "zalo",
  "zalouser",
];

const channelIdSet = new Set(channelIds);
const channelSegmentRe = new RegExp(`(^|[._/-])(?:${channelIds.join("|")})([._/-]|$)`);
const comparisonOperators = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

const allowedViolations = new Set([]);

function isChannelsPropertyAccess(node) {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === "channels";
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
    return node.argumentExpression.text === "channels";
  }
  return false;
}

function readStringLiteral(node) {
  if (ts.isStringLiteral(node)) {
    return node.text;
  }
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return null;
}

function isChannelLiteralNode(node) {
  const text = readStringLiteral(node);
  return text ? channelIdSet.has(text) : false;
}

function matchesChannelModuleSpecifier(specifier) {
  return channelSegmentRe.test(specifier.replaceAll("\\", "/"));
}

const userFacingChannelNameRe =
  /\b(?:discord|telegram|slack|signal|imessage|whatsapp|google\s*chat|irc|line|zalo|matrix|msteams)\b/i;
const systemMarkLiteral = "⚙️";

function isModuleSpecifierStringNode(node) {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
    return true;
  }
  return (
    ts.isCallExpression(parent) &&
    parent.expression.kind === ts.SyntaxKind.ImportKeyword &&
    parent.arguments[0] === node
  );
}

export function findChannelAgnosticBoundaryViolations(
  content,
  fileName = "source.ts",
  options = {},
) {
  const checkModuleSpecifiers = options.checkModuleSpecifiers ?? true;
  const checkConfigPaths = options.checkConfigPaths ?? true;
  const checkChannelComparisons = options.checkChannelComparisons ?? true;
  const checkChannelAssignments = options.checkChannelAssignments ?? true;
  const moduleSpecifierMatcher = options.moduleSpecifierMatcher ?? matchesChannelModuleSpecifier;

  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = [];

  const visit = (node) => {
    if (
      checkModuleSpecifiers &&
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (moduleSpecifierMatcher(specifier)) {
        violations.push({
          line: toLine(sourceFile, node.moduleSpecifier),
          reason: `imports channel module "${specifier}"`,
        });
      }
    }

    if (
      checkModuleSpecifiers &&
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (moduleSpecifierMatcher(specifier)) {
        violations.push({
          line: toLine(sourceFile, node.moduleSpecifier),
          reason: `re-exports channel module "${specifier}"`,
        });
      }
    }

    if (
      checkModuleSpecifiers &&
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const specifier = node.arguments[0].text;
      if (moduleSpecifierMatcher(specifier)) {
        violations.push({
          line: toLine(sourceFile, node.arguments[0]),
          reason: `dynamically imports channel module "${specifier}"`,
        });
      }
    }

    if (
      checkConfigPaths &&
      ts.isPropertyAccessExpression(node) &&
      channelIdSet.has(node.name.text)
    ) {
      if (isChannelsPropertyAccess(node.expression)) {
        violations.push({
          line: toLine(sourceFile, node.name),
          reason: `references config path "channels.${node.name.text}"`,
        });
      }
    }

    if (
      checkConfigPaths &&
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      channelIdSet.has(node.argumentExpression.text)
    ) {
      if (isChannelsPropertyAccess(node.expression)) {
        violations.push({
          line: toLine(sourceFile, node.argumentExpression),
          reason: `references config path "channels[${JSON.stringify(node.argumentExpression.text)}]"`,
        });
      }
    }

    if (
      checkChannelComparisons &&
      ts.isBinaryExpression(node) &&
      comparisonOperators.has(node.operatorToken.kind)
    ) {
      if (isChannelLiteralNode(node.left) || isChannelLiteralNode(node.right)) {
        const leftText = node.left.getText(sourceFile);
        const rightText = node.right.getText(sourceFile);
        violations.push({
          line: toLine(sourceFile, node.operatorToken),
          reason: `compares with channel id literal (${leftText} ${node.operatorToken.getText(sourceFile)} ${rightText})`,
        });
      }
    }

    if (checkChannelAssignments && ts.isPropertyAssignment(node)) {
      const propName = getPropertyNameText(node.name);
      if (propName === "channel" && isChannelLiteralNode(node.initializer)) {
        violations.push({
          line: toLine(sourceFile, node.initializer),
          reason: `assigns channel id literal to "channel" (${node.initializer.getText(sourceFile)})`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function findChannelCoreReverseDependencyViolations(content, fileName = "source.ts") {
  return findChannelAgnosticBoundaryViolations(content, fileName, {
    checkModuleSpecifiers: true,
    checkConfigPaths: false,
    checkChannelComparisons: false,
    checkChannelAssignments: false,
    moduleSpecifierMatcher: matchesChannelModuleSpecifier,
  });
}

export function findAcpUserFacingChannelNameViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = [];

  const visit = (node) => {
    const text = readStringLiteral(node);
    if (text && userFacingChannelNameRe.test(text) && !isModuleSpecifierStringNode(node)) {
      violations.push({
        line: toLine(sourceFile, node),
        reason: `user-facing text references channel name (${JSON.stringify(text)})`,
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

export function findSystemMarkLiteralViolations(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const violations = [];

  const visit = (node) => {
    const text = readStringLiteral(node);
    if (text && text.includes(systemMarkLiteral) && !isModuleSpecifierStringNode(node)) {
      violations.push({
        line: toLine(sourceFile, node),
        reason: `hardcoded system mark literal (${JSON.stringify(text)})`,
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

const boundaryRuleSets = [
  {
    id: "acp-core",
    sources: acpCoreProtectedSources,
    scan: (content, fileName) => findChannelAgnosticBoundaryViolations(content, fileName),
  },
  {
    id: "channel-core-reverse-deps",
    sources: channelCoreProtectedSources,
    scan: (content, fileName) => findChannelCoreReverseDependencyViolations(content, fileName),
  },
  {
    id: "acp-user-facing-text",
    sources: acpUserFacingTextSources,
    scan: (content, fileName) => findAcpUserFacingChannelNameViolations(content, fileName),
  },
  {
    id: "system-mark-literal-usage",
    sources: systemMarkLiteralGuardSources,
    scan: (content, fileName) => findSystemMarkLiteralViolations(content, fileName),
  },
];

export async function main() {
  const violations = [];
  for (const ruleSet of boundaryRuleSets) {
    const files = (
      await Promise.all(
        ruleSet.sources.map(
          async (sourcePath) =>
            await collectTypeScriptFiles(sourcePath, {
              ignoreMissing: true,
            }),
        ),
      )
    ).flat();
    for (const filePath of files) {
      const relativeFile = path.relative(repoRoot, filePath);
      if (
        allowedViolations.has(`${ruleSet.id}:${relativeFile}`) ||
        allowedViolations.has(relativeFile)
      ) {
        continue;
      }
      const content = await fs.readFile(filePath, "utf8");
      for (const violation of ruleSet.scan(content, relativeFile)) {
        violations.push(`${ruleSet.id} ${relativeFile}:${violation.line}: ${violation.reason}`);
      }
    }
  }

  if (violations.length === 0) {
    return;
  }

  console.error("Found channel-specific references in channel-agnostic sources:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error(
    "Move channel-specific logic to channel adapters or add a justified allowlist entry.",
  );
  process.exit(1);
}

runAsScript(import.meta.url, main);
