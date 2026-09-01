import { expect, it } from "vitest";
import { runCiGitStep } from "./ci-git-owner.test-support.js";

// Plugin publication jobs run on Ubuntu. Native Job Object and POSIX owner
// behavior stays in the shared ci-platform-checkout suites.
const posixIt = it.skipIf(process.platform === "win32");
const sha = "a".repeat(40);
const workflowSha = "b".repeat(40);
const releaseTag = "v2026.8.1";
const alphaBranch = "tideclaw/alpha/2026-08-30-1200Z";
const packageDir = "extensions/fixture";
const packageJson = '{"name":"@openclaw/fixture","version":"2026.8.33"}\n';

type PluginMode =
  | "clawhub-resolve"
  | "clawhub-oidc"
  | "clawhub-trust"
  | "npm-resolve"
  | "npm-trust"
  | "npm-preflight-read"
  | "npm-publish-read";
type RunOptions = Partial<Parameters<typeof runCiGitStep>[0]>;

const modes: Record<
  PluginMode,
  { workflow: { file: string; job: string; step: string }; env: Record<string, string> }
> = {
  "clawhub-resolve": {
    workflow: {
      file: ".github/workflows/plugin-clawhub-release.yml",
      job: "preview_plugins_clawhub",
      step: "Resolve checked-out ref",
    },
    env: { RELEASE_TAG: "", TARGET_REF: "" },
  },
  "clawhub-oidc": {
    workflow: {
      file: ".github/workflows/plugin-clawhub-release.yml",
      job: "preview_plugins_clawhub",
      step: "Validate OIDC source matches workflow ref",
    },
    env: {
      DRY_RUN: "false",
      RELEASE_PUBLISH_RUN_ATTEMPT: "",
      RELEASE_PUBLISH_RUN_ID: "",
      RELEASE_TAG: "",
      TARGET_SHA: sha,
      WORKFLOW_REF: "refs/heads/main",
      WORKFLOW_SHA: sha,
    },
  },
  "clawhub-trust": {
    workflow: {
      file: ".github/workflows/plugin-clawhub-release.yml",
      job: "preview_plugins_clawhub",
      step: "Validate ref is on a trusted publish branch",
    },
    env: { TRUSTED_PUBLISH_BRANCH: "main" },
  },
  "npm-resolve": {
    workflow: {
      file: ".github/workflows/plugin-npm-release.yml",
      job: "preview_plugins_npm",
      step: "Resolve checked-out ref",
    },
    env: {},
  },
  "npm-trust": {
    workflow: {
      file: ".github/workflows/plugin-npm-release.yml",
      job: "preview_plugins_npm",
      step: "Validate ref is on a trusted publish branch",
    },
    env: {
      NPM_DIST_TAG: "default",
      PREFLIGHT_ONLY: "false",
      PUBLISH_SCOPE: "selected",
      RELEASE_PLUGINS: "",
      RELEASE_PUBLISH_RUN_ATTEMPT: "",
      RELEASE_PUBLISH_RUN_ID: "",
      SOURCE_REF: sha,
      TRUSTED_PUBLISHER_PREFLIGHT: "false",
      WORKFLOW_REF: "refs/heads/main",
      WORKFLOW_SHA: workflowSha,
    },
  },
  "npm-preflight-read": {
    workflow: {
      file: ".github/workflows/plugin-npm-release.yml",
      job: "verify_plugin_npm_preflight",
      step: "Read exact npm preflight source package",
    },
    env: { EXTENSION_ID: "fixture", PACKAGE_DIR: packageDir, SOURCE_SHA: sha },
  },
  "npm-publish-read": {
    workflow: {
      file: ".github/workflows/plugin-npm-release.yml",
      job: "publish_plugins_npm",
      step: "Read exact npm publication source package",
    },
    env: { EXTENSION_ID: "fixture", PACKAGE_DIR: packageDir, TARGET_SHA: sha },
  },
};

