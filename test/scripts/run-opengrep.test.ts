// Run Opengrep tests cover run opengrep script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
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
  const argUtilsSource = path.resolve("scripts/lib/arg-utils.runtime.mjs");
  writeFile(path.join(repo, "scripts/run-opengrep.sh"), fs.readFileSync(scriptSource, "utf8"));
  writeFile(
    path.join(repo, "scripts/lib/merge-head-diff-base.mjs"),
    fs.readFileSync(helperSource, "utf8"),
  );
  writeFile(
    path.join(repo, "scripts/lib/arg-utils.runtime.mjs"),
    fs.readFileSync(argUtilsSource, "utf8"),
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

type OpengrepWorkflowStep = {
  name: string;
  id?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

function runChangedPathsWorkflow(repo: string, base: string, env: NodeJS.ProcessEnv) {
  const workflow = parse(fs.readFileSync(".github/workflows/opengrep-precise.yml", "utf8"));
  const steps: OpengrepWorkflowStep[] = workflow.jobs.scan.steps;
  const values = new Map([
    ["github.event.pull_request.base.sha", base],
    ["github.event.pull_request.base.ref", "main"],
  ]);
  const output = path.join(repo, "step-output.txt");
  const interpolate = (value: string) =>
    value.replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_match, expression: string) => {
      const resolved = values.get(expression);
      if (resolved === undefined) {
        throw new Error(`Unbound workflow expression: ${expression}`);
      }
      return resolved;
    });
  const renderEnv = (bindings: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(bindings).map(([key, value]) => [key, interpolate(value)]));
  const run = (step: OpengrepWorkflowStep) => {
    let command = step.run;
    let commandEnv = renderEnv(step.env);
    if (step.uses) {
      const actionPath = path.join(repo, step.uses);
      values.set("github.action_path", actionPath);
      for (const [key, value] of Object.entries(step.with ?? {})) {
        values.set(`inputs.${key}`, interpolate(value));
      }
      const action = parse(fs.readFileSync(path.join(actionPath, "action.yml"), "utf8"));
      const actionStep: OpengrepWorkflowStep = action.runs.steps[0];
      command = actionStep.run;
      commandEnv = { ...commandEnv, ...renderEnv(actionStep.env) };
    }
    if (!command) {
      throw new Error(`Workflow step has no executable command: ${step.name}`);
    }
    fs.writeFileSync(output, "");
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", interpolate(command)], {
      cwd: repo,
      env: { ...env, ...commandEnv, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    if (step.id) {
      for (const line of fs.readFileSync(output, "utf8").trim().split("\n")) {
        const separator = line.indexOf("=");
        if (separator >= 0) {
          values.set(
            `steps.${step.id}.outputs.${line.slice(0, separator)}`,
            line.slice(separator + 1),
          );
        }
      }
    }
    return result;
  };
  const ensureIndex = steps.findIndex((step) => step.name === "Ensure PR base commit");
  expect(ensureIndex).toBeGreaterThan(0);
  for (const step of steps.slice(1, ensureIndex + 1)) {
    const result = run(step);
    if (result.status !== 0) {
      return result;
    }
  }
  const scan = steps.find((step) => step.name === "Run opengrep on PR diff");
  if (!scan) {
    throw new Error("Workflow has no scan step");
  }
  return run(scan);
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

  describe("shallow checkout preparation", () => {
    const sourceDirs = useAutoCleanupTempDirTracker(afterAll);
    let source: string;
    let staleBase: string;

    beforeAll(() => {
      source = sourceDirs.make("openclaw-opengrep-source-");
      git(source, "init", "-q", "--initial-branch=main");
      git(source, "config", "user.email", "test@example.com");
      git(source, "config", "user.name", "Test User");
      git(source, "config", "uploadpack.allowFilter", "true");
      copyRunOpengrepFiles(source);
      for (const name of ["ensure-base-commit", "git-owner"]) {
        fs.cpSync(`.github/actions/${name}`, path.join(source, ".github/actions", name), {
          recursive: true,
        });
      }
      writeFile(path.join(source, "security/opengrep/precise.yml"), "rules: []\n");
      git(source, "add", ".");
      git(source, "commit", "-qm", "base");
      staleBase = git(source, "rev-parse", "HEAD");
      git(source, "switch", "-q", "-c", "feature");
      writeFile(path.join(source, "src/pr.ts"), "export const pr = true;\n");
      git(source, "add", ".");
      git(source, "commit", "-qm", "feature");
      git(source, "switch", "-q", "main");
      writeFile(path.join(source, "src/main-only.ts"), "export const mainOnly = true;\n");
      git(source, "add", ".");
      git(source, "commit", "-qm", "main only");
      git(source, "merge", "--no-ff", "feature", "-m", "synthetic merge");
    });

    it.each([
      { shape: "merge", branch: "main", depth: 2, partial: false, passes: true },
      { shape: "partial merge", branch: "main", depth: 2, partial: true, passes: true },
      { shape: "linear", branch: "feature", depth: 2, partial: false, passes: true },
      { shape: "merge without parents", branch: "main", depth: 1, partial: false, passes: false },
      { shape: "linear without base", branch: "feature", depth: 1, partial: false, passes: false },
    ])(
      "prepares and scans a shallow $shape checkout without unrelated base fetches",
      ({ branch, depth, partial, passes }) => {
        const repo = createTempDir("openclaw-opengrep-shallow-");
        git(
          source,
          "clone",
          "--quiet",
          "--no-local",
          `--depth=${depth}`,
          ...(partial ? ["--filter=blob:none"] : []),
          "--branch",
          branch,
          source,
          repo,
        );
        expect(git(repo, "rev-parse", "--is-shallow-repository")).toBe("true");
        if (partial) {
          expect(git(repo, "config", "--get", "remote.origin.promisor")).toBe("true");
        }
        // Probe local storage only: resolving a missing object in a partial clone can fetch it.
        const localObjects = git(
          repo,
          "cat-file",
          "--batch-all-objects",
          "--batch-check=%(objectname)",
        );
        expect(localObjects.split("\n").includes(staleBase)).toBe(
          branch === "feature" && depth === 2,
        );
        const { argsPath, binDir } = installOpengrepStub(repo);
        const trace = path.join(createTempDir("openclaw-opengrep-trace-"), "git.jsonl");
        const result = runChangedPathsWorkflow(repo, staleBase, {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          RUNNER_OS:
            process.platform === "win32"
              ? "Windows"
              : process.platform === "darwin"
                ? "macOS"
                : "Linux",
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_ALLOW_PROTOCOL: "",
          GIT_TRACE2_EVENT: trace,
        });
        const fetches = fs
          .readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((event) => event.event === "cmd_name" && event.name === "fetch");
        if (!passes) {
          expect(result.status, result.stderr).not.toBe(0);
          expect(result.stdout).toContain("Base commit still unavailable");
          expect(fetches).toHaveLength(5);
          expect(fs.existsSync(argsPath)).toBe(false);
          return;
        }
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(fetches).toEqual([]);
        const args = fs.readFileSync(argsPath, "utf8");
        expect(args).toContain("src/pr.ts");
        expect(args).not.toContain("src/main-only.ts");
      },
    );
  });
});

