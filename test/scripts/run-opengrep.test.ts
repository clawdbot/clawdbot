import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("run-opengrep.sh", () => {
  it("validates the rulepack when only OpenGrep rulepack files changed", () => {
    const repo = createTempDir("openclaw-run-opengrep-");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    const scriptSource = path.resolve("scripts/run-opengrep.sh");
    writeFile(path.join(repo, "scripts/run-opengrep.sh"), fs.readFileSync(scriptSource, "utf8"));
    fs.chmodSync(path.join(repo, "scripts/run-opengrep.sh"), 0o755);
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "initial");

    fs.appendFileSync(path.join(repo, "security/opengrep/precise.yml"), "# changed\n");
    const argsPath = path.join(repo, "opengrep-args.txt");
    const binDir = path.join(repo, "bin");
    fs.mkdirSync(binDir);
    writeFile(
      path.join(binDir, "opengrep"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(path.join(binDir, "opengrep"), 0o755);

    execFileSync("bash", ["scripts/run-opengrep.sh", "--changed"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_OPENGREP_BASE_REF: "HEAD",
      },
      encoding: "utf8",
    });

    const args = fs.readFileSync(path.join(repo, "opengrep-args.txt"), "utf8");
    expect(args).toContain("security/opengrep/precise.yml");
  });
});
