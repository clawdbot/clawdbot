// Run Opengrep tests cover run opengrep script behavior.
import { execFileSync, spawnSync } from "node:child_process";
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

function copyRunOpengrepFiles(repo: string): void {
  const scriptSource = path.resolve("scripts/run-opengrep.sh");
  const helperSource = path.resolve("scripts/lib/merge-head-diff-base.mjs");
  writeFile(path.join(repo, "scripts/run-opengrep.sh"), fs.readFileSync(scriptSource, "utf8"));
  writeFile(
    path.join(repo, "scripts/lib/merge-head-diff-base.mjs"),
    fs.readFileSync(helperSource, "utf8"),
  );
  fs.chmodSync(path.join(repo, "scripts/run-opengrep.sh"), 0o755);
}

function installOpengrepStub(repo: string): { argsPath: string; binDir: string } {
  const argsPath = path.join(repo, "opengrep-args.txt");
  const binDir = path.join(repo, "bin");
  fs.mkdirSync(binDir);
  writeFile(
    path.join(binDir, "opengrep"),
    ["#!/usr/bin/env bash", `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`, "exit 0", ""].join(
      "\n",
    ),
  );
  fs.chmodSync(path.join(binDir, "opengrep"), 0o755);
  return { argsPath, binDir };
}

describe("run-opengrep.sh", () => {
  it("fails before scanning with official installation advice when opengrep is missing", () => {
    const repo = createTempDir("openclaw-run-opengrep-missing-");
    copyRunOpengrepFiles(repo);
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");

    const binDir = path.join(repo, "bin");
    fs.mkdirSync(binDir);
    for (const command of ["bash", "dirname", "cat"]) {
      const executable = execFileSync("bash", ["-c", 'command -v "$1"', "_", command], {
        encoding: "utf8",
      }).trim();
      fs.symlinkSync(executable, path.join(binDir, command));
    }

    const result = spawnSync(
      "bash",
      ["scripts/run-opengrep.sh", "--changed", "--sarif", "--error"],
      { cwd: repo, env: { ...process.env, PATH: binDir }, encoding: "utf8" },
    );

    expect(result.status).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("'opengrep' not found on PATH");
    expect(result.stderr).toMatch(
      /curl -fsSL https:\/\/raw\.githubusercontent\.com\/opengrep\/opengrep\/\S+\/install\.sh \| bash -s -- -v \S+/,
    );
    expect(fs.existsSync(path.join(repo, ".opengrep-out"))).toBe(false);
    expect(result.stderr).not.toContain("pipx");
    expect(result.stderr).not.toContain("opengrep/tap/opengrep");
  });

  it("validates the rulepack when only OpenGrep rulepack files changed", () => {
    const repo = createTempDir("openclaw-run-opengrep-");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    copyRunOpengrepFiles(repo);
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "initial");

    fs.appendFileSync(path.join(repo, "security/opengrep/precise.yml"), "# changed\n");
    const { argsPath, binDir } = installOpengrepStub(repo);

    execFileSync("bash", ["scripts/run-opengrep.sh", "--changed"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_OPENGREP_BASE_REF: "HEAD",
      },
      encoding: "utf8",
    });

    const args = fs.readFileSync(argsPath, "utf8");
    expect(args).toContain("security/opengrep/precise.yml");
  });

  it("writes empty SARIF when a changed scan has no first-party paths", () => {
    const repo = createTempDir("openclaw-run-opengrep-empty-sarif-");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    copyRunOpengrepFiles(repo);
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
    writeFile(path.join(repo, ".github/actions/ensure-base-commit/action.yml"), "name: ensure\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "initial");

    fs.appendFileSync(
      path.join(repo, ".github/actions/ensure-base-commit/action.yml"),
      "# changed\n",
    );
    const { argsPath, binDir } = installOpengrepStub(repo);

    execFileSync("bash", ["scripts/run-opengrep.sh", "--changed", "--sarif", "--error"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_OPENGREP_BASE_REF: "HEAD",
      },
      encoding: "utf8",
    });

    const sarif = JSON.parse(
      fs.readFileSync(path.join(repo, ".opengrep-out/precise.sarif"), "utf8"),
    );
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].tool.driver.name).toBe("Opengrep OSS");
    expect(sarif.runs[0].tool.driver.semanticVersion).toBe("1.27.1");
    expect(sarif.runs[0].results).toEqual([]);
    expect(fs.existsSync(argsPath)).toBe(false);
  });

  it.each([
    {
      failure: "invalid base range",
      baseRef: "missing-base...HEAD",
      failedGitCommand: null,
      errorText: "missing-base...HEAD",
    },
    {
      failure: "git ls-files",
      baseRef: "HEAD",
      failedGitCommand: "ls-files",
      errorText: "forced git ls-files failure",
    },
  ])(
    "fails when changed-path discovery hits $failure",
    ({ baseRef, failedGitCommand, errorText }) => {
      const repo = createTempDir("openclaw-run-opengrep-discovery-failure-");
      git(repo, "init", "-q");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "Test User");

      copyRunOpengrepFiles(repo);
      writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
      git(repo, "add", ".");
      git(repo, "commit", "-qm", "initial");

      const { argsPath, binDir } = installOpengrepStub(repo);
      // A failed new scan must not let a previous audit masquerade as its output.
      writeFile(path.join(repo, ".opengrep-out/precise.sarif"), "stale audit");
      if (failedGitCommand) {
        const realGit = execFileSync("bash", ["-lc", "command -v git"], {
          encoding: "utf8",
        }).trim();
        writeFile(
          path.join(binDir, "git"),
          [
            "#!/usr/bin/env bash",
            `if [[ "\${1:-}" == ${JSON.stringify(failedGitCommand)} ]]; then`,
            '  echo "forced git ls-files failure" >&2',
            "  exit 71",
            "fi",
            `exec ${JSON.stringify(realGit)} "$@"`,
            "",
          ].join("\n"),
        );
        fs.chmodSync(path.join(binDir, "git"), 0o755);
      }

      const result = spawnSync(
        "bash",
        ["scripts/run-opengrep.sh", "--changed", "--sarif", "--error"],
        {
          cwd: repo,
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            OPENCLAW_OPENGREP_BASE_REF: baseRef,
          },
          encoding: "utf8",
        },
      );

      expect.soft(result.status).not.toBe(0);
      expect.soft(result.stderr).toContain(errorText);
      expect.soft(fs.existsSync(argsPath)).toBe(false);
      expect.soft(fs.existsSync(path.join(repo, ".opengrep-out/precise.sarif"))).toBe(false);
    },
  );

  it("scans PR files instead of main-only files when the payload base is stale", () => {
    const repo = createTempDir("openclaw-run-opengrep-merge-");
    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    copyRunOpengrepFiles(repo);
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
    writeFile(path.join(repo, "README.md"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");
    const staleBase = git(repo, "rev-parse", "HEAD");

    git(repo, "switch", "-q", "-c", "feature");
    writeFile(path.join(repo, "src/pr.ts"), "export const pr = true;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "feature");

    git(repo, "switch", "-q", "main");
    writeFile(path.join(repo, "src/main-only.ts"), "export const mainOnly = true;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "main only");
    git(repo, "merge", "--no-ff", "feature", "-m", "synthetic merge");

    const { argsPath, binDir } = installOpengrepStub(repo);

    execFileSync("bash", ["scripts/run-opengrep.sh", "--changed"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_OPENGREP_BASE_REF: `${staleBase}...HEAD`,
        OPENCLAW_OPENGREP_MERGE_HEAD_FIRST_PARENT: "1",
      },
      encoding: "utf8",
    });

    const args = fs.readFileSync(argsPath, "utf8");
    expect(args).toContain("src/pr.ts");
    expect(args).not.toContain("src/main-only.ts");
  });
});

describe("OpenGrep GitHub SARIF projection", () => {
  const projectScript = path.resolve("scripts/project-opengrep-sarif.mjs");
  const activeResult = { ruleId: "fixture", message: { text: "active" }, locations: [] };
  const suppressedResult = {
    ...activeResult,
    message: { text: "reviewed fixture" },
    suppressions: [{ kind: "inSource" }],
  };
  const tool = {
    driver: { name: "Opengrep OSS", semanticVersion: "1.27.1", rules: [{ id: "fixture" }] },
  };

  function project(audit: string | undefined) {
    const repo = createTempDir("openclaw-opengrep-projection-");
    const auditPath = path.join(repo, ".opengrep-out/precise.sarif");
    const activePath = path.join(repo, ".opengrep-out/precise-active.sarif");
    if (audit !== undefined) {
      writeFile(auditPath, audit);
    }
    writeFile(activePath, "stale projection");
    const processResult = spawnSync(process.execPath, [projectScript], {
      cwd: repo,
      encoding: "utf8",
    });
    return { ...processResult, auditPath, activePath };
  }

  it.each([
    {
      name: "mixed findings",
      results: [activeResult, suppressedResult],
      expected: [activeResult],
      suppressed: 1,
    },
    { name: "all suppressed", results: [suppressedResult], expected: [], suppressed: 1 },
    { name: "no findings", results: [], expected: [], suppressed: 0 },
  ])(
    "projects $name while retaining the full audit and metadata",
    ({ results, expected, suppressed }) => {
      const report = {
        version: "2.1.0",
        properties: { audit: "retained" },
        runs: [
          { tool, results, invocations: [{ executionSuccessful: true }] },
          {
            tool,
            results: [],
            invocations: [
              {
                executionSuccessful: false,
                toolExecutionNotifications: [{ level: "error", message: { text: "parse failed" } }],
              },
            ],
          },
        ],
      };
      const audit = JSON.stringify(report);
      const result = project(audit);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(result.auditPath, "utf8")).toBe(audit);
      expect(JSON.parse(fs.readFileSync(result.activePath, "utf8"))).toEqual({
        ...report,
        runs: [{ ...report.runs[0], results: expected }, report.runs[1]],
      });
      expect(result.stdout).toContain(
        `::notice title=OpenGrep upload projection::${expected.length} active findings; ${suppressed} source-suppressed findings.`,
      );
      expect(result.stdout).toContain("workflow SARIF artifact (.opengrep-out/precise.sarif)");
    },
  );

  it("retains pending, rejected, external, unknown and compound suppressions as active risk", () => {
    const suppressions = [
      [{ kind: "inSource", status: "underReview" }],
      [{ kind: "inSource", status: "rejected" }],
      [{ kind: "inSource", status: "unknown" }],
      [{ kind: "inSource", status: null }],
      [{ kind: "external", status: "accepted" }],
      [{ kind: "unknown" }],
      [{ kind: "inSource" }, { kind: "inSource", status: "rejected" }],
    ];
    const retained = suppressions.map((entries) => ({
      ruleId: "fixture",
      message: { text: "retained suppression" },
      suppressions: entries,
    }));
    const accepted = {
      ...suppressedResult,
      suppressions: [{ kind: "inSource", status: "accepted" }],
    };
    const result = project(
      JSON.stringify({ version: "2.1.0", runs: [{ tool, results: [...retained, accepted] }] }),
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(result.activePath, "utf8")).runs[0].results).toEqual(
      retained,
    );
    expect(result.stdout).toContain("7 active findings; 1 source-suppressed findings");
  });

  it.each([
    { name: "missing report", audit: undefined },
    { name: "truncated JSON", audit: '{"version":' },
    { name: "missing runs", audit: '{"version":"2.1.0"}' },
    { name: "missing results", audit: JSON.stringify({ version: "2.1.0", runs: [{ tool }] }) },
    {
      name: "invalid result",
      audit: JSON.stringify({ version: "2.1.0", runs: [{ tool, results: [null] }] }),
    },
    {
      name: "malformed suppressed result",
      audit: JSON.stringify({
        version: "2.1.0",
        runs: [{ tool, results: [{ suppressions: [{ kind: "inSource" }] }] }],
      }),
    },
  ])("fails closed for $name without leaving a stale upload", ({ audit }) => {
    const result = project(audit);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[project-opengrep-sarif] FAILED (exit 1)");
    expect(result.stdout).not.toContain("::notice");
    expect(fs.existsSync(result.activePath)).toBe(false);
    if (audit !== undefined) {
      expect(fs.readFileSync(result.auditPath, "utf8")).toBe(audit);
    }
  });
});
