import { execFileSync } from "node:child_process";
import {
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll } from "vitest";
import { createTempDirTracker } from "../helpers/temp-dir.js";

type PerformanceTemplate = {
  root: string;
  git: string;
  target: string;
  reportCommit: string;
};

const templateDirs = createTempDirTracker();
const performanceTemplates = new Map<"base" | "publish", PerformanceTemplate>();
afterAll(() => {
  templateDirs.cleanup();
  performanceTemplates.clear();
});

export type PerformanceFixtureOptions = {
  mode: "target" | "record" | "tested" | "kova" | "baseline" | "prepare" | "publish";
  baseline?: "absent" | "invalid" | "trailing-newline";
  duplicate?: boolean;
  race?: boolean;
  remoteDuplicateAttempt?: number;
};

export function preparePerformanceFixture(root: string, options: PerformanceFixtureOptions) {
  const workspace = path.join(root, "workspace");
  const temp = path.join(workspace, "performance-temp");
  const remote = path.join(workspace, "reports.git");
  const seed = path.join(workspace, "seed");
  const reports = path.join(temp, "reports");
  const input = path.join(temp, "input");
  const reuseDefault = !options.baseline && !options.duplicate;
  const templateKind = options.mode === "publish" ? "publish" : "base";
  const template = reuseDefault ? performanceTemplates.get(templateKind) : undefined;
  const git = template?.git ?? execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const gitEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: "Performance fixture",
    GIT_AUTHOR_EMAIL: "performance@example.invalid",
    GIT_COMMITTER_NAME: "Performance fixture",
    GIT_COMMITTER_EMAIL: "performance@example.invalid",
  };
  const run = (cwd: string, ...args: string[]) =>
    execFileSync(git, ["-C", cwd, ...args], {
      env: gitEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const write = (file: string, value: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, value);
  };
  const dest = "openclaw-performance/main/123-1/mock-provider";
  const previous = "openclaw-performance/main/100-1/mock-provider";
  const pointer = "openclaw-performance/main/latest-mock-provider.json";
  const commitReport = (cwd: string, report: string) => {
    write(path.join(cwd, report, "report.json"), JSON.stringify({ path: report }));
    write(path.join(cwd, report, "source/index.md"), "source fixture\n");
    write(path.join(cwd, pointer), JSON.stringify({ path: report }));
    run(cwd, "add", ".");
    run(cwd, "commit", "-m", "fixture report");
  };
  const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
  if (template) {
    cpSync(template.root, workspace, copyOptions);
  } else {
    mkdirSync(temp, { recursive: true });
    mkdirSync(seed);
    run(workspace, "init", "--bare", "--initial-branch=main", remote);
    run(seed, "init", "--initial-branch=main");
    write(path.join(seed, "README.md"), "fixture\n");
    if (options.baseline !== "absent") {
      commitReport(seed, options.duplicate ? dest : previous);
      if (options.baseline === "invalid") {
        write(path.join(seed, pointer), "{invalid");
      }
      if (options.baseline === "trailing-newline") {
        write(path.join(seed, pointer), JSON.stringify({ path: previous + "\n" }));
      }
    }
    run(seed, "add", ".");
    run(seed, "commit", "--allow-empty", "-m", "fixture seed");
    run(seed, "push", remote, "HEAD:main");
    run(workspace, "init", "--initial-branch=main");
    write(path.join(workspace, "src/config/zod-schema.agent-defaults.ts"), "    mediaModels: z\n");
    run(workspace, "add", "src");
    run(workspace, "commit", "-m", "fixture target");
    mkdirSync(reports);
    if (options.mode === "publish") {
      run(reports, "init", "--initial-branch=main");
      run(reports, "remote", "add", "origin", "https://github.com/openclaw/clawgrit-reports.git");
      // Keep FETCH_HEAD's source description valid when the snapshot is copied.
      run(reports, "fetch", "--depth=1", path.relative(reports, remote), "main");
      run(reports, "checkout", "-B", "main", "FETCH_HEAD");
      run(reports, "config", "core.hooksPath", "/dev/null");
      commitReport(reports, dest);
      write(path.join(reports, ".git/preexisting.lock"), "not invocation-owned\n");
    }
  }
  const target = template?.target ?? run(workspace, "rev-parse", "HEAD");
  const reportCommit =
    template?.reportCommit ??
    (options.mode === "publish" ? run(reports, "rev-parse", "HEAD") : "a".repeat(40));
  if (!template && reuseDefault) {
    // Snapshot complete repositories and their identities before scenario mutation.
    // Copies own their refs, index and objects; no live process or remote is shared.
    const templateRoot = templateDirs.make(`openclaw-performance-${templateKind}-template-`);
    cpSync(workspace, templateRoot, copyOptions);
    performanceTemplates.set(templateKind, { root: templateRoot, git, target, reportCommit });
  }
  if (options.mode === "publish" && options.race) {
    commitReport(seed, "openclaw-performance/main/200-1/mock-provider");
    run(seed, "push", remote, "HEAD:main");
  }
  write(path.join(input, "kova/reports/mock-provider/report.json"), "{}\n");
  write(path.join(input, "kova/reports/mock-provider/report.md"), "report\n");
  write(path.join(input, "kova/summaries/mock-provider.md"), "summary\n");
  write(path.join(input, "kova/bundles/mock-provider/bundle.json"), "{}\n");
  write(path.join(input, "kova/bundles/mock-provider/bundle.tar.gz.sha256"), "fixture\n");
  write(path.join(input, "kova/bundles/mock-provider/bundle.tar.gz"), "private archive fixture\n");
  write(
    path.join(input, "openclaw-performance-source-123-1/mock-provider/index.md"),
    "source fixture\n",
  );
  const env = {
    ...Object.fromEntries(Object.entries(gitEnv).filter(([key]) => key.startsWith("GIT_"))),
    RUNNER_TEMP: temp,
    TARGET_CHECKOUT_DIR: workspace,
    TARGET_REF_INPUT: "main",
    KOVA_REF_INPUT: "fixture",
    KOVA_CONFIG_CONTRACT_INPUT: "canonical",
    KOVA_TRUSTED_LIVE_REF: "fixture",
    KOVA_REPOSITORY: "fixture/kova",
    KOVA_REF: "main",
    KOVA_HOME: path.join(temp, "kova-home"),
    OCM_VERSION: "fixture",
    OCM_LINUX_X64_SHA256: "fixture",
    TARGET_REF: "main",
    EXPECTED_TESTED_SHA: target,
    TESTED_REF: "main",
    TESTED_SHA: target,
    GITHUB_REF_NAME: "main",
    GITHUB_SHA: target,
    GITHUB_WORKFLOW: "OpenClaw Performance",
    GITHUB_REPOSITORY: "fixture/performance",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    ARTIFACT_ID: "42",
    PRODUCER_ATTEMPT: "1",
    SOURCE_PRODUCER_ATTEMPT: "1",
    LANE_ID: "mock-provider",
    INPUT_ROOT: input,
    REPORTS_ROOT: reports,
    REPORT_COMMIT: reportCommit,
    DEST_REL: dest,
    REPORT_URL: `https://github.com/openclaw/clawgrit-reports/tree/main/${dest}`,
    REPORT_PUBLISH_REQUIRED: "true",
    PERFORMANCE_REPORT_SELECTOR: path.resolve("scripts/lib/kova-report-selector.mjs"),
    PERFORMANCE_PUBLISHER_HELPER: path.resolve("scripts/lib/kova-report-publish-files.mjs"),
    PUBLISHED_REPORT_MAX_FILE_BYTES: "50000000",
    ...(options.mode === "publish"
      ? { CLAWGRIT_REPORTS_APP_TOKEN: "fixture-performance-token" }
      : {}),
  };
  return {
    env,
    proxy: { git, remote, ...options },
    inspect() {
      return {
        remoteFiles: run(
          workspace,
          "--git-dir",
          remote,
          "ls-tree",
          "-r",
          "--name-only",
          "main",
        ).split("\n"),
        pointer:
          options.baseline === "absent"
            ? ""
            : run(workspace, "--git-dir", remote, "show", `main:${pointer}`),
        config: existsSync(path.join(reports, ".git/config"))
          ? readFileSync(path.join(reports, ".git/config"), "utf8")
          : "",
      };
    },
  };
}