function pluginRun(mode: PluginMode, options: RunOptions = {}) {
  const selected = modes[mode];
  return runCiGitStep({
    workflow: selected.workflow,
    fetchResults: [],
    ...options,
    env: { ...selected.env, ...options.env },
    revisions: { HEAD: sha, ...options.revisions },
  });
}

function gitCommands(report: Awaited<ReturnType<typeof pluginRun>>) {
  return report.commands.filter(({ tool }) => tool === "git").map(({ args }) => args);
}

posixIt.each([
  {
    mode: "clawhub-resolve" as const,
    commands: [
      [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
        "+refs/heads/release/*:refs/remotes/origin/release/*",
      ],
      ["rev-parse", "HEAD"],
    ],
    output: `sha=${sha}\n`,
  },
  {
    mode: "npm-resolve" as const,
    commands: [["rev-parse", "HEAD"]],
    output: `sha=${sha}\n`,
  },
  {
    mode: "clawhub-trust" as const,
    commands: [["merge-base", "--is-ancestor", "HEAD", "origin/main"]],
    output: "",
  },
  {
    mode: "npm-trust" as const,
    commands: [
      [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
        "+refs/heads/release/*:refs/remotes/origin/release/*",
      ],
      ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
    ],
    output: "",
  },
])(
  "$mode drains every Git tree before success or output",
  async ({ commands, mode, output }) => {
    const report = await pluginRun(mode);
    expect(report.code, report.output).toBe(0);
    expect(gitCommands(report)).toEqual(commands);
    expect(report.githubOutput).toBe(output);
    expect(report.readyAttempts).toHaveLength(commands.length);
    if (output) expect(report.boundaries.some(({ name }) => name === "output")).toBe(true);
  },
  55_000,
);

posixIt.each(["npm-preflight-read", "npm-publish-read"] as const)(
  "%s preserves exact source package bytes before the next consumer",
  async (mode) => {
    const sourceRef = mode === "npm-preflight-read" ? "SOURCE_SHA" : "TARGET_SHA";
    const report = await pluginRun(mode, {
      commandResults: {
        [`show ${sha}:${packageDir}/package.json`]: { code: 0, output: packageJson },
      },
    });
    expect(report.code, report.output).toBe(0);
    expect(gitCommands(report)).toEqual([
      ["fetch", "--no-tags", "--depth=1", "origin", sha],
      ["show", `${sha}:${packageDir}/package.json`],
    ]);
    expect(report.pluginSourcePackage).toBe(packageJson);
    expect(modes[mode].env[sourceRef]).toBe(sha);
  },
  55_000,
);

posixIt.each(["npm-preflight-read", "npm-publish-read"] as const)(
  "%s rejects partial source package output after ordinary show failure",
  async (mode) => {
    const report = await pluginRun(mode, {
      commandResults: {
        [`show ${sha}:${packageDir}/package.json`]: { code: 23, output: "{partial" },
      },
    });
    expect(report.code, report.output).toBe(23);
    expect(gitCommands(report).at(-1)?.[0]).toBe("show");
    expect(report.pluginSourcePackage).toBe("");
  },
  55_000,
);

posixIt.each(
  (["npm-preflight-read", "npm-publish-read"] as const).flatMap((mode) =>
    ([23, 124, 125, 143, "hang"] as const).map((failure) => ({ failure, mode })),
  ),
)(
  "$mode fetch failure $failure stops before source package readback",
  async ({ failure, mode }) => {
    const report = await pluginRun(mode, { fetchResults: [failure] });
    expect(report.code, report.output).toBe(failure === "hang" ? 124 : failure);
    expect(gitCommands(report).at(-1)?.[0]).toBe("fetch");
    expect(report.pluginSourcePackage).toBe("");
  },
  55_000,
);

