// Check Deadcode Exports tests cover parsing and hard-zero enforcement.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import allExportsKnipConfig from "../../config/knip.all-exports.config.ts";
import knipConfig from "../../config/knip.config.ts";
import scriptExportsKnipConfig from "../../config/knip.scripts-exports.config.ts";
import {
  checkUnusedExports,
  parseKnipCompactUnusedExports,
  parseKnipCompactUnusedExportsResult,
} from "../../scripts/check-deadcode-exports.mjs";

const fullRootWorkspace = allExportsKnipConfig.workspaces["."];
const fullExtensionWorkspace = allExportsKnipConfig.workspaces["extensions/*"];
const fullUiWorkspace = allExportsKnipConfig.workspaces.ui;
const scriptRootWorkspace = scriptExportsKnipConfig.workspaces["."];
if (!fullRootWorkspace || !fullExtensionWorkspace || !fullUiWorkspace || !scriptRootWorkspace) {
  throw new Error("deadcode Knip configs must define root, extension, and UI workspaces");
}

function listQaScenarioExecutionPaths(dir = "qa/scenarios"): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listQaScenarioExecutionPaths(entryPath);
      }
      if (!entry.isFile() || (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml"))) {
        return [];
      }
      const document = YAML.parse(fs.readFileSync(entryPath, "utf8")) as {
        scenario?: { execution?: { kind?: unknown; path?: unknown } };
      };
      const execution = document.scenario?.execution;
      return execution?.kind !== "flow" && typeof execution?.path === "string"
        ? [execution.path]
        : [];
    })
    .toSorted();
}

