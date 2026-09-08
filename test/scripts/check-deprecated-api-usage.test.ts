// Check Deprecated Api Usage tests cover check deprecated api usage script behavior.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BANNED_INTERNAL_PLUGIN_SDK_FACADE_MODULES,
  buildDeprecatedPluginSdkModuleSpecifiers,
} from "../../scripts/lib/deprecated-plugin-sdk-usage.mts";
import deprecatedPublicPluginSdkSubpaths from "../../scripts/lib/plugin-sdk-deprecated-public-subpaths.json" with { type: "json" };

const GUARD_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/check-deprecated-api-usage.mts",
);

function runRules(sourceByRepoPath: Record<string, string>, ruleIds = ["facade-internal-imports"]) {
  // realpath first: macOS os.tmpdir() is a /var -> /private/var symlink and the
  // script reports repo-relative paths from its resolved cwd.
  const fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deprecated-guard-")));
  try {
    for (const [repoPath, source] of Object.entries(sourceByRepoPath)) {
      const filePath = path.join(fixtureRoot, repoPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, source);
    }
    const accountingPath = path.join(fixtureRoot, "account-source-io.mjs");
    fs.writeFileSync(
      accountingPath,
      `import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const counts = { files: {}, directories: {} };
const root = process.cwd();
function count(kind, file) {
  if (typeof file !== "string") return;
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (!/^(src|extensions|packages)(\\/|$)/.test(relative)) return;
  counts[kind][relative] = (counts[kind][relative] ?? 0) + 1;
}
for (const [method, kind] of [["readFileSync", "files"], ["readdirSync", "directories"]]) {
  const original = fs[method];
  fs[method] = function (file, ...args) {
    const result = original.call(this, file, ...args);
    count(kind, file);
    return result;
  };
}
syncBuiltinESMExports();
process.on("exit", () => fs.writeFileSync("source-io.json", JSON.stringify(counts)));
`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(accountingPath).href,
        GUARD_SCRIPT_PATH,
        ...ruleIds.map((id) => `--rule=${id}`),
      ],
      { cwd: fixtureRoot, encoding: "utf8" },
    );
    const io: { files: Record<string, number>; directories: Record<string, number> } = JSON.parse(
      fs.readFileSync(path.join(fixtureRoot, "source-io.json"), "utf8"),
    );
    return { ...result, io };
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

  it("keeps removed root and private compatibility aliases out of the inventory", () => {
    const specifiers = buildDeprecatedPluginSdkModuleSpecifiers();
    for (const removedSpecifier of [
      "openclaw/plugin-sdk",
      "openclaw/plugin-sdk/agent-dir-compat",
      "openclaw/plugin-sdk/test-utils",
    ]) {
      expect(specifiers).not.toContain(removedSpecifier);
    }
  });

  it("bans the scoped @openclaw/plugin-sdk spelling of every deprecated specifier", () => {
    const specifiers = new Set(buildDeprecatedPluginSdkModuleSpecifiers());

    for (const specifier of specifiers) {
      if (!specifier.startsWith("@")) {
        expect(specifiers.has(`@${specifier}`), specifier).toBe(true);
      }
    }
  });

  it("bans internal imports of every deprecated facade", () => {
    const modulePaths = new Set(
      BANNED_INTERNAL_PLUGIN_SDK_FACADE_MODULES.map((ban) => ban.modulePath),
    );

    for (const facade of [
      "src/plugin-sdk/channel-message",
      "src/plugin-sdk/channel-reply-pipeline",
      "src/plugin-sdk/inbound-reply-dispatch",
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
    const result = runRules({
      "src/channels/probe.ts": [
        'import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";',
        'export { runChannelInboundEvent } from "../plugin-sdk/inbound-reply-dispatch.js";',
        'const facade = await import ("../plugin-sdk/channel-message.js", { with: {} });',
      ].join("\n"),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "src/channels/probe.ts:1: openclaw/plugin-sdk/channel-reply-pipeline",
    );
    expect(result.stderr).toContain(
      "src/channels/probe.ts:2: ../plugin-sdk/inbound-reply-dispatch.js",
    );
    expect(result.stderr).toContain("src/channels/probe.ts:3: ../plugin-sdk/channel-message.js");
  });

  it("allows canonical compat re-exports and test files", () => {
    const result = runRules({
      "src/plugin-sdk/inbound-reply-dispatch.ts":
        'export { runChannelInboundEvent } from "./channel-inbound.js";',
      "src/plugin-sdk/channel-message.test.ts":
        'const mod = await import("openclaw/plugin-sdk/channel-message");',
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("reads overlapping rule inputs once while preserving complete diagnostic order", () => {
    const result = runRules(
      {
        "src/a.ts":
          'import { x } from "openclaw/plugin-sdk/channel-message";\ndeliverOutboundPayloads();',
        "extensions/probe/src/a.ts":
          'export { x } from "openclaw/plugin-sdk/channel-reply-pipeline";\ndeliverOutboundPayloads();',
        "packages/a.ts":
          'import { x } from "openclaw/plugin-sdk/command-auth";\ndeliverOutboundPayloads();',
        "src/infra/outbound/deliver.ts": "deliverOutboundPayloads();",
        "src/a.test.ts": "deliverOutboundPayloads();",
      },
      [
        "message-api",
        "facade-internal-imports",
        "extension-plugin-sdk-compat-subpaths",
        "plugin-sdk-compat-subpaths",
      ],
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      [
        "Deprecated API usage guard failed:",
        "- plugin-sdk-compat-subpaths: src/a.ts:1: openclaw/plugin-sdk/channel-message (use focused non-deprecated plugin SDK subpaths)",
        "- plugin-sdk-compat-subpaths: packages/a.ts:1: openclaw/plugin-sdk/command-auth (use focused non-deprecated plugin SDK subpaths)",
        "- extension-plugin-sdk-compat-subpaths: extensions/probe/src/a.ts:1: openclaw/plugin-sdk/channel-reply-pipeline (extensions must use focused non-deprecated plugin SDK subpaths)",
        "- facade-internal-imports: src/a.ts:1: openclaw/plugin-sdk/channel-message (use openclaw/plugin-sdk/channel-outbound)",
        "- facade-internal-imports: extensions/probe/src/a.ts:1: openclaw/plugin-sdk/channel-reply-pipeline (use openclaw/plugin-sdk/channel-outbound)",
        "- message-api: src/a.ts:2: deliverOutboundPayloads (use sendDurableMessageBatch or deliverInboundReplyWithMessageSendContext)",
        "- message-api: extensions/probe/src/a.ts:2: deliverOutboundPayloads (use sendDurableMessageBatch or deliverInboundReplyWithMessageSendContext)",
        "- message-api: packages/a.ts:2: deliverOutboundPayloads (use sendDurableMessageBatch or deliverInboundReplyWithMessageSendContext)",
        "",
      ].join("\n"),
    );
    expect(result.io.files).toEqual({
      "src/a.ts": 1,
      "src/infra/outbound/deliver.ts": 1,
      "packages/a.ts": 1,
      "extensions/probe/src/a.ts": 1,
    });
    expect(result.io.directories).toEqual({
      src: 1,
      "src/infra": 1,
      "src/infra/outbound": 1,
      packages: 1,
      extensions: 1,
      "extensions/probe": 1,
      "extensions/probe/src": 1,
    });
  });

  it("does not read a file allowed by the only selected rule", () => {
    const result = runRules({ "src/infra/outbound/deliver.ts": "deliverOutboundPayloads();" }, [
      "message-api",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.io.files).toEqual({});
  });

  it("rejects unknown rules before reading any source directories", () => {
    const result = runRules({ "src/a.ts": "deliverOutboundPayloads();" }, ["unknown"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Unknown deprecated API usage rule(s): unknown\n");
    expect(result.io).toEqual({ files: {}, directories: {} });
  });
});
