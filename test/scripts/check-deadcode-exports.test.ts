// Check Deadcode Exports tests cover parsing and hard-zero enforcement.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { listQaScenarioExecutionEntries } from "../../config/knip.all-exports.config.ts";
import knipConfig, { bundledPluginEntries } from "../../config/knip.config.ts";
import {
  checkUnusedExports,
  parseKnipCompactUnusedExports,
  parseKnipCompactUnusedExportsResult,
} from "../../scripts/check-deadcode-exports.mjs";

describe("check-deadcode-exports", () => {
  it("uses structural ownership without file-level Knip ignores", () => {
    expect("ignore" in knipConfig).toBe(false);
    expect("ignoreFiles" in knipConfig).toBe(false);
    for (const workspace of Object.values(knipConfig.workspaces)) {
      expect("ignore" in workspace).toBe(false);
      expect("ignoreFiles" in workspace).toBe(false);
    }
  });

  it("audits unused exports with a production and a full-tree scan of one config", () => {
    const script = fs.readFileSync(
      new URL("../../scripts/check-deadcode-exports.mjs", import.meta.url),
      "utf8",
    );
    expect(script).toContain('"exports,nsExports,types,nsTypes,enumMembers,namespaceMembers"');
    expect(script).toContain('args: ["--config", "config/knip.config.ts", "--production"]');
    expect(script).toContain('args: ["--config", "config/knip.config.ts"]');
    expect(script).not.toContain("--include-entry-exports");
    // Config hints report ignore entries that stopped suppressing anything.
    expect(script).not.toContain("--no-config-hints");
  });

  it("keeps scripts audited without auditing entry exports", () => {
    const rootWorkspace = knipConfig.workspaces["."];

    expect(rootWorkspace.entry).toContain("scripts/check-live-cache.ts!");
    expect(rootWorkspace.project).toContain("scripts/**/*.{js,mjs,cjs,ts,mts,cts}");
    expect(rootWorkspace.project).toContain("!scripts/**!");
    for (const workspace of Object.values(knipConfig.workspaces)) {
      expect("includeEntryExports" in workspace).toBe(false);
    }
  });

  it("resolves every QA scenario execution path as a full-tree root", () => {
    const entries = listQaScenarioExecutionEntries();

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(fs.existsSync(entry), entry).toBe(true);
      expect(entry.endsWith("!"), entry).toBe(false);
    }
  });

  it("keeps OpenClaw-private bundled plugin surfaces in the repository config", () => {
    expect(knipConfig.workspaces["extensions/*"].entry).toEqual(bundledPluginEntries);
    expect(knipConfig.workspaces["extensions/browser"].entry).toEqual(
      expect.arrayContaining([
        ...bundledPluginEntries,
        "browser-control-auth.ts!",
        "scripts/copilot-runtime-entry.ts!",
      ]),
    );
    expect(bundledPluginEntries).not.toContain("index.ts!");
    expect(bundledPluginEntries).not.toContain("setup-entry.ts!");
    expect("extensions/vault" in knipConfig.workspaces).toBe(false);
  });

  it("mirrors the published agent-core entries with relocated harness sources", () => {
    const workspace = "packages/agent-core";
    const packageJson = JSON.parse(
      fs.readFileSync(new URL(`../../${workspace}/package.json`, import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown> };
    const conventionalEntries = Object.keys(packageJson.exports).map((subpath) =>
      subpath === "." ? "src/index.ts!" : `src/${subpath.slice("./".length)}.ts!`,
    );
    const missingConventionalEntries = conventionalEntries.filter(
      (entry) =>
        !fs.existsSync(
          new URL(`../../${workspace}/${entry.slice(0, -"!".length)}`, import.meta.url),
        ),
    );
    expect(missingConventionalEntries).toEqual([
      "src/harness/compaction.ts!",
      "src/harness/branch-summarization.ts!",
    ]);
    for (const sourcePath of [
      "src/harness/compaction/compaction.ts",
      "src/harness/compaction/branch-summarization.ts",
    ]) {
      expect(
        fs.existsSync(new URL(`../../${workspace}/${sourcePath}`, import.meta.url)),
        sourcePath,
      ).toBe(true);
    }
    const expected = conventionalEntries
      .filter((entry) => !missingConventionalEntries.includes(entry))
      .toSorted();
    expect([...knipConfig.workspaces[workspace].entry].toSorted()).toEqual(expected);
  });

  it("parses all compact export sections and expands symbol lists", () => {
    expect(
      parseKnipCompactUnusedExports(`
Unused exports (2)
src/b.ts: beta, alpha
/tmp/outside.ts: noise
C:\\tmp\\outside.ts: noise
C:outside.ts: noise
\\\\server\\share\\outside.ts: noise

Unused exported types (1)
extensions/example/src/types.ts: ExampleType

Unused exported enum members (1)
packages/example/src/state.ts: Ready

Exports in used namespace (1)
src/namespace.ts: runtimeHelper

Exported types in used namespace (1)
src/namespace.ts: RuntimeType

Unused exported namespace members (1)
src/protocol.ts: Result (v2)

Unused files (1)
src/noise.ts: src/noise.ts
`),
    ).toEqual([
      "extensions/example/src/types.ts: ExampleType",
      "packages/example/src/state.ts: Ready",
      "src/b.ts: alpha",
      "src/b.ts: beta",
      "src/namespace.ts: runtimeHelper",
      "src/namespace.ts: RuntimeType",
      "src/protocol.ts: Result (v2)",
    ]);
  });

  it("keeps findings from dot-directories and root entry files", () => {
    expect(
      parseKnipCompactUnusedExports(`Unused exports (2)
.agents/skills/example/scripts/check.mjs: checkExample
tsdown.ai.config.ts: default
`),
    ).toEqual([
      ".agents/skills/example/scripts/check.mjs: checkExample",
      "tsdown.ai.config.ts: default",
    ]);
  });

  it("distinguishes a failed scan with no export sections from zero findings", () => {
    expect(parseKnipCompactUnusedExportsResult("Configuration error: invalid project\n")).toEqual({
      entries: [],
      sawExportSection: false,
    });
    expect(parseKnipCompactUnusedExportsResult("Unused exports (0)\n")).toEqual({
      entries: [],
      sawExportSection: true,
    });
  });

  it("accepts an empty compact report with zero unused exports", () => {
    expect(checkUnusedExports("")).toEqual({
      ok: true,
      entries: [],
      message: "",
    });
  });

  it("rejects every unused export without an allowlist", () => {
    expect(
      checkUnusedExports(`Unused exports (2)
src/z.ts: zebra
src/a.ts: alpha
`),
    ).toEqual({
      ok: false,
      entries: ["src/a.ts: alpha", "src/z.ts: zebra"],
      message: `Unused exports are not allowed:
  src/a.ts: alpha
  src/z.ts: zebra
Delete the exports or model their real production consumers in Knip.`,
    });
  });
});
