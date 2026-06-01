import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve("scripts/check-workflows.mjs");

describe("check-workflows", () => {
  it("prints an actionable diagnostic when actionlint and go are unavailable", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing workflow linter");
    expect(result.stderr).toContain("install actionlint, Go");
  });

  it("uses the pinned go fallback and audits all workflows with zizmor", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "check-workflows-"));
    try {
      const binDir = path.join(tempDir, "bin");
      const markerPath = path.join(tempDir, "go-run.txt");
      const preCommitMarkerPath = path.join(tempDir, "pre-commit.txt");
      mkdirSync(binDir);
      writeFileSync(
        path.join(binDir, "go"),
        [
          "#!/bin/sh",
          'if [ "$1" = "version" ]; then exit 0; fi',
          'if [ "$1" = "run" ]; then printf "%s\\n" "$*" > "$GO_FALLBACK_MARKER"; exit 0; fi',
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(
        path.join(binDir, "pre-commit"),
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then exit 0; fi',
          'printf "%s\\n" "$*" >> "$PRE_COMMIT_MARKER"',
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      for (const command of ["python3", "node"]) {
        writeFileSync(path.join(binDir, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }

      const result = spawnSync(process.execPath, [scriptPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          GO_FALLBACK_MARKER: markerPath,
          PRE_COMMIT_MARKER: preCommitMarkerPath,
          PATH: binDir,
        },
      });

      expect(result.status).toBe(0);
      expect(readFileSync(markerPath, "utf8")).toContain(
        "github.com/rhysd/actionlint/cmd/actionlint@v1.7.11",
      );
      const preCommitArgs = readFileSync(preCommitMarkerPath, "utf8");
      expect(preCommitArgs).toContain("run --config .pre-commit-config.yaml zizmor --files");
      expect(preCommitArgs).toContain(".github/workflows/ci.yml");
      expect(preCommitArgs).toContain(".github/workflows/windows-testbox-probe.yml");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
