// Temp path guardrail tests cover repository-scale tracked file discovery.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../../scripts/check-temp-path-guardrails.ts",
);
const TSX_IMPORT = import.meta.resolve("tsx");
const { createTempDir } = createScriptTestHarness();

describe("check-temp-path-guardrails", () => {
  it("scans tracked runtime file lists larger than Node's default child-process buffer", () => {
    const repoRoot = createTempDir("openclaw-temp-path-guard-");
    const binDir = path.join(repoRoot, "bin");
    fs.mkdirSync(binDir);

    const gitPath = path.join(binDir, "git");
    fs.writeFileSync(
      gitPath,
      `#!/usr/bin/env node
const line = "src/" + "a".repeat(240) + ".ts\\n";
process.stdout.write(line.repeat(Math.ceil((1.25 * 1024 * 1024) / line.length)));
`,
    );
    fs.chmodSync(gitPath, 0o755);

    const result = spawnSync(process.execPath, ["--import", TSX_IMPORT, SCRIPT_PATH], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      maxBuffer: 4 * 1024 * 1024,
    });

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
