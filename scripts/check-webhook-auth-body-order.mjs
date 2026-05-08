#!/usr/bin/env node

import path from "node:path";
import ts from "typescript";
import { bundledPluginCallsite, bundledPluginFile } from "./lib/bundled-plugin-paths.mjs";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import { runAsScript, toLine, unwrapExpression } from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["extensions"];
const enforcedFiles = new Set([
  bundledPluginFile("feishu", "src/monitor.transport.ts"),
  bundledPluginFile("googlechat", "src/monitor.ts"),
  bundledPluginFile("zalo", "src/monitor.webhook.ts"),
]);
const blockedCallees = new Set(["readJsonBodyWithLimit", "readRequestBodyWithLimit"]);
const allowedCallsites = new Set([
  // Feishu signs the exact wire body, so this handler must read raw bytes before parsing JSON.
  bundledPluginCallsite("feishu", "src/monitor.transport.ts", 199),
]);

function getCalleeName(expression) {
  const callee = unwrapExpression(expression);
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  return null;
}

export function findBlockedWebhookBodyReadLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const lines = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const calleeName = getCalleeName(node.expression);
      if (calleeName && blockedCallees.has(calleeName)) {
        lines.push(toLine(sourceFile, node.expression));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

export async function main() {
  await runCallsiteGuard({
    importMetaUrl: import.meta.url,
    sourceRoots,
    findCallLines: findBlockedWebhookBodyReadLines,
    skipRelativePath: (relPath) => !enforcedFiles.has(relPath.replaceAll(path.sep, "/")),
    allowCallsite: (callsite) => allowedCallsites.has(callsite),
    header: "Found forbidden low-level body reads in auth-sensitive webhook handlers:",
    footer:
      "Use plugin-sdk webhook guards (`readJsonWebhookBodyOrReject` / `readWebhookBodyOrReject`) with explicit pre-auth/post-auth profiles.",
  });
}

runAsScript(import.meta.url, main);