posixIt.each([1, 23, 124, 125, 143])(
  "ClawHub resolves origin fallback after safely drained ordinary local probe failure %s",
  async (code) => {
    const report = await pluginRun("clawhub-resolve", {
      env: { TARGET_REF: "release/fixture" },
      commandResults: {
        "rev-parse --verify --quiet release/fixture^{commit}": { code, output: "" },
      },
      revisions: { "origin/release/fixture^{commit}": sha },
    });
    expect(report.code, report.output).toBe(0);
    expect(gitCommands(report)).toEqual([
      [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
        "+refs/heads/release/*:refs/remotes/origin/release/*",
      ],
      ["rev-parse", "--verify", "--quiet", "release/fixture^{commit}"],
      ["rev-parse", "--verify", "--quiet", "origin/release/fixture^{commit}"],
      ["rev-parse", "origin/release/fixture^{commit}"],
      ["checkout", "--detach", sha],
      ["rev-parse", "HEAD"],
    ]);
    expect(report.githubOutput).toBe(`sha=${sha}\n`);
  },
  55_000,
);

posixIt(
  "ClawHub release tags retain their second bounded fetch",
  async () => {
    const report = await pluginRun("clawhub-resolve", {
      env: { RELEASE_TAG: releaseTag },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches.map(({ args }) => args)).toEqual([
      [
        "fetch",
        "--no-tags",
        "origin",
        "+refs/heads/main:refs/remotes/origin/main",
        "+refs/heads/release/*:refs/remotes/origin/release/*",
      ],
      ["fetch", "--no-tags", "origin", `+refs/tags/${releaseTag}:refs/tags/${releaseTag}`],
    ]);
  },
  55_000,
);

posixIt(
  "ClawHub protected tooling validates the exact peeled release target",
  async () => {
    const report = await pluginRun("clawhub-oidc", {
      env: {
        RELEASE_PUBLISH_RUN_ATTEMPT: "2",
        RELEASE_PUBLISH_RUN_ID: "123",
        RELEASE_TAG: releaseTag,
        TARGET_SHA: sha,
        WORKFLOW_REF: "refs/tags/release-publish/abcdef123456-2",
        WORKFLOW_SHA: workflowSha,
      },
      revisions: { [`${releaseTag}^{commit}`]: sha },
    });
    expect(report.code, report.output).toBe(0);
    expect(gitCommands(report)).toEqual([["rev-parse", `${releaseTag}^{commit}`]]);
    expect(report.output).toContain(
      "Protected release tooling is publishing the exact immutable release tag target.",
    );
  },
  55_000,
);

posixIt.each([1, 23, 124, 125, 143])(
  "ClawHub protected tag ordinary lookup failure %s retains OIDC rejection",
  async (code) => {
    const report = await pluginRun("clawhub-oidc", {
      env: {
        RELEASE_PUBLISH_RUN_ATTEMPT: "2",
        RELEASE_PUBLISH_RUN_ID: "123",
        RELEASE_TAG: releaseTag,
        TARGET_SHA: sha,
        WORKFLOW_REF: "refs/tags/release-publish/abcdef123456-2",
        WORKFLOW_SHA: workflowSha,
      },
      commandResults: { [`rev-parse ${releaseTag}^{commit}`]: { code } },
    });
    expect(report.code, report.output).toBe(1);
    expect(report.output).toContain(
      "Plugin ClawHub OIDC publish target is not bound to protected tooling and the exact release tag.",
    );
  },
  55_000,
);

posixIt.each(["clawhub-trust", "npm-trust"] as const)(
  "%s accepts a release branch only after successful enumeration",
  async (mode) => {
    const report = await pluginRun(mode, {
      commandResults: {
        "merge-base --is-ancestor HEAD origin/main": { code: 1 },
        "for-each-ref --format=%(refname) refs/remotes/origin/release": {
          code: 0,
          output: "refs/remotes/origin/release/2026.8.1\n",
        },
        "merge-base --is-ancestor HEAD refs/remotes/origin/release/2026.8.1": { code: 0 },
      },
    });
    expect(report.code, report.output).toBe(0);
    expect(gitCommands(report).at(-1)).toEqual([
      "merge-base",
      "--is-ancestor",
      "HEAD",
      "refs/remotes/origin/release/2026.8.1",
    ]);
  },
  55_000,
);

posixIt.each(["clawhub-trust", "npm-trust"] as const)(
  "%s accepts only the matching Tideclaw alpha branch after main and release misses",
  async (mode) => {
    const workflowRef = `refs/heads/${alphaBranch}`;
    const report = await pluginRun(mode, {
      env:
        mode === "clawhub-trust"
          ? { TRUSTED_PUBLISH_BRANCH: alphaBranch }
          : { WORKFLOW_REF: workflowRef },
      commandResults: {
        "merge-base --is-ancestor HEAD origin/main": { code: 1 },
        "for-each-ref --format=%(refname) refs/remotes/origin/release": { code: 0, output: "" },
        [`merge-base --is-ancestor HEAD refs/remotes/origin/${alphaBranch}`]: { code: 0 },
      },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches.at(-1)?.args).toEqual([
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${alphaBranch}:refs/remotes/origin/${alphaBranch}`,
    ]);
  },
  55_000,
);

posixIt(
  "npm extended-stable retains exact-tip admission and its single bounded fetch",
  async () => {
    const branch = "extended-stable/2026.8.33";
    const report = await pluginRun("npm-trust", {
      env: {
        NPM_DIST_TAG: "extended-stable",
        PUBLISH_SCOPE: "all-publishable",
        SOURCE_REF: sha,
        WORKFLOW_REF: `refs/heads/${branch}`,
      },
      revisions: {
        [`${sha}^{commit}`]: sha,
        [`refs/heads/${branch}`]: sha,
        [`refs/remotes/origin/${branch}`]: sha,
      },
    });
    expect(report.code, report.output).toBe(0);
    expect(report.fetches.map(({ args }) => args)).toEqual([
      ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    ]);
    expect(gitCommands(report).filter(([operation]) => operation === "rev-parse")).toHaveLength(4);
  },
  55_000,
);

posixIt(
  "npm preflight rejects before Tideclaw fallback after main and release misses",
  async () => {
    const report = await pluginRun("npm-trust", {
      env: { PREFLIGHT_ONLY: "true", SOURCE_REF: sha, WORKFLOW_REF: `refs/heads/${alphaBranch}` },
      revisions: { [`${sha}^{commit}`]: sha },
      commandResults: {
        "merge-base --is-ancestor HEAD origin/main": { code: 1 },
        "for-each-ref --format=%(refname) refs/remotes/origin/release": { code: 0, output: "" },
      },
    });
    expect(report.code, report.output).toBe(1);
    expect(report.output).toContain(
      "Plugin npm preflight target must be reachable from main or release/*.",
    );
    expect(report.fetches).toHaveLength(1);
    expect(report.output).not.toContain("matching Tideclaw alpha branch");
  },
  55_000,
);

posixIt.each(["clawhub-trust", "npm-trust"] as const)(
  "%s treats merge-base errors other than ordinary 1 as terminal",
  async (mode) => {
    const report = await pluginRun(mode, {
      commandResults: { "merge-base --is-ancestor HEAD origin/main": { code: 23 } },
    });
    expect(report.code, report.output).toBe(23);
    expect(gitCommands(report)).toHaveLength(mode === "npm-trust" ? 2 : 1);
    expect(report.fetches).toHaveLength(mode === "npm-trust" ? 1 : 0);
  },
  55_000,
);

posixIt.each(["clawhub-trust", "npm-trust"] as const)(
  "%s treats release-ref enumeration failure as terminal",
  async (mode) => {
    const report = await pluginRun(mode, {
      commandResults: {
        "merge-base --is-ancestor HEAD origin/main": { code: 1 },
        "for-each-ref --format=%(refname) refs/remotes/origin/release": { code: 23 },
      },
    });
    expect(report.code, report.output).toBe(23);
    expect(gitCommands(report).at(-1)?.[0]).toBe("for-each-ref");
    expect(report.fetches).toHaveLength(mode === "npm-trust" ? 1 : 0);
  },
  55_000,
);

const terminalCases: Array<{
  commandResults?: RunOptions["commandResults"];
  env?: Record<string, string>;
  match: string;
  mode: PluginMode;
  operation: string;
  revisions?: Record<string, string>;
}> = [
  { mode: "clawhub-resolve" as const, operation: "fetch", match: "^fetch " },
  {
    mode: "clawhub-resolve" as const,
    operation: "rev-parse",
    match: "^rev-parse --verify --quiet ",
    env: { TARGET_REF: "release/fixture" },
    revisions: { "origin/release/fixture^{commit}": sha },
  },
  {
    mode: "clawhub-resolve" as const,
    operation: "checkout",
    match: "^checkout ",
    env: { TARGET_REF: sha },
    revisions: { [`${sha}^{commit}`]: sha },
  },
  {
    mode: "clawhub-oidc" as const,
    operation: "rev-parse",
    match: "^rev-parse ",
    env: {
      RELEASE_PUBLISH_RUN_ATTEMPT: "1",
      RELEASE_PUBLISH_RUN_ID: "1",
      RELEASE_TAG: releaseTag,
      TARGET_SHA: sha,
      WORKFLOW_REF: "refs/tags/release-publish/abcdef123456-1",
      WORKFLOW_SHA: workflowSha,
    },
  },
  {
    mode: "clawhub-trust" as const,
    operation: "merge-base",
    match: "^merge-base ",
  },
  {
    mode: "clawhub-trust" as const,
    operation: "for-each-ref",
    match: "^for-each-ref ",
    commandResults: { "merge-base --is-ancestor HEAD origin/main": { code: 1 } },
  },
  { mode: "npm-resolve" as const, operation: "rev-parse", match: "^rev-parse " },
  { mode: "npm-trust" as const, operation: "fetch", match: "^fetch " },
  {
    mode: "npm-trust" as const,
    operation: "merge-base",
    match: "^merge-base ",
  },
  {
    mode: "npm-trust" as const,
    operation: "for-each-ref",
    match: "^for-each-ref ",
    commandResults: { "merge-base --is-ancestor HEAD origin/main": { code: 1 } },
  },
  { mode: "npm-preflight-read" as const, operation: "fetch", match: "^fetch " },
  {
    mode: "npm-preflight-read" as const,
    operation: "show",
    match: "^show ",
    commandResults: {
      [`show ${sha}:${packageDir}/package.json`]: { code: 0, output: packageJson },
    },
  },
  { mode: "npm-publish-read" as const, operation: "fetch", match: "^fetch " },
  {
    mode: "npm-publish-read" as const,
    operation: "show",
    match: "^show ",
    commandResults: {
      [`show ${sha}:${packageDir}/package.json`]: { code: 0, output: packageJson },
    },
  },
];

posixIt.each(
  terminalCases.flatMap((entry) =>
    (["cleanup-failure", "cancel"] as const).map((failure) => ({ ...entry, failure })),
  ),
)(
  "$mode $operation $failure fences every later Git/output/consumer boundary",
  async ({ commandResults, env, failure, match, mode, operation, revisions }) => {
    const report = await pluginRun(mode, {
      commandResults,
      env,
      revisions,
      gitFault: { match, code: failure },
    });
    expect(report.code, report.output).toBe(failure === "cancel" ? 143 : 125);
    expect(gitCommands(report).at(-1)?.[0]).toBe(operation);
    expect(
      gitCommands(report).filter((args) => new RegExp(match).test(args.join(" "))),
    ).toHaveLength(1);
    expect(report.githubOutput).toBe("");
    expect(report.commands.some(({ tool }) => ["node", "pnpm"].includes(tool))).toBe(false);
  },
  55_000,
);

posixIt.each(
  (["clawhub-resolve", "npm-resolve", "npm-preflight-read", "npm-publish-read"] as const).flatMap(
    (mode) => (["owner", "python", "git"] as const).map((setupFailure) => ({ mode, setupFailure })),
  ),
)(
  "$mode setup failure $setupFailure cannot publish or consume Git output",
  async ({ mode, setupFailure }) => {
    const report = await pluginRun(mode, { setupFailure });
    expect(report.code, report.output).not.toBe(0);
    expect(report.githubOutput).toBe("");
    expect(report.commands.some(({ tool }) => ["node", "pnpm"].includes(tool))).toBe(false);
  },
  55_000,
);
