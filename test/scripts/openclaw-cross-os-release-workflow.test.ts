import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = ".github/workflows/openclaw-cross-os-release-checks-reusable.yml";
const WRAPPER_PATH = "scripts/github/run-openclaw-cross-os-release-checks.sh";
const HARNESS = "bash workflow/scripts/github/run-openclaw-cross-os-release-checks.sh";

describe("cross-OS release checks workflow", () => {
  it("runs the TypeScript release harness through the Windows-safe wrapper", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain(HARNESS);
    expect(workflow).toContain("suite_filter:");
    expect(workflow).toContain('--suite-filter "${INPUT_SUITE_FILTER}"');
    expect(workflow).not.toContain('pnpm dlx "tsx@${TSX_VERSION}"');
  });

  it("uses Windows-safe npm resolution for the TypeScript loader bootstrap", () => {
    const wrapper = readFileSync(WRAPPER_PATH, "utf8");

    expect(wrapper).toContain("command -v npm.cmd");
    expect(wrapper).toContain('npm_tool_dir="$(cygpath -w "${tool_dir}")"');
    expect(wrapper).toContain('"${npm_cmd}" install --prefix "${npm_tool_dir}"');
    expect(wrapper).toContain('exec "${node_cmd}" --import "${loader_url}"');
  });
});
