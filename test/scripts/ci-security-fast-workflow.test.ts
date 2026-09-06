import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  with?: Record<string, unknown>;
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workflowPath = ".github/workflows/ci.yml";
const scannerPath = "scripts/detect-private-keys.mts";
const neuteredScanner = "process.exit(0);\n";
const localGitEnvironment = {
  GIT_ALLOW_PROTOCOL: "file",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const setupPath = resolve(".github/actions/pre-commit/setup-scanners.py");

function scannerJob(file = workflowPath, name = "security-fast") {
  const workflow = parse(readFileSync(file, "utf8")) as {
    jobs: Record<string, { steps: WorkflowStep[] }>;
  };
  const job = workflow.jobs[name];
  if (!job) {
    throw new Error(`scanner job is missing: ${file}/${name}`);
  }
  return job;
}

function scannerStep(name: string, job = scannerJob()): WorkflowStep {
  const step = job.steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`scanner step is missing: ${name}`);
  }
  return step;
}

function writeExecutable(filePath: string, source: string): void {
  writeFileSync(filePath, source, "utf8");
  chmodSync(filePath, 0o755);
}

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...localGitEnvironment },
  }).trim();
}

function runStep(
  step: WorkflowStep,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { status: number | null; stderr: string; stdout: string } {
  if (!step.run) {
    throw new Error(`workflow step has no shell body: ${step.name ?? "unknown"}`);
  }
  const result = spawnSync("bash", ["-euo", "pipefail", "-c", step.run], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...step.env, ...env },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function readGitHubEnvironment(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }
  return Object.fromEntries(
    readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function createFixture() {
  const root = tempDirs.make("openclaw-security-fast-");
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner");
  const githubEnv = join(root, "github-env");
  mkdirSync(join(repo, ".github"), { recursive: true });
  mkdirSync(join(repo, "scripts"));
  mkdirSync(bin);
  mkdirSync(runnerTemp);

  runGit(repo, "init", "--initial-branch=main");
  runGit(repo, "config", "user.name", "CI Fixture");
  runGit(repo, "config", "user.email", "ci@example.invalid");
  runGit(repo, "commit", "--allow-empty", "-m", "initial");
  const missingPolicySha = runGit(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, ".github", "zizmor.yml"), "rules:\n  trusted-base: {}\n");
  const realScanner = readFileSync(resolve(scannerPath));
  writeFileSync(join(repo, scannerPath), realScanner);
  runGit(repo, "add", ".");
  runGit(repo, "commit", "-m", "base policy");
  const baseSha = runGit(repo, "rev-parse", "HEAD");

  // The candidate poisons every input it could: policy, hook config, and the
  // scanner itself, while adding a key the neutered scanner would let through.
  writeFileSync(join(repo, ".github", "zizmor.yml"), "rules:\n  candidate-poison: {}\n");
  writeFileSync(
    join(repo, ".pre-commit-config.yaml"),
    "repos:\n  - repo: https://example.invalid/poison.git\n# BEGIN RSA PRIVATE KEY\n",
  );
  writeFileSync(join(repo, scannerPath), neuteredScanner);
  writeFileSync(join(repo, "leaked.pem"), "-----BEGIN RSA PRIVATE KEY-----\nfixture only\n");
  writeFileSync(
    join(repo, "binary key with spaces.bin"),
    "\0BEGIN RSA PRIVATE KEY\nfixture only\n",
  );
  runGit(repo, "add", ".");
  runGit(repo, "commit", "-m", "candidate policy");

  mkdirSync(join(repo, ".ci-harness", ".github"), { recursive: true });
  mkdirSync(join(repo, ".ci-harness", "scripts"), { recursive: true });
  writeFileSync(
    join(repo, ".ci-harness", ".github", "zizmor.yml"),
    "rules:\n  trusted-harness: {}\n",
  );
  writeFileSync(join(repo, ".ci-harness", scannerPath), realScanner);

  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  writeExecutable(
    join(bin, "git"),
    `#!/bin/sh
skip_value=0
command=
for arg in "$@"; do
  if [ "$skip_value" = 1 ]; then
    skip_value=0
    continue
  fi
  case "$arg" in
    -c|-C|--config-env|--exec-path|--git-dir|--namespace|--work-tree)
      skip_value=1
      ;;
    -*)
      ;;
    *)
      command="$arg"
      break
      ;;
  esac
done
case "$command" in
  clone|fetch|ls-remote)
    echo "network Git is forbidden in security-fast" >&2
    exit 97
    ;;
esac
exec "$OPENCLAW_TEST_REAL_GIT" "$@"
`,
  );

  return {
    baseSha,
    environment: {
      GITHUB_ENV: githubEnv,
      OPENCLAW_TEST_REAL_GIT: realGit,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      RUNNER_TEMP: runnerTemp,
    },
    githubEnv,
    missingPolicySha,
    realScanner,
    repo,
    runnerTemp,
  };
}

function preparePolicy(
  fixture: ReturnType<typeof createFixture>,
  eventName: "pull_request" | "push" | "workflow_dispatch",
  baseSha = fixture.baseSha,
) {
  const result = runStep(scannerStep("Prepare trusted scanner policy"), fixture.repo, {
    ...fixture.environment,
    BASE_SHA: baseSha,
    GITHUB_EVENT_NAME: eventName,
  });
  return {
    githubEnvironment: readGitHubEnvironment(fixture.githubEnv),
    result,
  };
}

describe("CI security scanners", () => {
  it.each([0, 1, 2, 3, 130])(
    "propagates audit exit %s in ordinary and scheduled CI",
    (auditExit) => {
      const repo = tempDirs.make("openclaw-audit-ci-");
      mkdirSync(join(repo, "scripts", "pre-commit"), { recursive: true });
      writeFileSync(
        join(repo, "scripts", "pre-commit", "pnpm-audit-prod.mjs"),
        `process.exit(${auditExit});\n`,
      );
      const result = runStep(scannerStep("Audit production dependencies"), repo, {});
      expect(result.status).toBe(auditExit);
      expect(result.stdout).toBe("");
      const scheduled = parse(readFileSync(".github/workflows/dependency-audit.yml", "utf8")) as {
        jobs: { audit: { steps: WorkflowStep[] } };
      };
      const strictStep = scheduled.jobs.audit.steps.find(
        (step) => step.name === "Audit production dependencies",
      );
      if (!strictStep) {
        throw new Error("scheduled production audit step is missing");
      }
      const summary = join(repo, "summary.md");
      const strict = runStep(strictStep, repo, { GITHUB_STEP_SUMMARY: summary });
      expect(strict.status).toBe(auditExit);
      expect(readFileSync(summary, "utf8")).toContain("Triage owner: @steipete");
    },
  );

  it("uses the exact base policy and rejects a missing policy instead of trusting the candidate", () => {
    const fixture = createFixture();
    const prepared = preparePolicy(fixture, "pull_request");
    expect(prepared.result.status, prepared.result.stdout + prepared.result.stderr).toBe(0);
    expect(readFileSync(join(fixture.runnerTemp, "zizmor.yml"), "utf8")).toBe(
      "rules:\n  trusted-base: {}\n",
    );
    const job = scannerJob();
    const detect = scannerStep("Detect committed private keys", job);
    const install = scannerStep("Install security scanners", job);
    const prepare = scannerStep("Prepare trusted scanner policy", job);
    expect(prepare.run).not.toMatch(/origin\/|BASE_REF|PRE_COMMIT_CONFIG_PATH:-/u);
    expect(scannerStep("Checkout trusted CI harness", job).with?.["sparse-checkout"]).toContain(
      scannerPath,
    );
    expect(detect.run).toBe('node "$PRIVATE_KEY_SCANNER_PATH"');
    expect(job.steps.indexOf(scannerStep("Setup Node.js", job))).toBeLessThan(
      job.steps.indexOf(detect),
    );
    expect(job.steps.indexOf(detect)).toBeLessThan(job.steps.indexOf(install));
    const trustedScanner = join(fixture.runnerTemp, "detect-private-keys.mts");
    expect(prepared.githubEnvironment).toEqual({ PRIVATE_KEY_SCANNER_PATH: trustedScanner });
    expect(readFileSync(trustedScanner)).toEqual(fixture.realScanner);
    const scanned = runStep(detect, fixture.repo, {
      ...fixture.environment,
      ...prepared.githubEnvironment,
    });
    expect(scanned.status).toBe(1);
    expect(scanned.stderr).toContain("Private key found: leaked.pem (BEGIN RSA PRIVATE KEY)");
    expect(scanned.stderr).toContain(
      "Private key found: .pre-commit-config.yaml (BEGIN RSA PRIVATE KEY)",
    );
    expect(scanned.stderr).toContain(
      "Private key found: binary key with spaces.bin (BEGIN RSA PRIVATE KEY)",
    );
    expect(scanned.stderr).toContain("[detect-private-keys] FAILED (exit 1)");

    const missing = createFixture();
    const rejected = preparePolicy(missing, "pull_request", missing.missingPolicySha);
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.result.stdout + rejected.result.stderr).toContain(
      "trusted zizmor policy unavailable",
    );
    expect(rejected.githubEnvironment).toEqual({});
  });

  it.each(["push", "workflow_dispatch"] as const)(
    "uses workflow-harness policy on %s",
    (eventName) => {
      const fixture = createFixture();
      const prepared = preparePolicy(fixture, eventName);
      expect(prepared.result.status, prepared.result.stdout + prepared.result.stderr).toBe(0);
      expect(readFileSync(join(fixture.runnerTemp, "zizmor.yml"), "utf8")).toBe(
        "rules:\n  trusted-harness: {}\n",
      );
      expect(readFileSync(join(fixture.runnerTemp, "detect-private-keys.mts"))).toEqual(
        fixture.realScanner,
      );
    },
  );

  it.each([
    { failAt: 0, childCode: 0, expectedCode: 0 },
    { failAt: 1, childCode: 23, expectedCode: 23 },
    { failAt: 2, childCode: 17, expectedCode: 17 },
    { failAt: 2, childCode: -15, expectedCode: 143 },
  ])(
    "publishes local hooks only after isolated setup succeeds ($failAt, $childCode)",
    ({ failAt, childCode, expectedCode }) => {
      const fixture = createFixture();
      const policy = join(fixture.repo, ".ci-harness/.github/zizmor.yml");
      // Exercise the real helper without installing packages in unit tests. Actual
      // scanner fixtures separately prove imports and pre-commit filtering.
      const probe = String.raw`
import json, os, runpy, shlex, subprocess, sys
from pathlib import Path
from unittest.mock import patch
source, policy, fail_at, child_code = sys.argv[1:]
calls = []
def install(command, *, check):
    assert check
    calls.append(command)
    if len(calls) == int(fail_at):
        raise subprocess.CalledProcessError(int(child_code), command)
sys.argv = [source, policy]
try:
    with patch("subprocess.run", side_effect=install):
        runpy.run_path(source, run_name="__main__")
finally:
    config = Path(os.environ["RUNNER_TEMP"]) / "security-scanners-pre-commit.yaml"
    entries = []
    if config.exists():
        hooks = json.loads(config.read_text())["repos"][0]["hooks"]
        entries = [shlex.split(hook["entry"]) for hook in hooks]
    print(json.dumps({"calls": calls, "interpreter": sys.executable, "entries": entries}))
`;
      for (const name of [
        "subprocess.py",
        "sitecustomize.py",
        "json.py",
        "platform.py",
        "venv.py",
        "pip.py",
        "yaml.py",
        "pre_commit.py",
      ]) {
        writeFileSync(join(fixture.repo, name), "raise RuntimeError('candidate import')\n");
      }
      const result = spawnSync(
        "python3",
        ["-I", "-c", probe, setupPath, policy, String(failAt), String(childCode)],
        {
          cwd: fixture.repo,
          encoding: "utf8",
          env: { ...process.env, ...fixture.environment, PYTHONPATH: fixture.repo },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(expectedCode);
      const receipt = JSON.parse(result.stdout) as {
        calls: string[][];
        interpreter: string;
        entries: string[][];
      };
      const venv = join(fixture.runnerTemp, "pre-commit-venv");
      const python = join(venv, "bin/python");
      const commands = [
        [receipt.interpreter, "-I", "-m", "venv", venv],
        [
          python,
          "-I",
          "-m",
          "pip",
          "install",
          "--disable-pip-version-check",
          "pre-commit==4.6.2",
          "zizmor==1.29.0",
        ],
      ];
      expect(receipt.calls).toEqual(commands.slice(0, failAt || 2));
      const environment = readGitHubEnvironment(fixture.githubEnv);
      if (expectedCode !== 0) {
        expect(environment).toEqual({});
        expect(receipt.entries).toEqual([]);
        expect(result.stderr.endsWith(`[setup-scanners] FAILED (exit ${expectedCode})\n`)).toBe(
          true,
        );
        return;
      }
      const configPath = environment.PRE_COMMIT_CONFIG_PATH;
      if (!configPath) {
        throw new Error("scanner config path was not published");
      }
      const config = parse(readFileSync(configPath, "utf8")) as {
        repos: {
          repo: string;
          hooks: { id: string; args: string[]; files: string; exclude: string }[];
        }[];
      };
      expect(config.repos.map(({ repo }) => repo)).toEqual(["local"]);
      expect(config.repos[0]?.hooks.map(({ id }) => id)).toEqual(["zizmor"]);
      expect(receipt.entries).toEqual([[join(venv, "bin/zizmor")]]);
      const hook = config.repos[0]!.hooks[0]!;
      expect(hook).toMatchObject({ language: "system", types: ["yaml"], require_serial: true });
      const targets = [
        ".github/workflows/ci.yml",
        ".github/dependabot.yaml",
        "custom/action.yml",
        ".github/actions/inner/action.yaml",
      ];
      expect(
        [...targets, "vendor/action.yml", "apps/swabble/action.yaml", "notes/plain.yaml"].filter(
          (file) => new RegExp(hook.files).test(file) && !new RegExp(hook.exclude).test(file),
        ),
      ).toEqual(targets);
      expect(hook.args).toEqual([
        "--config",
        policy,
        "--persona=regular",
        "--min-severity=medium",
        "--min-confidence=medium",
      ]);
    },
  );

  it("keeps both workflows on the trusted setup and their original scan targets", () => {
    const fixture = createFixture();
    const changed = [".github/workflows/changed.yml", ".github/workflows/with space.yaml"];
    const all = [...changed, ".github/workflows/unchanged.yml"].toSorted();
    mkdirSync(join(fixture.repo, ".github/workflows"));
    for (const file of all) {
      writeFileSync(join(fixture.repo, file), "name: original\n");
    }
    runGit(fixture.repo, "add", ".github/workflows");
    runGit(fixture.repo, "commit", "-m", "workflow base");
    const baseSha = runGit(fixture.repo, "rev-parse", "HEAD");
    for (const file of changed) {
      writeFileSync(join(fixture.repo, file), "name: changed\n");
    }
    runGit(fixture.repo, "add", ".github/workflows");
    runGit(fixture.repo, "commit", "-m", "workflow changes");
    const python = join(fixture.runnerTemp, "pre-commit-venv/bin/python");
    mkdirSync(join(fixture.runnerTemp, "pre-commit-venv/bin"), { recursive: true });
    const invocation = join(fixture.runnerTemp, "invocation");
    writeExecutable(
      python,
      '#!/bin/sh\nprintf "%s\\n" "$0" "$GIT_ALLOW_PROTOCOL" "$GIT_CONFIG_COUNT" "$@" > "$INVOCATION_RECEIPT"\nexit "${SCANNER_EXIT:-0}"\n',
    );
    const bin = join(fixture.repo, "fixture-bin");
    mkdirSync(bin);
    writeExecutable(
      join(bin, "python3"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$INVOCATION_RECEIPT"\n',
    );
    const config = join(fixture.runnerTemp, "security-scanners-pre-commit.yaml");
    const environment = {
      ...fixture.environment,
      BASE_SHA: baseSha,
      PRE_COMMIT_CONFIG_PATH: config,
      PATH: `${bin}${delimiter}${fixture.environment.PATH}`,
      INVOCATION_RECEIPT: invocation,
    };
    const security = scannerJob();
    const sanity = scannerJob(".github/workflows/workflow-sanity.yml", "actionlint");
    for (const job of [security, sanity]) {
      const harness = scannerStep("Checkout trusted CI harness", job);
      const setup = scannerStep("Install security scanners", job);
      expect(harness.with).toMatchObject({
        ref: "${{ github.workflow_sha }}",
        "persist-credentials": false,
      });
      expect(harness.with?.["sparse-checkout"]).toContain(".github/zizmor.yml");
      expect(job.steps.indexOf(harness)).toBeLessThan(job.steps.indexOf(setup));
      for (const event of ["pull_request", "push"]) {
        const result = runStep(setup, fixture.repo, { ...environment, GITHUB_EVENT_NAME: event });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(readFileSync(invocation, "utf8").trim().split("\n")).toEqual([
          "-I",
          ".ci-harness/.github/actions/pre-commit/setup-scanners.py",
          job === security
            ? join(fixture.runnerTemp, "zizmor.yml")
            : event === "pull_request"
              ? join(fixture.runnerTemp, "zizmor-base.yml")
              : ".ci-harness/.github/zizmor.yml",
        ]);
      }
    }
    for (const [job, name, selection] of [
      [security, "Audit changed GitHub workflows with zizmor", ["zizmor", "--files", ...changed]],
      [sanity, "Audit all workflows with zizmor", ["zizmor", "--files", ...all]],
    ] as const) {
      const step = scannerStep(name, job);
      expect(job.steps.indexOf(scannerStep("Install security scanners", job))).toBeLessThan(
        job.steps.indexOf(step),
      );
      for (const code of [0, 7]) {
        const result = runStep(step, fixture.repo, { ...environment, SCANNER_EXIT: String(code) });
        expect(result.status, result.stdout + result.stderr).toBe(code);
        expect(readFileSync(invocation, "utf8").trim().split("\n")).toEqual([
          python,
          "file",
          "0",
          "-I",
          "-m",
          "pre_commit",
          "run",
          "--config",
          config,
          ...selection,
        ]);
      }
    }
  });

  it("fails closed when the exact base has no scanner instead of running the candidate copy", () => {
    const fixture = createFixture();
    // A base with the policy but not the scanner: the bootstrap gap a
    // candidate could otherwise exploit with a neutered scanner.
    writeFileSync(join(fixture.repo, ".github", "zizmor.yml"), "rules:\n  trusted-base: {}\n");
    runGit(fixture.repo, "rm", "-q", "--cached", scannerPath);
    runGit(fixture.repo, "add", ".github/zizmor.yml");
    runGit(fixture.repo, "commit", "-m", "base without scanner");
    const rejected = preparePolicy(
      fixture,
      "pull_request",
      runGit(fixture.repo, "rev-parse", "HEAD"),
    );
    expect(rejected.result.status).not.toBe(0);
    expect(`${rejected.result.stdout}${rejected.result.stderr}`).toContain(
      "trusted private-key scanner unavailable",
    );
    expect(rejected.githubEnvironment).toEqual({});
    expect(existsSync(join(fixture.runnerTemp, "detect-private-keys.mts"))).toBe(false);
  });
});
