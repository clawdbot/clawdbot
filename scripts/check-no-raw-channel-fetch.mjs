#!/usr/bin/env node

import ts from "typescript";
import { bundledPluginCallsite } from "./lib/bundled-plugin-paths.mjs";
import { runCallsiteGuard } from "./lib/callsite-guard.mjs";
import {
  collectCallExpressionLines,
  runAsScript,
  unwrapExpression,
} from "./lib/ts-guard-utils.mjs";

const sourceRoots = ["src/channels", "src/routing", "src/line", "extensions"];

// Temporary allowlist for legacy callsites. New raw fetch callsites in channel/plugin runtime
// code should be rejected and migrated to fetchWithSsrFGuard/shared channel helpers.
const allowedRawFetchCallsites = new Set([
  bundledPluginCallsite("bluebubbles", "src/test-harness.ts", 130),
  bundledPluginCallsite("bluebubbles", "src/types.ts", 189),
  bundledPluginCallsite("browser", "src/browser/cdp.helpers.ts", 268),
  bundledPluginCallsite("browser", "src/browser/client-fetch.ts", 192),
  bundledPluginCallsite("browser", "src/browser/test-fetch.ts", 24),
  bundledPluginCallsite("browser", "src/browser/test-fetch.ts", 27),
  bundledPluginCallsite("chutes", "models.ts", 535),
  bundledPluginCallsite("chutes", "models.ts", 542),
  bundledPluginCallsite("discord", "src/monitor/gateway-plugin.ts", 387),
  bundledPluginCallsite("discord", "src/monitor/gateway-plugin.ts", 453),
  bundledPluginCallsite("discord", "src/voice-message.ts", 298),
  bundledPluginCallsite("discord", "src/voice-message.ts", 333),
  bundledPluginCallsite("elevenlabs", "speech-provider.ts", 295),
  bundledPluginCallsite("elevenlabs", "tts.ts", 116),
  bundledPluginCallsite("feishu", "src/monitor.webhook.test-helpers.ts", 25),
  bundledPluginCallsite("github-copilot", "login.ts", 48),
  bundledPluginCallsite("github-copilot", "login.ts", 80),
  bundledPluginCallsite("googlechat", "src/auth.ts", 83),
  bundledPluginCallsite("huggingface", "models.ts", 142),
  bundledPluginCallsite("kilocode", "provider-models.ts", 130),
  bundledPluginCallsite("matrix", "src/matrix/sdk/transport.ts", 112),
  bundledPluginCallsite("microsoft-foundry", "onboard.ts", 479),
  bundledPluginCallsite("microsoft", "speech-provider.ts", 140),
  bundledPluginCallsite("minimax", "oauth.ts", 66),
  bundledPluginCallsite("minimax", "oauth.ts", 107),
  bundledPluginCallsite("minimax", "tts.ts", 52),
  bundledPluginCallsite("msteams", "src/graph.ts", 47),
  bundledPluginCallsite("msteams", "src/sdk.ts", 400),
  bundledPluginCallsite("msteams", "src/sdk.ts", 441),
  bundledPluginCallsite("ollama", "src/stream.ts", 649),
  bundledPluginCallsite("openai", "tts.ts", 149),
  bundledPluginCallsite("qa-channel", "src/bus-client.ts", 41),
  bundledPluginCallsite("qa-channel", "src/bus-client.ts", 221),
  bundledPluginCallsite("qa-lab", "src/docker-up.runtime.ts", 274),
  bundledPluginCallsite("qa-lab", "src/gateway-child.ts", 489),
  bundledPluginCallsite("qa-lab", "src/suite.ts", 330),
  bundledPluginCallsite("qa-lab", "src/suite.ts", 341),
  bundledPluginCallsite("qa-lab", "web/src/app.ts", 21),
  bundledPluginCallsite("qa-lab", "web/src/app.ts", 29),
  bundledPluginCallsite("qa-lab", "web/src/app.ts", 37),
  bundledPluginCallsite("qqbot", "src/api.ts", 102),
  bundledPluginCallsite("qqbot", "src/api.ts", 237),
  bundledPluginCallsite("qqbot", "src/stt.ts", 81),
  bundledPluginCallsite("qqbot", "src/tools/channel.ts", 180),
  bundledPluginCallsite("qqbot", "src/utils/audio-convert.ts", 377),
  bundledPluginCallsite("signal", "src/install-signal-cli.ts", 224),
  bundledPluginCallsite("slack", "src/monitor/media.ts", 99),
  bundledPluginCallsite("slack", "src/monitor/media.ts", 118),
  bundledPluginCallsite("slack", "src/monitor/media.ts", 123),
  bundledPluginCallsite("tlon", "src/tlon-api.ts", 185),
  bundledPluginCallsite("tlon", "src/tlon-api.ts", 235),
  bundledPluginCallsite("tlon", "src/tlon-api.ts", 289),
  bundledPluginCallsite("venice", "models.ts", 552),
  bundledPluginCallsite("vercel-ai-gateway", "models.ts", 181),
  bundledPluginCallsite("voice-call", "src/providers/twilio/api.ts", 23),
]);

function isRawFetchCall(expression) {
  const callee = unwrapExpression(expression);
  if (ts.isIdentifier(callee)) {
    return callee.text === "fetch";
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return (
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "globalThis" &&
      callee.name.text === "fetch"
    );
  }
  return false;
}

export function findRawFetchCallLines(content, fileName = "source.ts") {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  return collectCallExpressionLines(ts, sourceFile, (node) =>
    isRawFetchCall(node.expression) ? node.expression : null,
  );
}

export async function main() {
  await runCallsiteGuard({
    importMetaUrl: import.meta.url,
    sourceRoots,
    extraTestSuffixes: [".browser.test.ts", ".node.test.ts"],
    findCallLines: findRawFetchCallLines,
    allowCallsite: (callsite) => allowedRawFetchCallsites.has(callsite),
    header: "Found raw fetch() usage in channel/plugin runtime sources outside allowlist:",
    footer: "Use fetchWithSsrFGuard() or existing channel/plugin SDK wrappers for network calls.",
  });
}

runAsScript(import.meta.url, main);
