import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  collectExecSafeBinCoverageWarnings,
  collectExecSafeBinTrustedDirHintWarnings,
  maybeRepairExecSafeBinProfiles,
  scanExecSafeBinCoverage,
  scanExecSafeBinTrustedDirHints,
} from "./exec-safe-bins.js";

const originalPath = process.env.PATH ?? "";

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("doctor exec safe bin helpers", () => {
  it("finds missing safeBin profiles and marks interpreters", () => {
    const hits = scanExecSafeBinCoverage({
      tools: {
        exec: {
          safeBins: ["node", "jq"],
          safeBinProfiles: { jq: {} },
        },
      },
    } as OpenClawConfig);

    expect(hits).toEqual([
      { scopePath: "tools.exec", bin: "node", kind: "missingProfile", isInterpreter: true },
      {
        scopePath: "tools.exec",
        bin: "jq",
        kind: "riskySemantics",
        warning:
          "jq supports broad jq programs and builtins (for example `env`), so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
    ]);
  });

  it("formats coverage warnings", () => {
    const warnings = collectExecSafeBinCoverageWarnings({
      hits: [
        { scopePath: "tools.exec", bin: "node", kind: "missingProfile", isInterpreter: true },
        {
          scopePath: "agents.list.runner.tools.exec",
          bin: "jq",
          kind: "riskySemantics",
          warning:
            "jq supports broad jq programs and builtins (for example `env`), so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
        },
      ],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining("tools.exec.safeBins includes interpreter/runtime 'node'"),
      expect.stringContaining("agents.list.runner.tools.exec.safeBins includes 'jq'"),
      expect.stringContaining('Run "openclaw doctor --fix"'),
    ]);
  });

  it("scaffolds custom safeBin profiles but warns on interpreters", () => {
    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["node", "jq"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- tools.exec.safeBinProfiles.jq: added scaffold profile {} (review and tighten flags/positionals).",
    ]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes 'jq': jq supports broad jq programs and builtins (for example `env`), so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      "- tools.exec.safeBins includes interpreter/runtime 'node' without profile; remove it from safeBins or use explicit allowlist entries.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toEqual({ jq: {} });
  });

  it("warns on awk-family safeBins instead of scaffolding them", () => {
    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["awk", "sed"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes 'awk': awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      "- tools.exec.safeBins includes 'sed': sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      "- tools.exec.safeBins includes interpreter/runtime 'awk' without profile; remove it from safeBins or use explicit allowlist entries.",
      "- tools.exec.safeBins includes interpreter/runtime 'sed' without profile; remove it from safeBins or use explicit allowlist entries.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toEqual({});
  });

  it("warns on busybox/toybox safeBins instead of scaffolding them", () => {
    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["busybox", "toybox"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes interpreter/runtime 'busybox' without profile; remove it from safeBins or use explicit allowlist entries.",
      "- tools.exec.safeBins includes interpreter/runtime 'toybox' without profile; remove it from safeBins or use explicit allowlist entries.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toEqual({});
  });

  it("flags safeBins that resolve outside trusted directories", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-safe-bin-"));
    const binPath = join(tempDir, "custom-safe-bin");
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binPath, 0o755);
    process.env.PATH = [tempDir, originalPath].filter((entry) => entry.length > 0).join(delimiter);

    const hits = scanExecSafeBinTrustedDirHints({
      tools: {
        exec: {
          safeBins: ["custom-safe-bin"],
          safeBinProfiles: { "custom-safe-bin": {} },
        },
      },
    } as OpenClawConfig);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      scopePath: "tools.exec",
      bin: "custom-safe-bin",
      resolvedPath: binPath,
    });

    expect(collectExecSafeBinTrustedDirHintWarnings(hits)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("tools.exec.safeBins entry 'custom-safe-bin'"),
        expect.stringContaining("tools.exec.safeBinTrustedDirs"),
      ]),
    );

    rmSync(tempDir, { recursive: true, force: true });
  });
});
