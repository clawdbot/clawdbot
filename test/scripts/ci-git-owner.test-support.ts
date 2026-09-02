import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { parse } from "yaml";
import {
  ciCheckoutFixture,
  expectCiCheckoutCleanup,
  readCiCheckoutStep,
  renderGitTestClock,
  withCiCheckoutFixture,
} from "./ci-checkout.test-support.js";
import {
  prepareGeneratedPublisherFixture,
  type GeneratedPublisherOptions,
} from "./generated-publisher.test-support.js";
import {
  preparePerformanceFixture,
  type PerformanceFixtureOptions,
} from "./openclaw-performance-workflow.test-support.js";

type Step = {
  name?: string;
  run?: string;
  env?: Record<string, string | number>;
  "working-directory"?: string;
};
type WorkflowTarget = { file: string; job: string; step: string };
export type FetchResult = number | "hang" | "cleanup-failure";

const candidate = "a".repeat(40);
const harness = "b".repeat(40);
const base = "c".repeat(40);
const moved = "d".repeat(40);
const merge = "e".repeat(40);
const defaults: Record<string, string> = {
  CHECKOUT_REPO: "fixture/checkout",
  CHECKOUT_TOKEN: "",
  CHECKOUT_REF: candidate,
  CHECKOUT_SHA: candidate,
  CHECKOUT_FALLBACK_REF: candidate,
  CHECKOUT_EVENT_REF: "refs/heads/main",
  WORKFLOW_SHA: harness,
  CHECKOUT_GIT_COMMITS_JSON: "null",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REPOSITORY: "fixture/checkout",
  DEFAULT_BRANCH: "main",
  EVENT_BASE_SHA: base,
  GH_TOKEN: "",
  PULL_REQUEST_NUMBER: "17",
  TARGET_SHA: candidate,
  RELEASE_GATE: "false",
  FROZEN_TARGET: "false",
  HISTORICAL_TARGET: "false",
  FORMAT_CHECK: "false",
  RUN_CONTROL_UI_I18N: "false",
  RUN_UI_TESTS: "false",
  HOSTED_RUNNER_STRIPES: "false",
  RUNNER_PROFILE: "github",
  PR_BASE_SHA: base,
  DIFF_BASE_SHA: base,
  PROTOCOL_SINCE_BASE_SHA: base,
  RATCHET_PR_HEAD_SHA: candidate,
};

function stepEnvironment(step: Step, supplied: Record<string, string>) {
  const resolved = { ...defaults, ...supplied };
  for (const [key, value] of Object.entries(step.env ?? {})) {
    if (String(value).startsWith("${{")) {
      if (resolved[key] === undefined) {
        throw new Error(`Unresolved fixture workflow environment: ${key}`);
      }
    } else {
      resolved[key] = String(value);
    }
  }
  return resolved;
}

