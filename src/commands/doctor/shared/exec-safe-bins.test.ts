// Exec safe-bin tests cover doctor validation of executable helper paths.
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
          "jq can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
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
            "jq can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
        },
        {
          scopePath: "tools.exec",
          bin: "myfilter",
          kind: "missingProfile",
          isInterpreter: false,
        },
      ],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      "- tools.exec.safeBins includes interpreter/runtime 'node' without profile.",
      "- tools.exec.safeBins entry 'myfilter' is missing safeBinProfiles.myfilter.",
      "- agents.list.runner.tools.exec.safeBins includes 'jq': jq can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      '- Run "openclaw doctor --fix" to scaffold missing custom safeBinProfiles entries.',
    ]);
  });

  it("omits doctor fix hint when no custom safeBin profiles can be scaffolded", () => {
    const warnings = collectExecSafeBinCoverageWarnings({
      hits: [
        {
          scopePath: "tools.exec",
          bin: "jq",
          kind: "riskySemantics",
          warning:
            "jq can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
        },
      ],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      "- tools.exec.safeBins includes 'jq': jq can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
    ]);
  });

  it("scaffolds custom safeBin profiles but warns on interpreters and risky bins", () => {
    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["node", "jq", "myfilter"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- tools.exec.safeBinProfiles.myfilter: added scaffold profile {} (review and tighten flags/positionals).",
    ]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes 'jq': jq can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      "- tools.exec.safeBins includes interpreter/runtime 'node' without profile; remove it from safeBins or use explicit allowlist entries.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toEqual({ myfilter: {} });
  });

  it("does not scaffold normalized risky safeBins from path-like entries", () => {
    const hits = scanExecSafeBinCoverage({
      tools: {
        exec: {
          safeBins: ["/usr/local/bin/jq", "sed.exe", "myfilter"],
        },
      },
    } as OpenClawConfig);

    expect(hits).toEqual([
      { scopePath: "tools.exec", bin: "myfilter", kind: "missingProfile", isInterpreter: false },
      {
        scopePath: "tools.exec",
        bin: "jq",
        kind: "riskySemantics",
        warning:
          "jq can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        scopePath: "tools.exec",
        bin: "sed",
        kind: "riskySemantics",
        warning:
          "sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
    ]);

    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["/usr/local/bin/jq", "sed.exe", "myfilter"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- tools.exec.safeBinProfiles.myfilter: added scaffold profile {} (review and tighten flags/positionals).",
    ]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes 'jq': jq can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      "- tools.exec.safeBins includes 'sed': sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toEqual({ myfilter: {} });
  });

  it("warns on awk-family safeBins instead of scaffolding them", () => {
    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["awk", "sed"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes 'awk': awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      "- tools.exec.safeBins includes 'sed': sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toBeUndefined();
  });

  it("warns on busybox/toybox safeBins instead of scaffolding them", () => {
    const result = maybeRepairExecSafeBinProfiles({
      tools: {
        exec: {
          safeBins: ["busybox", "toybox"],
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toEqual([
      "- tools.exec.safeBins includes interpreter/runtime 'busybox' without profile; remove it from safeBins or use explicit allowlist entries.",
      "- tools.exec.safeBins includes interpreter/runtime 'toybox' without profile; remove it from safeBins or use explicit allowlist entries.",
    ]);
    expect(result.config.tools?.exec?.safeBinProfiles).toStrictEqual({});
  });

  it("flags safeBins that resolve outside trusted directories", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-safe-bin-"));
    try {
      const binPath = join(tempDir, "custom-safe-bin");
      writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
      chmodSync(binPath, 0o755);
      process.env.PATH = [tempDir, originalPath]
        .filter((entry) => entry.length > 0)
        .join(delimiter);

      const hits = scanExecSafeBinTrustedDirHints({
        tools: {
          exec: {
            safeBins: ["custom-safe-bin"],
            safeBinProfiles: { "custom-safe-bin": {} },
          },
        },
      } as OpenClawConfig);

      expect(hits).toStrictEqual([
        {
          scopePath: "tools.exec",
          bin: "custom-safe-bin",
          resolvedPath: binPath,
        },
      ]);

      const warnings = collectExecSafeBinTrustedDirHintWarnings(hits);
      expect(warnings).toStrictEqual([
        `- tools.exec.safeBins entry 'custom-safe-bin' resolves to '${binPath}' outside trusted safe-bin dirs.`,
        "- If intentional, add the binary directory to tools.exec.safeBinTrustedDirs (global or agent scope).",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
