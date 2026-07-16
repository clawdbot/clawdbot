// Check Deadcode Exports tests cover parsing and hard-zero enforcement.
import { describe, expect, it } from "vitest";
import knipConfig from "../../config/knip.config.ts";
import {
  checkUnusedExports,
  parseKnipCompactUnusedExports,
  parseKnipCompactUnusedExportsResult,
} from "../../scripts/check-deadcode-exports.mjs";

describe("check-deadcode-exports", () => {
  it("excludes test support from every Knip issue type", () => {
    expect(knipConfig.ignore).toContain("dist/**");
    expect(knipConfig.ignore).toContain("**/test-helpers/**");
    expect(knipConfig.ignore).toContain("**/*.test-utils.ts");
    expect(knipConfig.ignoreFiles).not.toContain("**/test-helpers/**");
    expect(knipConfig.ignoreFiles).toContain("scripts/**");
    expect(knipConfig.ignoreFiles).toContain("dist/**");
    expect(knipConfig.ignore).not.toContain("**/live-*.ts");
    expect(knipConfig.ignoreFiles).toContain("**/live-*.ts");
  });

  it("tracks production script consumers of plugin exports", () => {
    expect(knipConfig.workspaces["."].entry).toContain("scripts/qa/render-maturity-docs.ts!");
  });

  it("models the jiti virtual agent-sessions SDK entry", () => {
    expect(knipConfig.workspaces["."].entry).toContain("src/agents/sessions/extension-sdk.ts!");
  });

  it("models the spawned system-agent MCP stdio entry", () => {
    expect(knipConfig.workspaces["."].entry).toContain("src/mcp/openclaw-tools-serve.ts!");
  });

  it("parses all compact export sections and expands symbol lists", () => {
    expect(
      parseKnipCompactUnusedExports(`
Unused exports (2)
src/b.ts: beta, alpha
/tmp/outside.ts: noise

Unused exported types (1)
extensions/example/src/types.ts: ExampleType

Unused exported enum members (1)
packages/example/src/state.ts: Ready

Unused files (1)
src/noise.ts: src/noise.ts
`),
    ).toEqual([
      "extensions/example/src/types.ts: ExampleType",
      "packages/example/src/state.ts: Ready",
      "src/b.ts: alpha",
      "src/b.ts: beta",
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