describe("OpenGrep GitHub SARIF uploads", () => {
  it.each(["opengrep-precise.yml", "opengrep-precise-full.yml"])(
    "%s preserves raw evidence and uploads only findings without accepted source suppression",
    (workflowName) => {
      const repo = createTempDir("openclaw-opengrep-sarif-");
      const ignored = [
        { ruleId: "in-source", suppressions: [{ kind: "inSource" }] },
        { ruleId: "accepted", suppressions: [{ kind: "inSource", status: "accepted" }] },
      ];
      const retained = [
        { ruleId: "active" },
        { ruleId: "empty", suppressions: [] },
        { ruleId: "unknown", suppressions: null },
        { ruleId: "external", suppressions: [{ kind: "external", status: "accepted" }] },
        { ruleId: "under-review", suppressions: [{ kind: "inSource", status: "underReview" }] },
        { ruleId: "rejected", suppressions: [{ kind: "inSource", status: "rejected" }] },
        { ruleId: "future-status", suppressions: [{ kind: "inSource", status: "unknown" }] },
        { ruleId: "null-status", suppressions: [{ kind: "inSource", status: null }] },
        { ruleId: "malformed", suppressions: [null] },
        {
          ruleId: "mixed",
          suppressions: [{ kind: "inSource" }, { kind: "inSource", status: "rejected" }],
        },
      ];
      const tool = { driver: { name: "Opengrep OSS", rules: [{ id: "unchanged-rule" }] } };
      const report = {
        version: "2.1.0",
        runs: [
          {
            tool,
            invocations: [{ executionSuccessful: false }],
            results: [...ignored, ...retained],
          },
          { tool, results: [] },
          { tool },
        ],
      };
      const raw = `${JSON.stringify(report, null, 2)}\n`;
      const reportPath = ".opengrep-out/precise.sarif";
      writeFile(path.join(repo, reportPath), raw);
      const workflow = parse(fs.readFileSync(`.github/workflows/${workflowName}`, "utf8"));
      const steps: Array<{
        name: string;
        id?: string;
        run?: string;
        if?: string;
        with?: Record<string, string>;
      }> = workflow.jobs.scan.steps;
      const prepare = steps.find((step) => step.id === "github-sarif");
      if (prepare) {
        writeFile(
          path.join(repo, "scripts/opengrep-github-sarif.mjs"),
          fs.readFileSync("scripts/opengrep-github-sarif.mjs", "utf8"),
        );
        expect(prepare.if).toBe("always() && hashFiles('.opengrep-out/precise.sarif') != ''");
        const prepared = spawnSync("bash", ["-euo", "pipefail", "-c", prepare.run!], {
          cwd: repo,
          encoding: "utf8",
        });
        expect(prepared.status).toBe(0);
        expect(prepared.stderr).toContain(
          "Omitted 2 accepted in-source suppression(s); raw audit: .opengrep-out/precise.sarif",
        );
      }
      const upload = steps.find((step) => step.name === "Upload SARIF to GitHub Code Scanning")!;
      const artifact = steps.find((step) => step.name === "Upload SARIF as workflow artifact")!;
      const uploadPath = upload.with?.sarif_file;
      if (!uploadPath) {
        throw new Error("Workflow must name its SARIF upload payload");
      }
      const uploaded = JSON.parse(fs.readFileSync(path.join(repo, uploadPath), "utf8"));
      expect(uploaded).toEqual({
        ...report,
        runs: [{ ...report.runs[0], results: retained }, ...report.runs.slice(1)],
      });
      expect(upload.if).toBe("always() && steps.github-sarif.outcome == 'success'");
      expect(artifact.with?.path).toBe(reportPath);
      expect(artifact.with?.["if-no-files-found"]).toBe("error");
      expect(fs.readFileSync(path.join(repo, reportPath), "utf8")).toBe(raw);
    },
  );

  it.each(["{", JSON.stringify({ version: "2.1.0", runs: [{ results: "invalid" }] })])(
    "fails malformed reports without emitting an upload payload: %s",
    (raw) => {
      const repo = createTempDir("openclaw-opengrep-sarif-invalid-");
      const inputPath = path.join(repo, "raw.sarif");
      writeFile(inputPath, raw);
      const result = spawnSync(process.execPath, ["scripts/opengrep-github-sarif.mjs", inputPath], {
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trimEnd()).toMatch(/\[opengrep-github-sarif\] FAILED \(exit 1\)$/);
      expect(fs.readFileSync(inputPath, "utf8")).toBe(raw);
    },
  );
});