function readWorkflowStep({ file, job, step: name }: WorkflowTarget): Step & { run: string } {
  const parsed = parse(readFileSync(file, "utf8")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const step = parsed.jobs[job]?.steps.find((entry) => entry.name === name);
  if (!step?.run) {
    throw new Error(`Missing executable workflow step ${file}/${job}/${name}`);
  }
  return { ...step, run: step.run };
}

export async function runCiGitStep(options: {
  workflow?: "workflow-sanity" | WorkflowTarget;
  job?: string;
  action?:
    | "ensure-base-commit"
    | "git-owner"
    | "mantis-validate-trusted-ref"
    | "publish-generated-pr";
  performance?: PerformanceFixtureOptions;
  publisher?: GeneratedPublisherOptions & { baseChangePath?: "a" | "b" | null };
  gitFault?: { match: string; occurrence?: number; code: FetchResult | "cancel"; output?: string };
  gitFaults?: {
    match: string;
    occurrence?: number;
    code: FetchResult | "cancel";
    output?: string;
  }[];
  policy?: string;
  inlinePolicy?: boolean;
  step?: string;
  stepOutputs?: Record<string, Record<string, string>>;
  env?: Record<string, string>;
  fetchResults: FetchResult[];
  cloneResults?: FetchResult[];
  worktreeResults?: FetchResult[];
  rebaseResults?: FetchResult[];
  pushResults?: FetchResult[];
  revParseResult?: FetchResult;
  diffResult?: number;
  commandResults?: Record<string, { code: FetchResult; output?: string }>;
  workflowRuns?: {
    id: number;
    created_at: string;
    status: string;
    conclusion: string | null;
    head_sha: string;
  }[];
  publishPath?: "directory" | "file" | "symlink";
  checkoutResults?: number[];
  mergeSnapshots?: { sha: string; head: string }[];
  prepare?: boolean;
  cancelDuringCleanup?: boolean;
  cleanupCancelMatch?: string;
  startupDelay?: { tree: number };
  revisions?: Record<string, string>;
  mergeBase?: { ancestor: boolean; revision: string };
  poisonPython?: boolean;
  baseAvailableAfter?: number;
  invalidRef?: boolean;
  scenario?: string;
  lsRemoteResults?: { output: string; code: number | "hang" | "cleanup-failure" }[];
  realClock?: boolean;
  realDrain?: boolean;
  objects?: Record<string, { probe?: number; code?: number; text: string }>;
  cooperativeTrees?: boolean;
  cancelDuringBackoff?: boolean;
  setupFailure?: "owner" | "python" | "git";
}) {
  const maturity =
    typeof options.workflow === "object" &&
    options.workflow.file === ".github/workflows/maturity-scorecard.yml";
  const docsPublish =
    typeof options.workflow === "object" &&
    options.workflow.file === ".github/workflows/docs-sync-publish.yml";
  const docsAgent =
    typeof options.workflow === "object" &&
    options.workflow.file === ".github/workflows/docs-agent.yml";
  const releaseAdmission =
    typeof options.workflow === "object" &&
    [
      ".github/workflows/linux-app-release.yml",
      ".github/workflows/macos-release.yml",
      ".github/workflows/npm-placeholder-bootstrap.yml",
    ].includes(options.workflow.file);
  const pluginRelease =
    typeof options.workflow === "object" &&
    [
      ".github/workflows/plugin-clawhub-release.yml",
      ".github/workflows/plugin-npm-release.yml",
    ].includes(options.workflow.file);
  const publisher = options.action === "publish-generated-pr";
  const externalOwner =
    options.workflow || options.action === "mantis-validate-trusted-ref" || publisher;
  const clock = {
    ...options,
    realDrain:
      options.cancelDuringCleanup || options.scenario?.startsWith("cancel-") || options.realDrain,
  };
  const step: (Step & { run: string }) | undefined = options.action
    ? (
        parse(readFileSync(`.github/actions/${options.action}/action.yml`, "utf8")) as {
          runs: { steps: (Step & { run: string })[] };
        }
      ).runs.steps.find((entry) => (options.step ? entry.name === options.step : entry.run))
    : options.workflow
      ? readWorkflowStep(
          options.workflow === "workflow-sanity"
            ? {
                file: ".github/workflows/workflow-sanity.yml",
                job: "actionlint",
                step: "Prepare trusted workflow audit configs",
              }
            : options.workflow,
        )
      : readCiCheckoutStep(
          options.job ?? "security-fast",
          options.step ?? (options.job ? "Checkout" : "Prepare Git owner"),
        );
  if (!step?.run) {
    throw new Error("Missing executable action step");
  }
  let env: Record<string, string>;
  let performanceFixture: ReturnType<typeof preparePerformanceFixture> | undefined;
  let publisherFixture: ReturnType<typeof prepareGeneratedPublisherFixture> | undefined;
  return withCiCheckoutFixture(
    `linux:${options.scenario ?? "configured"}`,
    (root) => {
      const actions = path.join(root, "trusted-actions");
      if (options.performance) {
        performanceFixture = preparePerformanceFixture(root, options.performance);
      }
      env = stepEnvironment(step, {
        PUBLISH_ACTION_PATH: path.resolve(".github/actions/publish-generated-pr"),
        CONTENTS_TOKEN: "fixture-contents",
        HEAD_BRANCH: "automation/locale",
        BASE_BRANCH: "main",
        COMMIT_MESSAGE: "fixture",
        PR_TITLE: "fixture",
        PR_BODY: "fixture",
        GENERATED_PATHS: "generated",
        INVALIDATION_PATHS: "source",
        OVERLAP_POLICY: "defer",
        AUTO_MERGE: "false",
        BASE_SHA: base,
        BASE_REF: "main",
        FETCH_REF: "fixture-base",
        BASE_ACTION_PATH: path.join(actions, "ensure-base-commit"),
        OWNER_ACTION_PATH: path.join(actions, "git-owner"),
        ...performanceFixture?.env,
        ...options.env,
      });
      const workspace = path.join(root, "workspace");
      if (publisher) {
        publisherFixture = prepareGeneratedPublisherFixture(
          root,
          options.publisher?.baseChangePath ?? null,
          options.publisher,
          "workspace",
        );
        env = {
          ...env,
          ...publisherFixture.env,
          ...options.env,
          PUBLISH_ACTION_PATH: path.resolve(".github/actions/publish-generated-pr"),
          GITHUB_STEP_SUMMARY: path.join(root, "github-summary"),
          FAKE_REAL_GIT: execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
        };
        delete env.PATH;
      }
      if (docsAgent) {
        env.GITHUB_TOKEN = "fixture-docs-agent-token";
        env.GH_TOKEN = "";
      }
      if (docsPublish) {
        env.GITHUB_SHA = candidate;
        // Never let a caller's credential reach fixture command reports.
        env.OPENCLAW_DOCS_SYNC_TOKEN = "fixture-docs-token";
        mkdirSync(path.join(workspace, "clawhub-source/.git"), { recursive: true });
        const publish = path.join(workspace, "publish");
        if (options.publishPath === "file") {
          writeFileSync(publish, "previous publish path\n");
        } else if (options.publishPath === "symlink") {
          symlinkSync(root, publish, "junction");
        } else if (options.publishPath === "directory") {
          mkdirSync(publish);
          writeFileSync(path.join(publish, ".previous-checkout"), "stale\n");
        }
      }
      if (externalOwner) {
        // Workflow bodies follow actions/checkout; selected-source bootstrap must
        // still create its own directory, while later selected steps inherit one.
        for (const directory of [
          workspace,
          ...(!publisher && step["working-directory"]
            ? [path.join(workspace, step["working-directory"])]
            : []),
        ]) {
          mkdirSync(path.join(directory, ".git"), { recursive: true });
          writeFileSync(path.join(directory, ".git/preexisting.lock"), "not invocation-owned\n");
        }
        if (pluginRelease) {
          writeFileSync(path.join(workspace, "package.json"), '{"version":"2026.8.33"}\n');
        }
      }
      if (options.startupDelay?.tree) {
        writeFileSync(
          path.join(root, "tree-start-delay-1.json"),
          String(options.startupDelay.tree),
        );
      }
      for (const action of ["git-owner", "ensure-base-commit"]) {
        mkdirSync(path.join(actions, action), { recursive: true });
        const name = action === "git-owner" ? "owner.py" : "policy.py";
        let source = renderGitTestClock(
          readFileSync(`.github/actions/${action}/${name}`, "utf8"),
          clock,
        );
        if (
          action === "git-owner" &&
          (publisher || maturity || pluginRelease || releaseAdmission || options.performance)
        ) {
          source = source.replace(
            "def main():",
            `def fixture_file_boundary(event, args):
    names = {os.environ["GITHUB_OUTPUT"]: "output", os.environ["GITHUB_STEP_SUMMARY"]: "summary",
             os.environ["GITHUB_ENV"]: "environment",
             os.path.join(os.environ["RUNNER_TEMP"], "generated-pr-push.log"): "push-log"}
    if event == "open" and args[0] in names:
        subprocess.run([${JSON.stringify(process.execPath)}, ${JSON.stringify(ciCheckoutFixture)},
                        "observe", os.environ["TMPDIR"], "linux:configured", names[args[0]]], check=True)

sys.addaudithook(fixture_file_boundary)


def main():`,
          );
        }
        if (action === "git-owner" && options.performance) {
          source = source.replace(
            "def backoff(seconds):",
            `def backoff(seconds):
    subprocess.run([${JSON.stringify(process.execPath)}, ${JSON.stringify(ciCheckoutFixture)},
                    "observe", os.environ["TMPDIR"], "linux:configured", "backoff"], check=True)`,
          );
        }
        writeFileSync(path.join(actions, action, name), source);
      }
      if (publisher) {
        mkdirSync(path.join(actions, "publish-generated-pr"), { recursive: true });
        writeFileSync(
          path.join(actions, "publish-generated-pr/policy.py"),
          renderGitTestClock(
            readFileSync(".github/actions/publish-generated-pr/policy.py", "utf8"),
            clock,
          ),
        );
        env.PUBLISH_ACTION_PATH = path.join(actions, "publish-generated-pr");
      }
      const protectedFile = path.join(
        env.CHECKOUT_KIND === "clawhub" ? workspace : root,
        "protected",
      );
      writeFileSync(protectedFile, "not checkout-owned\n");
      if (["android", "clawhub"].includes(env.CHECKOUT_KIND ?? "")) {
        const checkout =
          env.CHECKOUT_KIND === "clawhub" ? path.join(workspace, "clawhub-source") : workspace;
        mkdirSync(checkout, { recursive: true });
        writeFileSync(path.join(checkout, ".previous-checkout"), "stale\n");
      }
      if (options.poisonPython) {
        env.PYTHONPATH = workspace;
        const poison = `from pathlib import Path\nPath(${JSON.stringify(path.join(root, "python-injected"))}).write_text("injected")\nraise RuntimeError("candidate Python startup executed")\n`;
        for (const name of ["sitecustomize.py", "subprocess.py"]) {
          writeFileSync(path.join(workspace, name), poison);
        }
      }
      const revisions = {
        HEAD: candidate,
        "refs/heads/main": moved,
        "refs/pull/17/merge": merge,
        "refs/remotes/origin/release-gate-merge^1": base,
        "refs/remotes/origin/release-gate-merge^2": candidate,
        ...options.revisions,
      };
      writeFileSync(
        path.join(root, "fixture-options.json"),
        JSON.stringify({
          env,
          publisher: publisherFixture
            ? { git: env.FAKE_REAL_GIT, gh: path.join(publisherFixture.fakeBin, "gh") }
            : undefined,
          performance: performanceFixture?.proxy,
          gitFault: options.gitFault,
          gitFaults: options.gitFaults,
          revisions,
          mergeBase: options.mergeBase,
          workingDirectory: publisher ? undefined : step["working-directory"],
          fetchResults: options.fetchResults,
          cloneResults: options.cloneResults,
          worktreeResults: options.worktreeResults,
          rebaseResults: options.rebaseResults,
          pushResults: options.pushResults,
          revParseResult: options.revParseResult,
          diffResult: options.diffResult,
          commandResults: options.commandResults,
          workflowRuns: options.workflowRuns,
          docsAgent,
          docsPublish,
          maturity,
          pluginRelease,
          releaseAdmission,
          checkoutResults: options.checkoutResults,
          mergeSnapshots: options.mergeSnapshots,
          consumers: Boolean(options.prepare || externalOwner),
          cancelDuringCleanup: options.cancelDuringCleanup,
          cleanupCancelMatch: options.cleanupCancelMatch,
          baseAvailableAfter: options.baseAvailableAfter,
          invalidRef: options.invalidRef,
          lsRemoteResults: options.lsRemoteResults,
          objects: options.objects,
          cooperativeTrees: options.cooperativeTrees,
          cancelDuringBackoff: options.cancelDuringBackoff,
          setupFailure: options.setupFailure,
        }),
      );
      let run = renderGitTestClock(step.run, clock);
      for (const [stepId, outputs] of Object.entries(options.stepOutputs ?? {})) {
        for (const [name, value] of Object.entries(outputs)) {
          run = run.replaceAll(`\${{ steps.${stepId}.outputs.${name} }}`, value);
        }
      }
      if (externalOwner) {
        const prepare = parse(readFileSync(".github/actions/git-owner/action.yml", "utf8")) as {
          runs: { steps: { run?: string }[] };
        };
        const prepareRun = prepare.runs.steps[0]?.run;
        if (!prepareRun) {
          throw new Error("Missing Git owner preparation body");
        }
        writeFileSync(path.join(root, "prepare.sh"), prepareRun);
        // Model the runner's environment handoff, not shell evaluation of paths with spaces.
        run = `bash --noprofile --norc -eo pipefail "$TMPDIR/prepare.sh"
export CI_GIT_OWNER
CI_GIT_OWNER="$(sed -n 's/^CI_GIT_OWNER=//p' "$GITHUB_ENV")"
: > "$GITHUB_ENV"
: > "$GITHUB_OUTPUT"
${options.setupFailure === "owner" ? 'rm "$CI_GIT_OWNER"' : ""}
${run}`;
      }
      if (options.policy) {
        const policy = path.join(root, "policy.py");
        writeFileSync(policy, options.policy);
        run =
          'unset RUNNER_OS GITHUB_WORKSPACE RUNNER_TEMP\nexec python3 -I -S "$OWNER_ACTION_PATH/owner.py" --policy ' +
          (options.inlinePolicy ? '- < "$TMPDIR/policy.py"' : '"$TMPDIR/policy.py"');
      }
      if (options.prepare) {
        const prepare = readCiCheckoutStep("security-fast", "Prepare Git owner");
        const prepareEnv = stepEnvironment(prepare, {});
        writeFileSync(path.join(root, "prepare.sh"), renderGitTestClock(prepare.run, clock));
        // Run the actual prepare body in its own shell: its exec must not replace the caller.
        run = `CHECKOUT_KIND=${prepareEnv.CHECKOUT_KIND} bash --noprofile --norc -eo pipefail "$TMPDIR/prepare.sh"\n${run}`;
      }
      if (options.performance) {
        const mapfileShim =
          options.performance.mode === "prepare"
            ? `if ! type mapfile >/dev/null 2>&1; then
  mapfile() {
    local delimiter=$'\\n'
    if [[ "\${1:-}" == "-d" ]]; then delimiter="$2"; shift 2; fi
    local destination="$1" item quoted index=0
    eval "$destination=()"
    while IFS= read -r -d "$delimiter" item; do
      printf -v quoted '%q' "$item"
      eval "$destination[$index]=$quoted"
      index=$((index + 1))
    done
  }
fi
`
            : "";
        // Observe immediately after each owner invocation; Python policies separately
        // expose output/summary writes through the audit hook, and exit is always censused.
        run = `${mapfileShim}performance_owner_pending=false
performance_owner_boundary() {
  local command="$1"
  if [[ "$performance_owner_pending" == "true" ]]; then
    ${JSON.stringify(process.execPath)} ${JSON.stringify(ciCheckoutFixture)} observe "$TMPDIR" linux:configured shell-command
    performance_owner_pending=false
  fi
  if [[ "$command" == *CI_GIT_OWNER* ]]; then performance_owner_pending=true; fi
}
trap 'performance_owner_boundary "$BASH_COMMAND"' DEBUG
${run}`;
      }
      writeFileSync(path.join(root, "checkout.sh"), run);
    },
    (report, result, stderr, root) => {
      const workspace = path.join(root, "workspace");
      const protectedFile = path.join(
        env.CHECKOUT_KIND === "clawhub" ? workspace : root,
        "protected",
      );
      const actions = path.join(root, "trusted-actions");
      console.log(
        `${typeof options.workflow === "object" ? `${options.workflow.file}/${options.workflow.job}/${options.workflow.step}` : `${options.workflow ?? options.action ?? options.job}/${options.step ?? "Checkout"}`}: ${JSON.stringify(report)}`,
      );
      expect(result, `${stderr}\n${report.error ?? ""}`).toEqual({ code: 0, signal: null });
      expect(report.error, stderr).toBeUndefined();
      expectCiCheckoutCleanup(report);
      if (docsAgent) {
        expect(
          readdirSync(path.join(root, "temp")).filter((name) => name.startsWith("docs-agent-")),
        ).toEqual([]);
      }
      if (externalOwner) {
        for (const directory of new Set([
          workspace,
          ...report.commands
            .filter(({ tool, args }) => tool === "git" && args[0] === "fetch")
            .map(({ cwd }) => cwd),
          ...report.commands
            .filter(
              ({ tool, args }) => tool === "git" && (args[0] === "clone" || args[0] === "worktree"),
            )
            .map(({ cwd, args }) => path.resolve(cwd, args.at(args[0] === "clone" ? -1 : -2)!)),
        ])) {
          expect(readFileSync(path.join(directory, ".git/preexisting.lock"), "utf8")).toBe(
            "not invocation-owned\n",
          );
        }
      }
      expect(readFileSync(protectedFile, "utf8")).toBe("not checkout-owned\n");
      expect(
        existsSync(path.join(root, "python-injected")),
        "candidate Python startup executed",
      ).toBe(false);
      const readOutput = (name: string) =>
        existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), "utf8") : "";
      if (options.action === "ensure-base-commit") {
        expect(report.output).not.toContain("fixture quiet probe");
      }
      if (options.action === "git-owner") {
        const ownerPath = readOutput("github-env")
          .trim()
          .replace(/^CI_GIT_OWNER=/u, "");
        expect(path.relative(path.join(root, "temp"), ownerPath)).not.toMatch(/^\.\./u);
        expect(readFileSync(ownerPath, "utf8")).toBe(
          readFileSync(path.join(actions, "git-owner/owner.py"), "utf8"),
        );
        expect(readOutput("github-output")).toBe(`owner-path=${ownerPath}\n`);
      }
      const authHeaderPresent = publisher
        ? execFileSync(env.FAKE_REAL_GIT!, ["-C", workspace, "config", "--local", "--list"], {
            encoding: "utf8",
          }).includes("http.https://github.com/.extraheader=")
        : false;
      return {
        ...report,
        authHeaderPresent,
        initialBranch: publisherFixture?.initialBranch,
        publication: publisherFixture?.inspect(report.output, false),
        performance: performanceFixture?.inspect(),
        pluginSourcePackage: pluginRelease ? readOutput("temp/fixture-source-package.json") : "",
        pushLog: readOutput("runner-temp/generated-pr-push.log"),
        workspace,
        githubOutput: readOutput("github-output"),
        githubEnv: readOutput("github-env"),
        githubSummary: readOutput("github-summary"),
        githubPath: readOutput("github-path"),
        trustedConfig: readOutput("temp/pre-commit-base.yaml"),
        trustedZizmor: readOutput("temp/zizmor-base.yml"),
        runnerTemp: performanceFixture?.env.RUNNER_TEMP ?? path.join(root, "temp"),
        fetches: report.commands.filter(({ tool, args }) => tool === "git" && args[0] === "fetch"),
        clones: report.commands.filter(({ tool, args }) => tool === "git" && args[0] === "clone"),
        worktrees: report.commands.filter(
          ({ tool, args }) => tool === "git" && args[0] === "worktree",
        ),
        rebases: report.commands.filter(({ tool, args }) => tool === "git" && args[0] === "rebase"),
        pushes: report.commands.filter(({ tool, args }) => tool === "git" && args[0] === "push"),
        go: report.commands.filter(({ tool }) => tool === "go"),
        crabbox: report.commands.filter(({ tool }) => tool === "crabbox"),
        checkouts: report.commands.filter(
          ({ tool, args }) => tool === "git" && args[0] === "checkout",
        ),
      };
    },
  );
}
