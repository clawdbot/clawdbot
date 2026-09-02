import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
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
const localGitEnvironment = {
  GIT_ALLOW_PROTOCOL: "file",
  GIT_CONFIG_COUNT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const localGitCommand = "GIT_ALLOW_PROTOCOL=file GIT_CONFIG_COUNT=0";

function securityJob() {
  const workflow = parse(readFileSync(workflowPath, "utf8")) as {
    jobs: Record<string, { steps: WorkflowStep[] }>;
  };
  const job = workflow.jobs["security-fast"];
  if (!job) {
    throw new Error("security-fast job is missing");
  }
  return job;
}

function securityStep(name: string): WorkflowStep {
  const step = securityJob().steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`security-fast step is missing: ${name}`);
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
  mkdirSync(bin);
  mkdirSync(runnerTemp);

  runGit(repo, "init", "--initial-branch=main");
  runGit(repo, "config", "user.name", "CI Fixture");
  runGit(repo, "config", "user.email", "ci@example.invalid");
  runGit(repo, "commit", "--allow-empty", "-m", "initial");
  const missingPolicySha = runGit(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, ".github", "zizmor.yml"), "rules:\n  trusted-base: {}\n");
  runGit(repo, "add", ".");
  runGit(repo, "commit", "-m", "base policy");
  const baseSha = runGit(repo, "rev-parse", "HEAD");

  writeFileSync(join(repo, ".github", "zizmor.yml"), "rules:\n  candidate-poison: {}\n");
  writeFileSync(
    join(repo, ".pre-commit-config.yaml"),
    "repos:\n  - repo: https://example.invalid/poison.git\n",
  );
  runGit(repo, "add", ".");
  runGit(repo, "commit", "-m", "candidate policy");

  mkdirSync(join(repo, ".ci-harness", ".github"), { recursive: true });
  writeFileSync(
    join(repo, ".ci-harness", ".github", "zizmor.yml"),
    "rules:\n  trusted-harness: {}\n",
  );

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
    repo,
    runnerTemp,
  };
}

function prepareConfig(
  fixture: ReturnType<typeof createFixture>,
  eventName: "pull_request" | "push" | "workflow_dispatch",
  baseSha = fixture.baseSha,
) {
  const result = runStep(securityStep("Prepare trusted scanner config"), fixture.repo, {
    ...fixture.environment,
    BASE_SHA: baseSha,
    GITHUB_EVENT_NAME: eventName,
  });
  return {
    githubEnvironment: readGitHubEnvironment(fixture.githubEnv),
    result,
  };
}

describe("security-fast workflow", () => {
  it("generates the exact local-only scanner contract from trusted policy", () => {
    const job = securityJob();
    const checkoutHarness = securityStep("Checkout trusted CI harness");
    const prepare = securityStep("Prepare trusted scanner config");
    const install = securityStep("Install security scanners");
    const detect = securityStep("Detect committed private keys");
    const zizmor = securityStep("Audit changed GitHub workflows with zizmor");

    expect(checkoutHarness.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(checkoutHarness.with?.["persist-credentials"]).toBe(false);
    expect(checkoutHarness.with?.["sparse-checkout"]).toContain(".github/zizmor.yml");
    expect(job.steps.some((step) => step.name === "Resolve Python runtime")).toBe(false);
    expect(install.run).toContain("python3 --version");
    expect(install.run).toContain("pre-commit==4.6.2 pre-commit-hooks==6.0.0 zizmor==1.29.0");
    expect(prepare.run).not.toMatch(/origin\/|BASE_REF|PRE_COMMIT_CONFIG_PATH:-/u);
    expect(detect.run).toContain(localGitCommand);
    expect(zizmor.run).toContain(localGitCommand);

    const fixture = createFixture();
    const prepared = prepareConfig(fixture, "pull_request");
    expect(prepared.result.status, `${prepared.result.stdout}${prepared.result.stderr}`).toBe(0);
    const configPath = prepared.githubEnvironment.PRE_COMMIT_CONFIG_PATH;
    if (!configPath) {
      throw new Error("scanner config path was not published");
    }
    const config = parse(readFileSync(configPath, "utf8")) as {
      repos: Array<{ hooks: Array<Record<string, unknown>>; repo: string }>;
    };
    expect(config.repos).toEqual([
      {
        repo: "local",
        hooks: [
          {
            id: "detect-private-key",
            name: "detect private key",
            entry: "detect-private-key",
            language: "system",
            types: ["text"],
            exclude: String.raw`(^|/)(\.pre-commit-config\.yaml$|apps/ios/fastlane/Fastfile$|.*\.test\.ts$)`,
          },
          {
            id: "zizmor",
            name: "zizmor",
            entry: "zizmor",
            language: "system",
            types: ["yaml"],
            files: String.raw`(\.github/(workflows/.*|dependabot.ya?ml))|(action\.ya?ml)$`,
            require_serial: true,
            args: [
              "--config",
              join(fixture.runnerTemp, "zizmor.yml"),
              "--persona=regular",
              "--min-severity=medium",
              "--min-confidence=medium",
            ],
            exclude: "^(vendor/|apps/swabble/)",
          },
        ],
      },
    ]);
    expect(readFileSync(join(fixture.runnerTemp, "zizmor.yml"), "utf8")).toBe(
      "rules:\n  trusted-base: {}\n",
    );
    expect(readFileSync(configPath, "utf8")).not.toContain("example.invalid");
  });

  it("fails closed for a missing exact-base policy and trusts the harness otherwise", () => {
    const missing = createFixture();
    const rejected = prepareConfig(missing, "pull_request", missing.missingPolicySha);
    expect(rejected.result.status).not.toBe(0);
    expect(`${rejected.result.stdout}${rejected.result.stderr}`).toContain(
      "trusted zizmor policy unavailable",
    );
    expect(rejected.githubEnvironment).toEqual({});

    for (const eventName of ["push", "workflow_dispatch"] as const) {
      const fixture = createFixture();
      const prepared = prepareConfig(fixture, eventName);
      expect(prepared.result.status, `${prepared.result.stdout}${prepared.result.stderr}`).toBe(0);
      expect(readFileSync(join(fixture.runnerTemp, "zizmor.yml"), "utf8")).toBe(
        "rules:\n  trusted-harness: {}\n",
      );
    }
  });
});
