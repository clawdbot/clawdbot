import { expect, it } from "vitest";
import { runCiGitStep } from "./ci-git-owner.test-support.js";

// These admission jobs run on Ubuntu. The shared ci-platform-checkout suite
// owns native Windows Job Object proof for the same pinned owner.
const posixIt = it.skipIf(process.platform === "win32");
const sha = "a".repeat(40);
const otherSha = "f".repeat(40);
const releaseTag = "v2026.8.1";

type ReleaseMode = "linux" | "macos" | "placeholder";
type RunOptions = Partial<Parameters<typeof runCiGitStep>[0]>;

const releases: Record<
  ReleaseMode,
  {
    workflow: { file: string; job: string; step: string };
    env: Record<string, string>;
    revisions?: Record<string, string>;
  }
> = {
  linux: {
    workflow: {
      file: ".github/workflows/linux-app-release.yml",
      job: "validate_release",
      step: "Ensure tag commit is reachable from its release branch",
    },
    env: { RELEASE_TAG: releaseTag, WORKFLOW_SHA: otherSha },
    revisions: { [`refs/tags/${releaseTag}^{commit}`]: sha },
  },
  macos: {
    workflow: {
      file: ".github/workflows/macos-release.yml",
      job: "validate_macos_release_request",
      step: "Validate release tag and package metadata",
    },
    env: { PUBLIC_RELEASE_BRANCH: "main", RELEASE_TAG: releaseTag },
  },
  placeholder: {
    workflow: {
      file: ".github/workflows/npm-placeholder-bootstrap.yml",
      job: "plan",
      step: "Validate trusted workflow and target",
    },
    env: {
      EVENT_SHA: sha,
      SOURCE_REF: sha,
      WORKFLOW_REF: "refs/heads/main",
      WORKFLOW_SHA: sha,
    },
  },
};

function releaseRun(mode: ReleaseMode, options: RunOptions = {}) {
  const release = releases[mode];
  return runCiGitStep({
    workflow: release.workflow,
    fetchResults: [],
    ...options,
    env: { ...release.env, ...options.env },
    revisions: { ...release.revisions, ...options.revisions },
  });
}

function gitCommands(report: Awaited<ReturnType<typeof releaseRun>>) {
  return report.commands.filter(({ tool }) => tool === "git").map(({ args }) => args);
}

