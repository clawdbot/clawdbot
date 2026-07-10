// Openclaw Cross Os Release Workflow tests cover openclaw cross os release workflow script behavior.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = ".github/workflows/openclaw-cross-os-release-checks-reusable.yml";
const WRAPPER_PATH = "scripts/github/run-openclaw-cross-os-release-checks.sh";
const SCRIPT_PATH = "scripts/openclaw-cross-os-release-checks.ts";
const HARNESS = "bash workflow/scripts/github/run-openclaw-cross-os-release-checks.sh";
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";

describe("cross-OS release checks workflow", () => {
  it("runs the TypeScript release harness through the Windows-safe wrapper", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain(HARNESS);
    expect(workflow).toContain("suite_filter:");
    expect(workflow).toContain('--suite-filter "${INPUT_SUITE_FILTER}"');
    expect(workflow).not.toContain("TSX_VERSION");
  });

  it("bounds npm baseline packing during prepare", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain("timeout --preserve-status 300s npm pack --ignore-scripts");
  });

  it("keeps release artifact tarball filenames local before upload paths use them", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow.match(/function resolveTarballFileName/g)).toHaveLength(2);
    expect(workflow.match(/path\.win32\.basename\(fileName\)/g)).toHaveLength(2);
    expect(workflow).toContain("candidate_file_name");
    expect(workflow).toContain("Baseline npm pack filename");
    expect(workflow).toContain("fileName !== path.basename(fileName)");
    expect(workflow).toContain("fileName !== path.win32.basename(fileName)");
    expect(workflow).toContain("process.stdout.write(`file_name=${fileName}\\n`);");
  });

  it("executes the release harness directly with Node", () => {
    const wrapper = readFileSync(WRAPPER_PATH, "utf8");
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(wrapper).toContain('exec "${node_cmd}" "${script_path}" "$@"');
    expect(wrapper).not.toContain("npm");
    expect(wrapper).not.toContain("tsx");
    expect(wrapper).not.toContain("--import");
    expect(script).toMatch(/^#!\/usr\/bin\/env node$/mu);
    expect(script).not.toContain("--import tsx");
    expect(packageJson.scripts["test:windows:ci"]).toContain(
      "test/scripts/openclaw-cross-os-release-workflow.test.ts",
    );

    const result = spawnSync(
      BASH_BIN,
      [
        WRAPPER_PATH,
        "--resolve-matrix",
        "--ref",
        "test/native-node",
        "--mode",
        "fresh",
        "--suite-filter",
        "windows/packaged-fresh",
        "--windows-runner",
        "windows-2025",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_RELEASE_CHECKS_SCRIPT: SCRIPT_PATH,
        },
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      include: [
        {
          os_id: "windows",
          display_name: "Windows",
          runner: "windows-2025",
          artifact_name: "windows",
          suite: "packaged-fresh",
          suite_label: "packaged fresh",
          lane: "fresh",
        },
      ],
    });
  });
});