describe("check-deadcode-exports", () => {
  it("requests every unused-export issue class from Knip", () => {
    const script = fs.readFileSync(
      new URL("../../scripts/check-deadcode-exports.mjs", import.meta.url),
      "utf8",
    );
    expect(script).toContain('"exports,nsExports,types,nsTypes,enumMembers,namespaceMembers"');
    expect(script).toContain('"config/knip.config.ts", "--production"');
    expect(script).toContain('"config/knip.all-exports.config.ts"');
    expect(script).toContain('"config/knip.scripts-exports.config.ts"');
    expect(script).toContain(
      'args: ["--config", "config/knip.scripts-exports.config.ts", "--include-entry-exports"]',
    );
  });

  it("excludes test support only from the production scan", () => {
    expect(knipConfig.ignore).toContain("dist/**");
    expect(knipConfig.ignore).toContain("**/test-helpers/**");
    expect(knipConfig.ignore).toContain("**/*.test-utils.ts");
    expect(knipConfig.ignoreFiles).not.toContain("**/test-helpers/**");
    expect(knipConfig.ignoreFiles).toContain("scripts/**");
    expect(allExportsKnipConfig.ignoreFiles).not.toContain("scripts/**");
    expect(knipConfig.ignoreFiles).toContain("dist/**");
    expect(knipConfig.ignore).not.toContain("**/live-*.ts");
    expect(knipConfig.ignoreFiles).toContain("**/live-*.ts");
    expect(allExportsKnipConfig.ignore).toEqual([
      "dist/**",
      "packages/*/dist/**",
      "**/.boundary-stubs/**",
    ]);
    expect(allExportsKnipConfig.ignoreIssues).toHaveProperty("test/fixtures/ts-topology/basic/**");
    expect(knipConfig.workspaces["."].project).toContain("scripts/**/*.{js,mjs,cjs,ts,mts,cts}!");
  });

  it("makes tests in every workspace roots of the full-tree export audit", () => {
    expect(knipConfig.workspaces["."].entry).not.toContain(
      "test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
    );
    expect(knipConfig.workspaces["."].entry).toEqual(
      expect.arrayContaining([
        "config/knip.config.ts!",
        "config/knip.all-exports.config.ts!",
        "config/knip.scripts-exports.config.ts!",
      ]),
    );
    expect(knipConfig.workspaces["."].project).toContain("config/**/*.{ts,mts,cts}!");
    expect(fullRootWorkspace.entry).toEqual(
      expect.arrayContaining([
        ".agents/skills/**/scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
        "scripts/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
        "test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
        "test/vitest/vitest*.config.ts!",
      ]),
    );
    expect(fullExtensionWorkspace.entry).toContain("**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!");
    expect(fullUiWorkspace.entry).toContain("**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!");
  });

  it("models every QA scenario execution path as a full-tree root", () => {
    const rootEntries = fullRootWorkspace.entry;
    const executionPaths = listQaScenarioExecutionPaths();

    expect(executionPaths.length).toBeGreaterThan(0);
    for (const executionPath of executionPaths) {
      expect(fs.existsSync(executionPath), executionPath).toBe(true);
      expect(rootEntries, executionPath).toContain(`${executionPath}!`);
    }
    expect(rootEntries).toContain(
      "test/e2e/qa-lab/runtime/fixtures/voice-call-runtime-plugin/index.js!",
    );
  });

  it("keeps the script unused-export scan scoped to real executable roots", () => {
    expect(scriptRootWorkspace.entry).toEqual(
      expect.arrayContaining([
        ".agents/skills/**/scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        ".github/actions/setup-node-env/dependency-fingerprint.mjs!",
        ".github/actions/register-bind-mount-cleanup/main.cjs!",
        "apps/android/scripts/build-release-artifacts.ts!",
        "security/opengrep/check-rule-metadata.mjs!",
        "skills/meme-maker/scripts/meme.mjs!",
        "scripts/check-live-cache.ts!",
        "scripts/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
        "test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
        "src/plugin-sdk/api-baseline.ts!",
      ]),
    );
    expect(scriptRootWorkspace.entry).not.toContain("scripts/**/*.{js,mjs,cjs,ts,mts,cts}!");
    expect(scriptExportsKnipConfig.ignoreIssues).toHaveProperty("src/**");
    expect(scriptExportsKnipConfig.ignoreIssues).toHaveProperty(
      "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs",
    );
    expect(scriptExportsKnipConfig.ignoreIssues).toHaveProperty(
      "scripts/e2e/secret-provider-integrations.mjs",
    );
  });

  it("audits executable code outside the main source trees", () => {
    expect(knipConfig.workspaces["."].project).toEqual(
      expect.arrayContaining([
        ".github/actions/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "apps/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "config/**/*.{ts,mts,cts}!",
        "docs/**/*.js!",
        "security/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "skills/**/*.{js,mjs,cjs,ts,mts,cts}!",
      ]),
    );
    expect(knipConfig.workspaces["."].entry).toContain("docs/nav-tabs-underline.js!");
    expect(knipConfig.workspaces["."].entry).toEqual(
      expect.arrayContaining([
        "config/knip.config.ts!",
        "config/knip.all-exports.config.ts!",
        "config/knip.scripts-exports.config.ts!",
      ]),
    );
    expect(knipConfig.workspaces["examples/ai-chat"]).toEqual({
      entry: ["index.mjs!"],
      project: ["**/*.{js,mjs,cjs,ts,mts,cts}!"],
    });
    expect(knipConfig.workspaces["qa/convex-credential-broker"].project).toContain(
      "convex/**/*.ts!",
    );
    expect(knipConfig.workspaces["qa/convex-credential-broker"].ignoreBinaries).toEqual(["convex"]);
  });

  it("tracks production script consumers of plugin exports", () => {
    expect(knipConfig.workspaces["."].entry).toContain("scripts/qa/render-maturity-docs.ts!");
  });

  it("runs exhaustive dead-code hygiene against production and full-tree configs", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["deadcode:dependencies"]).toBe("pnpm deadcode:full");
    expect(packageJson.scripts["deadcode:full"]).toContain(
      "--config config/knip.config.ts --production",
    );
    expect(packageJson.scripts["deadcode:full"]).toContain(
      "--config config/knip.all-exports.config.ts",
    );
    expect(packageJson.scripts["deadcode:full"]).toContain("--exclude duplicates");
  });

  it("models the jiti virtual agent-sessions SDK entry", () => {
    expect(knipConfig.workspaces["."].entry).toContain("src/agents/sessions/extension-sdk.ts!");
  });

  it("models the spawned system-agent MCP stdio entry", () => {
    expect(knipConfig.workspaces["."].entry).toContain("src/mcp/openclaw-tools-serve.ts!");
  });

  it("scans every nested bundled-plugin source file without broad entry masking", () => {
    const extensionWorkspaces = Object.entries(knipConfig.workspaces).filter(([workspace]) =>
      workspace.startsWith("extensions/"),
    );
    expect(extensionWorkspaces.length).toBeGreaterThan(1);
    for (const [workspace, settings] of extensionWorkspaces) {
      expect(settings.entry, workspace).not.toContain("*.ts!");
      expect(settings.project, workspace).toContain("**/*.{js,mjs,ts}!");
      expect(settings.entry, workspace).toEqual(
        expect.arrayContaining([
          "index.ts!",
          "setup-entry.ts!",
          "*-api.ts!",
          "cli-metadata.ts!",
          "channel-entry.ts!",
          "provider-discovery.ts!",
          "{web-search,web-fetch}-provider.ts!",
        ]),
      );
    }
    expect(knipConfig.workspaces["extensions/*"].project).toContain("**/*.{js,mjs,ts}!");
    expect(knipConfig.workspaces["extensions/llama-cpp"].project).toContain("**/*.{js,mjs,ts}!");
    expect(knipConfig.workspaces["extensions/reef"].project).toContain("**/*.{js,mjs,ts}!");
  });

  it("models non-imported runtime and build entrypoints explicitly", () => {
    expect(knipConfig.workspaces["."].entry).toEqual(
      expect.arrayContaining([
        "src/agents/subagent-registry.runtime.ts!",
        "src/mcp/plugin-tools-serve.ts!",
        "src/plugins/build-smoke-entry.ts!",
        "src/config/doc-baseline.ts!",
        "src/plugins/runtime-sidecar-paths-baseline.ts!",
        "tsdown.ai.config.ts!",
      ]),
    );
    expect(knipConfig.workspaces["extensions/acpx"].entry).toEqual(
      expect.arrayContaining([
        "src/runtime-internals/mcp-command-line.mjs!",
        "src/runtime-internals/mcp-proxy.mjs!",
      ]),
    );
    expect(knipConfig.workspaces["extensions/canvas"].entry).toEqual(
      expect.arrayContaining([
        "src/host/a2ui-app/bootstrap.js!",
        "src/host/a2ui-app/rolldown.config.mjs!",
      ]),
    );
    expect(knipConfig.workspaces["extensions/diffs"].entry).toContain("src/viewer-client.ts!");
    expect(knipConfig.workspaces["extensions/matrix"].entry).toContain(
      "src/plugin-entry.runtime.js!",
    );
    expect(knipConfig.workspaces["extensions/mxc"].entry).toContain("src/mxc-spawn-launcher.mjs!");
    expect(knipConfig.workspaces["extensions/qa-lab"].entry).toContain("src/ci-smoke-plan.ts!");
  });

  it("models the Browser facades loaded by basename", () => {
    const workspace = knipConfig.workspaces["extensions/browser"];
    expect(workspace.entry).toEqual(
      expect.arrayContaining([
        "browser-control-auth.ts!",
        "browser-config.ts!",
        "browser-doctor.ts!",
        "browser-host-inspection.ts!",
        "browser-maintenance.ts!",
        "browser-profiles.ts!",
      ]),
    );
  });

  it.each([
    "packages/agent-core",
    "packages/markdown-core",
    "packages/media-core",
    "packages/acp-core",
    "packages/terminal-core",
  ] as const)("mirrors the published entry map for %s", (workspace) => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL(`../../${workspace}/package.json`, import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown> };
    const expected = Object.keys(packageJson.exports)
      .map((subpath) =>
        subpath === "." ? "src/index.ts!" : `src/${subpath.slice("./".length)}.ts!`,
      )
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