posixIt.each([releaseTag, `${releaseTag}-2`])(
  "Linux admits a stable tag from its matching release branch: %s",
  async (tag) => {
    const report = await releaseRun("linux", {
      env: { RELEASE_TAG: tag },
      revisions: { [`refs/tags/${tag}^{commit}`]: sha },
      commandResults: {
        [`merge-base --is-ancestor ${sha} origin/main`]: { code: 1 },
        [`merge-base --is-ancestor ${sha} refs/remotes/origin/release/2026.8.1`]: { code: 0 },
      },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.githubOutput).toBe(`tag_sha=${sha}\n`);
    expect(gitCommands(report)).toContainEqual([
      "fetch",
      "--no-tags",
      "origin",
      "+refs/heads/release/2026.8.1:refs/remotes/origin/release/2026.8.1",
    ]);
  },
  55_000,
);

posixIt.each([
  {
    mode: "linux" as const,
    commands: [
      ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      ["merge-base", "--is-ancestor", otherSha, "origin/main"],
      ["rev-parse", `refs/tags/${releaseTag}^{commit}`],
      ["merge-base", "--is-ancestor", sha, "origin/main"],
    ],
    output: `tag_sha=${sha}\n`,
  },
  {
    mode: "macos" as const,
    commands: [
      ["rev-parse", "HEAD"],
      ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
    ],
    output: "",
  },
  {
    mode: "placeholder" as const,
    commands: [
      ["rev-parse", "HEAD"],
      ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      ["merge-base", "--is-ancestor", sha, "origin/main"],
      ["merge-base", "--is-ancestor", sha, "origin/main"],
    ],
    output: `sha=${sha}\n`,
  },
])(
  "$mode admission drains every Git tree before output or consumer",
  async ({ mode, commands, output }) => {
    const report = await releaseRun(mode);
    expect(report.code, report.output).toBe(0);
    expect(gitCommands(report)).toEqual(commands);
    expect(report.githubOutput).toBe(output);
    expect(report.readyAttempts).toHaveLength(commands.length);
    if (mode === "macos") {
      expect(report.commands.filter(({ tool }) => tool === "pnpm").map(({ args }) => args)).toEqual(
        [["release:openclaw:npm:check"]],
      );
      expect(report.boundaries.some(({ name }) => name === "consumer:pnpm")).toBe(true);
    } else {
      expect(report.boundaries.some(({ name }) => name === "output")).toBe(true);
    }
  },
  55_000,
);

posixIt.each(
  (["linux", "macos", "placeholder"] as const).flatMap((mode) =>
    ([23, 124, 125, 143, "hang"] as const).map((failure) => ({ failure, mode })),
  ),
)(
  "$mode fetch failure $failure stops before output or consumer",
  async ({ failure, mode }) => {
    const report = await releaseRun(mode, { fetchResults: [failure] });
    expect(report.code, report.output).toBe(failure === "hang" ? 124 : failure);
    expect(gitCommands(report).at(-1)?.[0]).toBe("fetch");
    expect(report.githubOutput).toBe("");
    expect(report.commands.some(({ tool }) => tool === "pnpm")).toBe(false);
  },
  55_000,
);

posixIt.each(
  (["linux", "macos"] as const).flatMap((mode) =>
    ([23, 124, 125, 143] as const).map((code) => ({ code, mode })),
  ),
)(
  "$mode ordinary rev-parse status $code remains terminal",
  async ({ code, mode }) => {
    const report = await releaseRun(mode, {
      gitFault: { match: "^rev-parse ", code },
    });
    expect(report.code, report.output).toBe(code);
    expect(gitCommands(report).at(-1)?.[0]).toBe("rev-parse");
    expect(report.githubOutput).toBe("");
    expect(report.commands.some(({ tool }) => tool === "pnpm")).toBe(false);
  },
  55_000,
);

posixIt(
  "macOS rejects an invalid public branch before any Git command",
  async () => {
    const report = await releaseRun("macos", {
      env: { PUBLIC_RELEASE_BRANCH: "feature/not-a-release" },
    });
    expect(report.code, report.output).toBe(1);
    expect(report.output).toContain(
      "public_release_branch must be main or release/YYYY.M.PATCH, got feature/not-a-release.",
    );
    expect(gitCommands(report)).toEqual([]);
    expect(report.commands.some(({ tool }) => tool === "pnpm")).toBe(false);
  },
  55_000,
);

const terminalOperations = [
  { mode: "linux" as const, match: "^fetch ", operation: "fetch" },
  { mode: "linux" as const, match: "^rev-parse ", operation: "rev-parse" },
  { mode: "linux" as const, match: "^merge-base ", operation: "merge-base" },
  { mode: "macos" as const, match: "^rev-parse ", operation: "rev-parse" },
  { mode: "macos" as const, match: "^fetch ", operation: "fetch" },
  { mode: "placeholder" as const, match: "^rev-parse ", operation: "rev-parse" },
  { mode: "placeholder" as const, match: "^fetch ", operation: "fetch" },
  {
    mode: "placeholder" as const,
    match: "^merge-base ",
    occurrence: 1,
    operation: "merge-base",
  },
  {
    mode: "placeholder" as const,
    match: "^merge-base ",
    occurrence: 2,
    operation: "merge-base",
  },
];

posixIt.each(
  terminalOperations.flatMap((entry) =>
    (["cleanup-failure", "cancel"] as const).map((failure) => ({ ...entry, failure })),
  ),
)(
  "$mode $operation $failure is terminal before every later boundary",
  async ({ failure, match, mode, occurrence, operation }) => {
    const report = await releaseRun(mode, {
      gitFault: { match, occurrence, code: failure },
    });
    expect(report.code, report.output).toBe(failure === "cancel" ? 143 : 125);
    expect(gitCommands(report).at(-1)?.[0]).toBe(operation);
    expect(report.githubOutput).toBe("");
    expect(report.commands.some(({ tool }) => tool === "pnpm")).toBe(false);
    expect(report.output).not.toMatch(/not reachable|requires ref to equal/u);
  },
  55_000,
);

posixIt.each([23, 124, 125, 143])(
  "Linux ordinary merge-base status %s is terminal without trying another branch",
  async (code) => {
    const report = await releaseRun("linux", {
      gitFault: { match: "^merge-base ", code },
    });
    expect(report.code, report.output).toBe(code);
    expect(gitCommands(report).at(-1)?.[0]).toBe("merge-base");
    expect(report.githubOutput).toBe("");
  },
  55_000,
);

posixIt(
  "Linux rejects a tag outside main and its matching release branch",
  async () => {
    const report = await releaseRun("linux", {
      commandResults: {
        [`merge-base --is-ancestor ${sha} origin/main`]: { code: 1 },
        [`merge-base --is-ancestor ${sha} refs/remotes/origin/release/2026.8.1`]: { code: 1 },
      },
    });
    expect(report.code, report.output).toBe(1);
    expect(report.output).toContain(
      `Tag ${releaseTag} (${sha}) is not reachable from main or release/2026.8.1.`,
    );
    expect(report.githubOutput).toBe("");
  },
  55_000,
);

posixIt(
  "Linux rejects tooling outside main before inspecting the candidate",
  async () => {
    const report = await releaseRun("linux", {
      commandResults: { [`merge-base --is-ancestor ${otherSha} origin/main`]: { code: 1 } },
    });
    expect(report.code, report.output).toBe(1);
    expect(report.output).toContain("Linux release tooling must be reachable from current main.");
    expect(gitCommands(report).some(([operation]) => operation === "rev-parse")).toBe(false);
    expect(report.githubOutput).toBe("");
  },
  55_000,
);

posixIt.each([128, "cleanup-failure", "cancel"] as const)(
  "Linux matching release branch fetch failure %s cannot admit a stale ref",
  async (failure) => {
    const report = await releaseRun("linux", {
      commandResults: { [`merge-base --is-ancestor ${sha} origin/main`]: { code: 1 } },
      gitFault: { match: "^fetch ", occurrence: 2, code: failure },
    });
    expect(report.code, report.output).toBe(
      failure === "cancel" ? 143 : failure === "cleanup-failure" ? 125 : failure,
    );
    expect(gitCommands(report).at(-1)?.[0]).toBe("fetch");
    expect(report.githubOutput).toBe("");
  },
  55_000,
);

posixIt.each([
  { occurrence: 1, message: "workflow revision is not reachable" },
  { occurrence: 2, message: "target must be reachable" },
])(
  "placeholder ordinary merge-base failure $occurrence keeps its custom rejection",
  async ({ message, occurrence }) => {
    const report = await releaseRun("placeholder", {
      gitFault: { match: "^merge-base ", occurrence, code: 23 },
    });
    expect(report.code, report.output).toBe(1);
    expect(report.output).toContain(message);
    expect(gitCommands(report).filter(([operation]) => operation === "merge-base")).toHaveLength(
      occurrence,
    );
    expect(report.githubOutput).toBe("");
  },
  55_000,
);

posixIt.each([23, 124, 125, 143])(
  "placeholder rev-parse status %s retains exact-SHA rejection",
  async (code) => {
    const report = await releaseRun("placeholder", {
      gitFault: { match: "^rev-parse ", code },
    });
    expect(report.code, report.output).toBe(1);
    expect(report.output).toContain(
      "NPM placeholder publication requires ref to equal the exact main workflow SHA.",
    );
    expect(gitCommands(report)).toHaveLength(1);
    expect(report.githubOutput).toBe("");
  },
  55_000,
);

const placeholderIdentityMismatches: Array<{
  env: Record<string, string>;
  message: string;
}> = [
  {
    env: { WORKFLOW_REF: "refs/heads/release/2026.8.1" },
    message: "must run from the trusted main workflow",
  },
  {
    env: { EVENT_SHA: otherSha },
    message: "requires ref to equal the exact main workflow SHA",
  },
];

posixIt.each(placeholderIdentityMismatches)(
  "placeholder rejects non-Git identity mismatch before checkout inspection",
  async ({ env, message }) => {
    const report = await releaseRun("placeholder", { env });
    expect(report.code, report.output).toBe(1);
    expect(report.output).toContain(message);
    expect(gitCommands(report)).toEqual([]);
    expect(report.githubOutput).toBe("");
  },
  55_000,
);

posixIt(
  "placeholder rejects a checked-out SHA mismatch before fetch",
  async () => {
    const report = await releaseRun("placeholder", {
      commandResults: { "rev-parse HEAD": { code: 0, output: `${otherSha}\n` } },
    });
    expect(report.code, report.output).toBe(1);
    expect(report.output).toContain(
      "NPM placeholder publication requires ref to equal the exact main workflow SHA.",
    );
    expect(gitCommands(report)).toEqual([["rev-parse", "HEAD"]]);
    expect(report.githubOutput).toBe("");
  },
  55_000,
);

posixIt.each(
  (["linux", "macos", "placeholder"] as const).flatMap((mode) =>
    (["owner", "python", "git"] as const).map((setupFailure) => ({ mode, setupFailure })),
  ),
)(
  "$mode setup failure $setupFailure cannot publish or consume admission",
  async ({ mode, setupFailure }) => {
    const report = await releaseRun(mode, { setupFailure });
    expect(report.code, report.output).not.toBe(0);
    expect(report.githubOutput).toBe("");
    expect(report.commands.some(({ tool }) => tool === "pnpm")).toBe(false);
  },
  55_000,
);
