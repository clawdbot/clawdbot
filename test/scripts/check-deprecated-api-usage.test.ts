// Check Deprecated Api Usage tests cover check deprecated api usage script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BANNED_INTERNAL_PLUGIN_SDK_FACADE_MODULES,
  buildDeprecatedPluginSdkModuleSpecifiers,
} from "../../scripts/lib/deprecated-plugin-sdk-usage.mjs";
import deprecatedPublicPluginSdkSubpaths from "../../scripts/lib/plugin-sdk-deprecated-public-subpaths.json" with { type: "json" };

const GUARD_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/check-deprecated-api-usage.mjs",
);

function runFacadeImportRule(sourceByRepoPath: Record<string, string>) {
  // realpath first: macOS os.tmpdir() is a /var -> /private/var symlink and the
  // script reports repo-relative paths from its resolved cwd.
  const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deprecated-guard-")));
  try {
    for (const [repoPath, source] of Object.entries(sourceByRepoPath)) {
      const filePath = path.join(fixtureRoot, repoPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source);
    }
    return spawnSync(process.execPath, [GUARD_SCRIPT_PATH, "--rule=facade-internal-imports"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe("scripts/check-deprecated-api-usage", () => {
  it("bans every curated deprecated public plugin SDK subpath", () => {
    const specifiers = new Set(buildDeprecatedPluginSdkModuleSpecifiers());

    for (const subpath of deprecatedPublicPluginSdkSubpaths) {
      expect(specifiers.has(`openclaw/plugin-sdk/${subpath}`), subpath).toBe(true);
    }
  });

  it("keeps root and private compatibility aliases explicit", () => {
    expect(buildDeprecatedPluginSdkModuleSpecifiers()).toEqual(
      expect.arrayContaining([
        "openclaw/plugin-sdk",
        "openclaw/plugin-sdk/agent-dir-compat",
        "openclaw/plugin-sdk/test-utils",
      ]),
    );
  });

  it("bans the scoped @openclaw/plugin-sdk spelling of every deprecated specifier", () => {
    const specifiers = new Set(buildDeprecatedPluginSdkModuleSpecifiers());

    for (const specifier of [...specifiers]) {
      if (!specifier.startsWith("@")) {
        expect(specifiers.has(`@${specifier}`), specifier).toBe(true);
      }
    }
  });

  it("bans internal imports of every deprecated reply facade", () => {
    const modulePaths = new Set(
      BANNED_INTERNAL_PLUGIN_SDK_FACADE_MODULES.map((ban) => ban.modulePath),
    );

    for (const facade of [
      "src/plugin-sdk/channel-envelope",
      "src/plugin-sdk/channel-message",
      "src/plugin-sdk/channel-message-runtime",
      "src/plugin-sdk/channel-reply-pipeline",
      "src/plugin-sdk/inbound-reply-dispatch",
      "src/channels/message/inbound-reply-dispatch",
    ]) {
      expect(modulePaths.has(facade), facade).toBe(true);
    }
  });

  it("limits facade import allowlists to the plugin-sdk compat re-export chain", () => {
    for (const ban of BANNED_INTERNAL_PLUGIN_SDK_FACADE_MODULES) {
      for (const importer of ban.allowedImporters ?? []) {
        expect(importer.startsWith("src/plugin-sdk/"), `${ban.modulePath} -> ${importer}`).toBe(
          true,
        );
      }
    }
  });

  it("flags internal facade imports across static, relative, scoped, and dynamic forms", () => {
    const result = runFacadeImportRule({
      "src/channels/probe.ts": [
        'import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";',
        'export { runInboundReplyTurn } from "./message/inbound-reply-dispatch.js";',
        'const facade = await import ("../plugin-sdk/channel-message.js", { with: {} });',
        'import { formatInboundEnvelope } from "@openclaw/plugin-sdk/channel-envelope";',
      ].join("\n"),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "src/channels/probe.ts:1: openclaw/plugin-sdk/channel-reply-pipeline",
    );
    expect(result.stderr).toContain("src/channels/probe.ts:2: ./message/inbound-reply-dispatch.js");
    expect(result.stderr).toContain("src/channels/probe.ts:3: ../plugin-sdk/channel-message.js");
    expect(result.stderr).toContain(
      "src/channels/probe.ts:4: @openclaw/plugin-sdk/channel-envelope",
    );
  });

  it("keeps the compat re-export chain and test files off the facade import rule", () => {
    const result = runFacadeImportRule({
      "src/plugin-sdk/channel-message-runtime.ts": 'export * from "./channel-message.js";',
      "src/plugin-sdk/channel-inbound.ts":
        'export { runChannelInboundEvent } from "../channels/message/inbound-reply-dispatch.js";',
      "src/plugin-sdk/channel-message.test.ts":
        'const mod = await import("openclaw/plugin-sdk/channel-message");',
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
