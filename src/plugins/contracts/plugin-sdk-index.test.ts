import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import { buildPluginSdkPackageExports } from "../../plugin-sdk/entrypoints.js";
import type { ClawdbotConfig, OpenClawConfig, OpenClawSchemaType } from "../../plugin-sdk/index.js";

const pluginSdkIndexPath = fileURLToPath(new URL("../../plugin-sdk/index.ts", import.meta.url));

async function collectRuntimeExports(filePath: string, seen = new Set<string>()) {
  const normalizedPath = path.resolve(filePath);
  if (seen.has(normalizedPath)) {
    return new Set<string>();
  }
  seen.add(normalizedPath);

  const source = await fs.readFile(normalizedPath, "utf8");
  const exportNames = new Set<string>();

  for (const match of source.matchAll(/export\s+(?!type\b)\{([\s\S]*?)\}\s+from\s+"([^"]+)";/g)) {
    for (const part of match[1].split(",")) {
      const trimmed = part.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const name = trimmed.split(/\s+as\s+/).at(-1) ?? trimmed;
      exportNames.add(name);
    }
  }

  for (const match of source.matchAll(/export\s+\*\s+from\s+"([^"]+)";/g)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) {
      continue;
    }
    const nestedPath = path.resolve(
      path.dirname(normalizedPath),
      specifier.replace(/\.js$/, ".ts"),
    );
    const nestedExports = await collectRuntimeExports(nestedPath, seen);
    for (const name of nestedExports) {
      exportNames.add(name);
    }
  }

  return exportNames;
}

async function readIndexRuntimeExports() {
  return await collectRuntimeExports(pluginSdkIndexPath);
}

describe("plugin-sdk exports", () => {
  it("does not expose runtime modules", async () => {
    const runtimeExports = await readIndexRuntimeExports();
    const forbidden = [
      "chunkMarkdownText",
      "chunkText",
      "hasControlCommand",
      "isControlCommandMessage",
      "shouldComputeCommandAuthorized",
      "shouldHandleTextCommands",
      "buildMentionRegexes",
      "matchesMentionPatterns",
      "resolveStateDir",
      "writeConfigFile",
      "enqueueSystemEvent",
      "readRemoteMediaBuffer",
      "saveMediaBuffer",
      "formatAgentEnvelope",
      "buildPairingReply",
      "resolveAgentRoute",
      "dispatchReplyFromConfig",
      "createReplyDispatcherWithTyping",
      "dispatchReplyWithBufferedBlockDispatcher",
      "resolveCommandAuthorizedFromAuthorizers",
      "monitorSlackProvider",
      "monitorTelegramProvider",
      "monitorIMessageProvider",
      "monitorSignalProvider",
      "sendMessageSlack",
      "sendMessageTelegram",
      "sendMessageIMessage",
      "sendMessageSignal",
      "sendMessageWhatsApp",
      "probeSlack",
      "probeTelegram",
      "probeIMessage",
      "probeSignal",
    ];

    for (const key of forbidden) {
      expect(runtimeExports.has(key)).toBe(false);
    }
  });

  it("keeps the root runtime surface intentionally small", async () => {
    const runtimeExports = await readIndexRuntimeExports();
    expect([...runtimeExports].toSorted()).toEqual([
      "buildMemorySystemPromptAddition",
      "delegateCompactionToRuntime",
      "emptyPluginConfigSchema",
      "onDiagnosticEvent",
      "optionalStringEnum",
      "registerContextEngine",
      "stringEnum",
    ]);
  });

  it("keeps deprecated root config type aliases aligned", () => {
    expectTypeOf<ClawdbotConfig>().toEqualTypeOf<OpenClawConfig>();
    expectTypeOf<OpenClawSchemaType>().toEqualTypeOf<OpenClawConfig>();
  });

  it("keeps package.json plugin-sdk exports synced with the manifest", async () => {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      exports?: Record<string, unknown>;
    };
    const currentPluginSdkExports = Object.fromEntries(
      Object.entries(packageJson.exports ?? {}).filter(([key]) => key.startsWith("./plugin-sdk")),
    );

    expect(currentPluginSdkExports).toEqual(buildPluginSdkPackageExports());
  });
});
