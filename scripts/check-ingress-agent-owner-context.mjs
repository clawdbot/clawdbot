#!/usr/bin/env node

// Ensures ingress agent command callsites pass explicit owner context.
import path from "node:path";
import ts from "typescript";
import { bundledPluginFile } from "./lib/bundled-plugin-paths.mjs";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import {
  collectCallExpressionLines,
  runAsScript,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src/gateway", bundledPluginFile("discord", "src/voice")];
const enforcedFiles = new Set([
  bundledPluginFile("discord", "src/voice/manager.ts"),
  "src/gateway/openai-http.ts",
  "src/gateway/openresponses-http.ts",
  "src/gateway/server-methods/agent.ts",
  "src/gateway/server-node-events.ts",
]);

/**
 * Finds legacy `agentCommand(...)` call lines in ingress-owned source.
 */
export function findLegacyAgentCommandCallLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  return collectCallExpressionLines(ts, sourceFile, (node) => {
    const callee = unwrapExpression(node.expression);
    return ts.isIdentifier(callee) && callee.text === "agentCommand" ? callee : null;
  });
}

/**
 * Runs the ingress owner-context guard.
 */
export async function main() {
  await runCallsiteGuard({
    importMetaUrl: import.meta.url,
    sourceRoots,
    findCallLines: findLegacyAgentCommandCallLines,
    skipRelativePath: (relPath) => !enforcedFiles.has(relPath.replaceAll(path.sep, "/")),
    header: "Found ingress callsites using local agentCommand() (must be explicit owner-aware):",
    footer:
      "Use agentCommandFromIngress(...) and pass senderIsOwner explicitly at ingress boundaries.",
  });
}

runAsScript(import.meta.url, main);
