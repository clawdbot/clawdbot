import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const scriptPath = path.resolve("scripts/check-composite-action-input-interpolation.py");

function writeAction(rootDir: string, name: string, source: string): void {
  const actionPath = path.join(rootDir, ".github", "actions", name, "action.yml");
  fs.mkdirSync(path.dirname(actionPath), { recursive: true });
  fs.writeFileSync(actionPath, source, "utf8");
}

function runCheck(cwd: string) {
  return spawnSync("python3", [scriptPath], {
    cwd,
    encoding: "utf8",
  });
}

describe("check-composite-action-input-interpolation", () => {
  it("rejects direct inputs interpolation inside composite run blocks", () => {
    const rootDir = createTempDir("openclaw-composite-action-inputs-");
    writeAction(
      rootDir,
      "unsafe",
      [
        "name: unsafe",
        "runs:",
        "  using: composite",
        "  steps:",
        "    - shell: bash",
        "      run: |",
        '        echo "${{ inputs.token }}"',
      ].join("\n"),
    );

    const result = runCheck(rootDir);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Disallowed direct inputs interpolation");
    expect(result.stdout).toContain(".github/actions/unsafe/action.yml:7");
    expect(result.stdout).toContain("Use env: and reference shell variables instead.");
  });

  it("allows env indirection and ignores non-composite actions", () => {
    const rootDir = createTempDir("openclaw-composite-action-inputs-");
    writeAction(
      rootDir,
      "safe",
      [
        "name: safe",
        "runs:",
        "  using: composite",
        "  steps:",
        "    - shell: bash",
        "      env:",
        "        TOKEN: ${{ inputs.token }}",
        "      run: |",
        '        echo "$TOKEN"',
      ].join("\n"),
    );
    writeAction(
      rootDir,
      "non-composite",
      [
        "name: non-composite",
        "runs:",
        "  using: node24",
        "  main: dist/index.js",
        "  steps:",
        '    - run: echo "${{ inputs.token }}"',
      ].join("\n"),
    );

    const result = runCheck(rootDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No direct inputs interpolation found");
  });
});
