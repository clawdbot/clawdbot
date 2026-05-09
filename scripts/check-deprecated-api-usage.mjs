#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { collectDeprecatedInternalConfigApiViolations } from "./lib/deprecated-config-api-guard.mjs";

const repoRoot = process.cwd();

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".mts"]);
const skippedSegments = new Set(["node_modules", "dist", "build", "coverage", ".turbo"]);
const skippedFilePatterns = [
  /\.test\.[cm]?[jt]sx?$/u,
  /\.spec\.[cm]?[jt]sx?$/u,
  /\.e2e\.[cm]?[jt]sx?$/u,
  /\.d\.ts$/u,
];

function toRepoPath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function shouldSkipFile(filePath, rule) {
  const repoPath = toRepoPath(filePath);
  return (rule.skippedFilePatterns ?? skippedFilePatterns).some((pattern) =>
    pattern.test(repoPath),
  );
}

function* walk(dir, rule) {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skippedSegments.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath, rule);
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name))) {
      continue;
    }
    if (!shouldSkipFile(entryPath, rule)) {
      yield entryPath;
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function collectIdentifierRuleViolations(rule) {
  const allowedFiles = new Set(rule.allowedFiles ?? []);
  const pattern = new RegExp(
    `\\b(?:${rule.names.map((name) => escapeRegExp(name)).join("|")})\\b`,
    "gu",
  );
  const violations = [];

  for (const root of rule.roots) {
    for (const filePath of walk(path.join(repoRoot, root), rule)) {
      const repoPath = toRepoPath(filePath);
      if (allowedFiles.has(repoPath)) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`${repoPath}:${line}: ${match[0]} (${rule.message})`);
      }
    }
  }

  return violations;
}

function collectModuleSpecifierRuleViolations(rule) {
  const allowedFiles = new Set(rule.allowedFiles ?? []);
  const specifierPattern = rule.moduleSpecifiers
    .map((specifier) => escapeRegExp(specifier))
    .join("|");
  const patterns = [
    new RegExp(
      `\\bimport\\s+(?:type\\s+)?(?:[^"']+?\\s+from\\s+)?["'](${specifierPattern})["']`,
      "gu",
    ),
    new RegExp(
      `\\bexport\\s+(?:type\\s+)?(?:\\*\\s+from\\s+|[^"']+?\\s+from\\s+)["'](${specifierPattern})["']`,
      "gu",
    ),
    new RegExp(`\\bimport\\(\\s*["'](${specifierPattern})["']\\s*\\)`, "gu"),
  ];
  const violations = [];

  for (const root of rule.roots) {
    for (const filePath of walk(path.join(repoRoot, root), rule)) {
      const repoPath = toRepoPath(filePath);
      if (allowedFiles.has(repoPath)) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index).split("\n").length;
          violations.push(`${repoPath}:${line}: ${match[1]} (${rule.message})`);
        }
      }
    }
  }

  return violations;
}

function collectRuleViolations(rule) {
  if (rule.collect) {
    return rule.collect();
  }
  if (rule.moduleSpecifiers) {
    return collectModuleSpecifierRuleViolations(rule);
  }
  return collectIdentifierRuleViolations(rule);
}

const rules = [
  {
    id: "internal-config-api",
    collect: () => collectDeprecatedInternalConfigApiViolations(),
  },
  {
    id: "plugin-sdk-compat-subpaths",
    roots: ["src", "extensions", "packages"],
    moduleSpecifiers: [
      "openclaw/plugin-sdk/agent-dir-compat",
      "openclaw/plugin-sdk/channel-config-schema-legacy",
      "openclaw/plugin-sdk/channel-reply-pipeline",
      "openclaw/plugin-sdk/channel-runtime",
      "openclaw/plugin-sdk/compat",
      "openclaw/plugin-sdk/discord",
      "openclaw/plugin-sdk/infra-runtime",
      "openclaw/plugin-sdk/mattermost",
      "openclaw/plugin-sdk/matrix",
      "openclaw/plugin-sdk/telegram-account",
      "openclaw/plugin-sdk/testing",
      "openclaw/plugin-sdk/test-utils",
      "openclaw/plugin-sdk/zalouser",
    ],
    message: "use focused non-deprecated plugin SDK subpaths",
  },
  {
    id: "message-api",
    roots: ["src", "extensions", "packages"],
    names: [
      "deliverOutboundPayloads",
      "dispatchChannelMessageReplyWithBase",
      "recordChannelMessageReplyDispatch",
      "buildChannelMessageReplyDispatchBase",
      "hasFinalChannelMessageReplyDispatch",
      "hasVisibleChannelMessageReplyDispatch",
      "resolveChannelMessageReplyDispatchCounts",
      "createChannelTurnReplyPipeline",
      "deliverDurableInboundReplyPayload",
    ],
    allowedFiles: [
      "src/channels/turn/durable-delivery.ts",
      "src/channels/turn/kernel.ts",
      "src/infra/outbound/deliver-runtime.ts",
      "src/infra/outbound/deliver.ts",
      "src/plugin-sdk/channel-message-runtime.ts",
      "src/plugin-sdk/channel-message.ts",
      "src/plugin-sdk/channel-test-helpers.ts",
      "src/plugin-sdk/inbound-reply-dispatch.ts",
      "src/plugin-sdk/outbound-runtime.ts",
      "src/plugin-sdk/test-helpers/outbound-delivery.ts",
      "src/plugin-sdk/testing.ts",
    ],
    message: "use sendDurableMessageBatch or deliverInboundReplyWithMessageSendContext",
  },
];

const selectedRuleIds = new Set(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--rule="))
    .map((arg) => arg.slice("--rule=".length)),
);

const selectedRules =
  selectedRuleIds.size === 0 ? rules : rules.filter((rule) => selectedRuleIds.has(rule.id));
const unknownRuleIds = [...selectedRuleIds].filter((id) => !rules.some((rule) => rule.id === id));

if (unknownRuleIds.length > 0) {
  console.error(`Unknown deprecated API usage rule(s): ${unknownRuleIds.join(", ")}`);
  process.exit(1);
}

const violations = selectedRules.flatMap((rule) =>
  collectRuleViolations(rule).map((violation) => `${rule.id}: ${violation}`),
);

if (violations.length > 0) {
  console.error("Deprecated API usage guard failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("deprecated API usage guard passed");
