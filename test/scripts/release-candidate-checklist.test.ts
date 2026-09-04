import { execFileSync, spawnSync } from "node:child_process";
// Release Candidate Checklist tests cover release candidate checklist script behavior.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { releaseBranchForTag } from "../../scripts/lib/release-context.mjs";
import { parseReleaseVersion } from "../../scripts/lib/release-version.mjs";
import {
  buildReleaseCandidateState,
  buildPublishCommand,
  buildTelegramArtifactInputs,
  assertPlannedReleaseTagIsAbsent,
  candidateCumulativeShippedPullRequests,
  candidateParallelsArgs,
  candidateParallelsShellCommand,
  fullReleaseTrustedWorkflowFields,
  githubApi,
  isDirectReleaseCandidateExecution,
  parseArgs,
  parseRunIdFromDispatchOutput,
  preflightCorePackageTarballs,
  preflightDependencyTarballs,
  reconcileReleaseCandidateState,
  resolveArtifactName,
  requireRunIdFromDispatchOutput,
  run,
  validateCandidateChangelogProvenance,
  validateCandidateCheckout,
  validateCandidateReleaseNotes,
  validateFullManifest,
  validateNpmPreflightRunSource,
  validateParallelsRegistryPackageArtifact,
  validatePreflightManifest,
  validateTrustedToolingPin,
  validateWindowsSourceRelease,
} from "../../scripts/release-candidate-checklist.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const publishWorkflowRef = "release-publish/bbbbbbbbbbbb-123";

function candidateGitFixture(files: Record<string, string>) {
  const root = tempDirs.make("openclaw-candidate-");
  const git = (...args: string[]) => run("git", args, { cwd: root, capture: true }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release Fixture");
  git("config", "user.email", "release-fixture@example.com");
  git("config", "commit.gpgsign", "false");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  git("add", ".");
  git("commit", "-m", "test: seed candidate");
  return { root, git };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), init);
}

async function withGithubApiTimeoutEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS;
  process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS;
    } else {
      process.env.OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS = previous;
    }
  }
}

describe("release candidate checklist", () => {
  it.each([
    { tag: "v2026.9.1", pin: "2026.9.1", expected: "passed" },
    { tag: "v2026.9.1", pin: "2026.7.4", expected: "warning" },
    { tag: "v2026.9.1-1", pin: "2026.9.1", expected: "passed" },
    { tag: "v2026.9.1-beta.1", pin: "2026.7.4", expected: undefined },
    { tag: "v2026.9.1-alpha.1", pin: "2026.7.4", expected: undefined },
  ])(
    "records advisory Android pin evidence for $tag ($pin): $expected",
    async ({ tag, pin, expected }) => {
      const { root: targetRoot, git } = candidateGitFixture({
        "package.json": JSON.stringify({ version: tag.slice(1) }),
        "apps/android/version.json": JSON.stringify({ version: pin, versionCode: 2026070401 }),
        "CHANGELOG.md": "# Fixture changelog\n",
      });
      const targetSha = git("rev-parse", "HEAD");
      // The target ref is authoritative even if another checkout has prepared a newer pin.
      writeFileSync(
        join(targetRoot, "apps/android/version.json"),
        JSON.stringify({ version: "2099.1.1" }),
      );
      const options = parseArgs([
        "--tag",
        tag,
        "--full-release-run",
        "111",
        "--npm-preflight-run",
        "222",
        "--skip-dispatch",
        "--skip-parallels",
        "--skip-telegram",
        "--skip-local-generated-check",
        ...(tag.includes("-alpha.")
          ? ["--workflow-ref", "tideclaw/alpha/2026-09-01-1200Z"]
          : ["--publish-workflow-ref", publishWorkflowRef]),
      ]);
      options.outputDir = join(targetRoot, "evidence");
      mkdirSync(join(options.outputDir, "npm-preflight"), { recursive: true });
      writeFileSync(join(options.outputDir, "npm-preflight", "openclaw.tgz"), "fixture");
      const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
      const main = source.match(/^async function main\(\)[\s\S]*?^\}/mu)?.[0];
      const android =
        source.match(/^function checkCandidateAndroidVersion\([\s\S]*?^\}/mu)?.[0] ?? "";
      const log = vi.fn();
      const toolingSha = "b".repeat(40);
      const npmManifest = {
        tarballName: "openclaw.tgz",
        tarballSha256: "fixture-digest",
        corePackageTarballs: [],
        dependencyTarballs: [],
        pluginSdkApi: {},
      };
      // Run the real coordinator and evidence writers; unrelated remote release gates are fixtures.
      await runInNewContext(stripTypeScriptTypes(`${android}\n${main}\nmain();`), {
        process: { argv: [], cwd: () => targetRoot, env: {} },
        console: { log, warn: log },
        TOOLING_ROOT: "/trusted/tooling",
        TRUSTED_TOOLING_SHA_ENV: "OPENCLAW_RELEASE_CANDIDATE_TRUSTED_TOOLING_SHA",
        RELEASE_CANDIDATE_STATE_FILE: "release-candidate-state.json",
        parseArgs: () => options,
        gitTopLevel: (root: string) => root,
        gitRevParse: (_ref: string, root: string) => (root === targetRoot ? targetSha : toolingSha),
        fetchTrustedWorkflowSha: () => toolingSha,
        // The protected publish tag is verified against live GitHub refs in production.
        verifyReleaseToolingIdentity: () => ({
          workflowRef: options.publishWorkflowRef,
          workflowSha: toolingSha,
        }),
        gitTrackedStatus: () => "",
        assertPlannedReleaseTagIsAbsent: () => {},
        validateTrustedToolingPin,
        validateCandidateCheckout,
        buildReleaseCandidateState,
        reconcileReleaseCandidateState,
        writeReleaseCandidateState: () => {},
        updateReleaseCandidateState: (_path: string, state: unknown) => state,
        run: (command: string, args: string[]) =>
          args[0] === "fetch" ? "" : run(command, args, { cwd: targetRoot, capture: true }),
        parseReleaseVersion,
        isRecord,
        requireString: (value: string) => value,
        releaseNotesVersionForTag: () => "2026.9.1",
        validateCandidateReleaseNotes: () => ({ status: "passed" }),
        validateCandidateChangelogProvenance: () => ({ status: "passed", shippedBaselines: [] }),
        runLocalGeneratedCheckIfNeeded: () => ({ status: "skipped" }),
        waitForSuccessfulRun: async () => ({
          run: { headSha: targetSha, runAttempt: 1 },
          source: { workflowRef: options.workflowRef },
        }),
        downloadArtifact: () => {},
        readJson: (file: string) => (file.endsWith("preflight-manifest.json") ? npmManifest : {}),
        validateFullReleaseValidationEvidence: () => ({ source: "direct" }),
        downloadResolvedArtifact: async () => ({ name: "npm-preflight" }),
        verifyNpmPreflightProducer: () => ({}),
        isDeepStrictEqual,
        sha256: () => "fixture-digest",
        validatePreflightManifest: () => {},
        validatePluginSdkApiReleaseEvidence: () => ({ status: "passed" }),
        validateFullManifest: () => {},
        preflightCorePackageTarballs,
        preflightDependencyTarballs,
        runParallelsIfNeeded: async () => ({ status: "skipped" }),
        runTelegramIfNeeded: async () => ({ status: "skipped" }),
        collectPluginPlanWithRetry: async () => ({ all: [] }),
        buildPublishCommand,
        formatJsonValue: String,
        formatShippedBaselineExclusions: () => "",
        formatPluginPlanSummary: () => [],
        join,
        basename,
        existsSync,
        mkdirSync,
        writeFileSync,
      });
      const evidence = JSON.parse(
        readFileSync(join(options.outputDir, "release-candidate-evidence.json"), "utf8"),
      );
      const summary = readFileSync(
        join(options.outputDir, "release-candidate-evidence.md"),
        "utf8",
      );
      const output = log.mock.calls.map(([line]) => line).join("\n");
      expect(evidence.publishCommand).toContain("openclaw-release-publish.yml");
      if (!expected) {
        expect(evidence).not.toHaveProperty("androidVersionCheck");
        expect(summary + output).not.toContain("Android version");
        return;
      }
      expect(evidence.androidVersionCheck).toMatchObject({
        status: expected,
        androidVersion: pin,
        targetVersion: "2026.9.1",
      });
      const message = evidence.androidVersionCheck.message;
      expect(message).toContain(
        expected === "warning" ? "WARNING: Android version" : "PASS: Android version",
      );
      expect(summary).toContain(message);
      expect(output).toContain(message);
      if (expected === "warning") {
        expect(message).toContain("2026.7.4");
        expect(message).toContain(
          "scripts/mobile-release-version.ts --prepare --version 2026.9.1 --write before tagging",
        );
        expect(message).toContain("or accept that Android will not ship for this release");
      }
    },
  );

  it.each(["pnpm-lock.yaml", "missing node_modules", "install failure", "child failure"])(
    "prepares and cleans trusted tooling dependencies: %s",
    (scenario) => {
      const manifest = { version: "2026.9.1", dependencies: { yaml: "2.8.1" } };
      const { root: targetRoot, git } = candidateGitFixture({
        ".gitignore": "node_modules\n",
        "package.json": JSON.stringify(manifest),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "scripts/release-candidate-checklist.mts": [
          'import { parse } from "yaml";',
          'console.log(JSON.stringify({ parsed: parse("ready: true"), cwd: process.cwd() }));',
          'if (process.argv.includes("--fail")) process.exit(7);',
        ].join("\n"),
      });
      const trustedToolingSha = git("rev-parse", "HEAD");
      // The tooling worktree never borrows the target graph, even for a version-only target commit.
      writeFileSync(
        join(targetRoot, "package.json"),
        JSON.stringify({
          ...manifest,
          version: "2026.9.2",
          ...([
            "dependencies",
            "devDependencies",
            "optionalDependencies",
            "peerDependencies",
          ].includes(scenario)
            ? { [scenario]: { yaml: "2.8.2" } }
            : {}),
        }),
      );
      if (["pnpm-lock.yaml", "install failure"].includes(scenario)) {
        writeFileSync(join(targetRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# changed\n");
      }
      git("commit", "-am", "test: target differs from tooling");
      expect(git("rev-parse", "HEAD")).not.toBe(trustedToolingSha);
      const installedModules = realpathSync("node_modules");
      if (scenario !== "missing node_modules") {
        symlinkSync(installedModules, join(targetRoot, "node_modules"), "junction");
      }
      const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
      const owner = source.match(/^function runFromTrustedTooling\([\s\S]*?^\}/mu)?.[0];
      const jsonReader = source.match(/^function readJson\([\s\S]*?^\}/mu)?.[0];
      const installs = vi.fn(
        (_command: string, args: string[], options: Parameters<typeof run>[2]) => {
          expect(args).toEqual([
            "install",
            "--frozen-lockfile",
            "--ignore-scripts",
            "--prefer-offline",
          ]);
          const root = options?.cwd ?? "";
          expect(root).not.toBe(targetRoot);
          expect(existsSync(join(root, "node_modules"))).toBe(false);
          expect(run("git", ["rev-parse", "HEAD"], { cwd: root, capture: true }).trim()).toBe(
            trustedToolingSha,
          );
          if (scenario === "install failure") {
            throw new Error("fixture install failed");
          }
          // Stand in for pnpm's output; never install or modify the shared ready install.
          mkdirSync(join(root, "node_modules"));
          for (const dependency of ["tsx", "yaml"]) {
            symlinkSync(
              join(installedModules, dependency),
              join(root, "node_modules", dependency),
              "junction",
            );
          }
          return "";
        },
      );
      let toolingRoot = "";
      let childOutput = "";
      const execute = () =>
        runInNewContext(
          stripTypeScriptTypes(
            `${jsonReader}\n${owner}\nrunFromTrustedTooling(argv, { targetRoot, workflowRef: "main" });`,
          ),
          {
            existsSync,
            mkdirSync,
            mkdtempSync,
            readFileSync,
            rmSync,
            symlinkSync,
            createRequire,
            pathToFileURL,
            tmpdir,
            join,
            isRecord,
            process,
            console,
            targetRoot,
            argv: [scenario === "child failure" ? "--fail" : "--help"],
            TRUSTED_TOOLING_SHA_ENV: "OPENCLAW_RELEASE_CANDIDATE_TRUSTED_TOOLING_SHA",
            fetchTrustedWorkflowSha: () => trustedToolingSha,
            run: (command: string, args: string[], options: Parameters<typeof run>[2]) =>
              command === "pnpm" ? installs(command, args, options) : run(command, args, options),
            spawnSync: (
              command: string,
              args: string[],
              options: Parameters<typeof spawnSync>[2],
            ) => {
              if (command === process.execPath) {
                const entrypoint = args[2];
                if (!entrypoint) {
                  throw new Error("missing trusted tooling entrypoint");
                }
                toolingRoot = dirname(dirname(entrypoint));
                const child = spawnSync(command, args, {
                  ...options,
                  encoding: "utf8",
                  stdio: "pipe",
                });
                childOutput = child.stdout;
                expect(child.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
                return child;
              }
              return spawnSync(command, args, options);
            },
          },
        );
      if (scenario === "install failure") {
        expect(execute).toThrow("fixture install failed");
      } else if (scenario === "child failure") {
        expect(execute).toThrow("trusted release candidate tooling failed with 7");
      } else {
        execute();
        expect(JSON.parse(childOutput)).toEqual({ parsed: { ready: true }, cwd: targetRoot });
      }
      expect(installs).toHaveBeenCalledTimes(1);
      if (toolingRoot) {
        expect(existsSync(toolingRoot)).toBe(false);
      }
      expect(git("worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
      expect(existsSync(join(installedModules, "yaml"))).toBe(true);
    },
  );

  it.each([
    { warnings: [] },
    {
      warnings: [
        '@openclaw/example@2026.9.1: example-runtime pinned "1.2.3", npm latest is "1.2.4".',
      ],
    },
  ])("keeps plugin plan warnings advisory and visible: $warnings", ({ warnings }) => {
    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
    const owner = source.match(/^function collectPluginPlan\([\s\S]*?^\}/mu)?.[0];
    const summary = source.match(/^function formatPluginPlanSummary\([\s\S]*?^\}/mu)?.[0];
    expect(owner).toBeDefined();
    expect(summary).toBeDefined();
    const log = vi.fn();
    const runPlanner = vi.fn((_command, args, options) =>
      JSON.stringify({ args, options, all: [{ packageName: "@openclaw/example" }], warnings }),
    );
    const result = runInNewContext(
      stripTypeScriptTypes(
        `${summary}\n${owner}\ncollectPluginPlan("scripts/plugin-npm-release-plan.ts", {})`,
      ),
      {
        TOOLING_ROOT: "/trusted/tooling",
        console: { log },
        isRecord,
        join,
        pluginPlanArgs: () => ["--selection-mode", "all-publishable"],
        run: runPlanner,
      },
    );
    expect(result.args).toEqual([
      "--import",
      "tsx",
      "/trusted/tooling/scripts/plugin-npm-release-plan.ts",
      "--selection-mode",
      "all-publishable",
    ]);
    expect(result.options).not.toHaveProperty("cwd");
    expect(result.warnings).toEqual(warnings);
    expect(runPlanner).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      [
        "- scripts/plugin-npm-release-plan.ts: 1 packages",
        ...warnings.map((warning) => `- Warning: ${warning}`),
      ].join("\n"),
    );
  });

  it("routes a repaired publisher independently from immutable preflight evidence", () => {
    const options = parseArgs([
      "--tag",
      "v2026.8.2-beta.1",
      "--publish-workflow-ref",
      publishWorkflowRef,
    ]);
    const producer = {
      status: "passed",
      headSha: "a".repeat(40),
      workflowRef: "release-publish/aaaaaaaaaaaa-122",
    };
    const command = buildPublishCommand(options, producer);
    expect(command).toContain(`'--ref' '${publishWorkflowRef}'`);
    expect(producer.headSha).toBe("a".repeat(40));
    const saved = buildReleaseCandidateState(options, {
      targetSha: "c".repeat(40),
      toolingSha: "b".repeat(40),
    });
    expect(saved.publishWorkflowRef).toBe(publishWorkflowRef);
    expect(() =>
      reconcileReleaseCandidateState(saved, {
        ...saved,
        publishWorkflowRef: "release-publish/bbbbbbbbbbbb-124",
      }),
    ).toThrow("state mismatch for publishWorkflowRef");
  });

  it.each(["main", "refs/tags/release-publish/bbbbbbbbbbbb-123", "release-publish/bbbbbbbbbbbb-0"])(
    "rejects an unprotected publisher selector %s",
    (ref) => {
      expect(() => parseArgs(["--tag", "v2026.8.2-beta.1", "--publish-workflow-ref", ref])).toThrow(
        "protected release-publish tag",
      );
    },
  );

  it.each(["v2026.9.1", "v2026.9.1-beta.1"])(
    "refuses to print a main-sourced publish command for %s",
    (tag) => {
      const options = parseArgs(["--tag", tag]);
      const producer = { status: "passed", headSha: "a".repeat(40), workflowRef: "main" };
      for (const source of [undefined, producer]) {
        expect(() => buildPublishCommand(options, source)).toThrow(
          "--publish-workflow-ref release-publish/<sha12>-<epoch>",
        );
        expect(buildPublishCommand({ ...options, publishWorkflowRef }, source)).toContain(
          `'--ref' '${publishWorkflowRef}'`,
        );
      }
    },
  );

  it("recognizes direct execution through a symlinked temporary root", () => {
    const realpath = vi.fn((value: string) => value.replace(/^\/tmp\//u, "/private/tmp/"));

    expect(
      isDirectReleaseCandidateExecution(
        "/tmp/openclaw-release-tooling/checkout/scripts/release-candidate-checklist.mts",
        "/private/tmp/openclaw-release-tooling/checkout/scripts/release-candidate-checklist.mts",
        realpath,
      ),
    ).toBe(true);
    expect(isDirectReleaseCandidateExecution(undefined, "/private/tmp/script.mjs", realpath)).toBe(
      false,
    );
  });

  it("resumes exact workflow runs from matching release candidate state", () => {
    const options = parseArgs(["--tag", "v2026.7.1-beta.4"]);
    const expected = buildReleaseCandidateState(options, {
      targetSha: "a".repeat(40),
      toolingSha: "b".repeat(40),
    });
    const resumed = reconcileReleaseCandidateState(
      structuredClone({
        ...expected,
        phase: "waiting",
        fullReleaseRunId: "111",
        npmPreflightRunId: "222",
      }),
      expected,
    );

    expect(resumed).toMatchObject({
      phase: "waiting",
      fullReleaseRunId: "111",
      npmPreflightRunId: "222",
    });
  });

  it("treats the release tag as a planned post-validation identity", () => {
    const options = parseArgs(["--tag", "v2026.7.1-beta.4", "--target-sha", "a".repeat(40)]);

    expect(options.targetSha).toBe("a".repeat(40));
    expect(() => assertPlannedReleaseTagIsAbsent("v2026.7.1-beta.4", () => true)).toThrow(
      "already exists",
    );
    expect(() => assertPlannedReleaseTagIsAbsent("v2026.7.1-beta.4", () => false)).not.toThrow();
    expect(() => parseArgs(["--tag", "v2026.7.1-beta.4", "--target-sha", "not-a-sha"])).toThrow(
      "--target-sha must be a full lowercase commit SHA",
    );
  });

  it("rejects stale or conflicting release candidate state", () => {
    const options = parseArgs(["--tag", "v2026.7.1-beta.4"]);
    const expected = buildReleaseCandidateState(options, {
      targetSha: "a".repeat(40),
      toolingSha: "b".repeat(40),
    });

    expect(() =>
      reconcileReleaseCandidateState({ ...expected, targetSha: "c".repeat(40) }, expected),
    ).toThrow("state mismatch for targetSha");
    expect(() =>
      reconcileReleaseCandidateState(
        { ...expected, fullReleaseRunId: "111" },
        { ...expected, fullReleaseRunId: "333" },
      ),
    ).toThrow("state mismatch for fullReleaseRunId");
  });

  it("captures changelogs larger than the Node spawnSync default buffer", () => {
    const output = run(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
      { capture: true },
    );

    expect(output).toHaveLength(2 * 1024 * 1024);
  });

  it("passes scoped environment overrides to release child commands", () => {
    const output = run(
      process.execPath,
      ["-e", "process.stdout.write(process.env.OPENCLAW_RELEASE_TEST_VALUE ?? '')"],
      { capture: true, env: { OPENCLAW_RELEASE_TEST_VALUE: "passed" } },
    );

    expect(output).toBe("passed");
  });

  it("keeps the frozen release target separate from clean trusted workflow tooling", () => {
    expect(
      validateCandidateCheckout({
        targetSha: "a".repeat(40),
        targetHeadSha: "a".repeat(40),
        targetTrackedStatus: "",
        toolingSha: "b".repeat(40),
        trustedToolingSha: "b".repeat(40),
        toolingTrackedStatus: "",
        workflowRef: "main",
      }),
    ).toEqual({
      status: "passed",
      targetSha: "a".repeat(40),
      toolingSha: "b".repeat(40),
      workflowRef: "main",
    });
    expect(() =>
      validateCandidateCheckout({
        targetSha: "a".repeat(40),
        targetHeadSha: "c".repeat(40),
        targetTrackedStatus: "",
        toolingSha: "b".repeat(40),
        trustedToolingSha: "b".repeat(40),
        toolingTrackedStatus: "",
        workflowRef: "main",
      }),
    ).toThrow("target worktree HEAD");
    expect(() =>
      validateCandidateCheckout({
        targetSha: "a".repeat(40),
        targetHeadSha: "a".repeat(40),
        targetTrackedStatus: " M package.json",
        toolingSha: "b".repeat(40),
        trustedToolingSha: "b".repeat(40),
        toolingTrackedStatus: "",
        workflowRef: "main",
      }),
    ).toThrow("clean tracked target worktree");
    expect(() =>
      validateCandidateCheckout({
        targetSha: "a".repeat(40),
        targetHeadSha: "a".repeat(40),
        targetTrackedStatus: "",
        toolingSha: "b".repeat(40),
        trustedToolingSha: "c".repeat(40),
        toolingTrackedStatus: "",
        workflowRef: "main",
      }),
    ).toThrow("does not match trusted main");
    expect(() =>
      validateCandidateCheckout({
        targetSha: "a".repeat(40),
        targetHeadSha: "a".repeat(40),
        targetTrackedStatus: "",
        toolingSha: "b".repeat(40),
        trustedToolingSha: "b".repeat(40),
        toolingTrackedStatus: " M scripts/release-candidate-checklist.mts",
        workflowRef: "main",
      }),
    ).toThrow("clean tracked tooling checkout");
    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
    expect(source).toContain('const TOOLING_ROOT = fileURLToPath(new URL("../", import.meta.url))');
    expect(source).toContain("`+refs/heads/${workflowRef}:${remoteRef}`");
    expect(source).toContain(
      "const latestTrustedToolingSha = fetchTrustedWorkflowSha(options.workflowRef, TOOLING_ROOT)",
    );
    expect(source).toContain('targetHeadSha: gitRevParse("HEAD", targetRoot)');
    expect(source).toContain("toolingTrackedStatus: gitTrackedStatus(TOOLING_ROOT)");
  });

  it("keeps the exact pinned trusted tooling valid when main advances", () => {
    const isAncestor = vi.fn(() => true);

    expect(
      validateTrustedToolingPin({
        toolingSha: "a".repeat(40),
        pinnedToolingSha: "a".repeat(40),
        latestTrustedToolingSha: "b".repeat(40),
        isAncestor,
      }),
    ).toBe("a".repeat(40));
    expect(isAncestor).toHaveBeenCalledWith("a".repeat(40), "b".repeat(40));
    expect(() =>
      validateTrustedToolingPin({
        toolingSha: "a".repeat(40),
        pinnedToolingSha: "b".repeat(40),
        latestTrustedToolingSha: "b".repeat(40),
        isAncestor: () => true,
      }),
    ).toThrow("does not match pinned tooling");
    expect(() =>
      validateTrustedToolingPin({
        toolingSha: "a".repeat(40),
        pinnedToolingSha: "a".repeat(40),
        latestTrustedToolingSha: "c".repeat(40),
        isAncestor: () => false,
      }),
    ).toThrow("pinned release candidate tooling");
  });

  it("validates the exact tag changelog before dispatching the release matrix", () => {
    const check = validateCandidateReleaseNotes({
      changelog: [
        "# Changelog",
        "",
        "## 2026.7.1",
        "",
        "### Highlights",
        "",
        "- User-facing notes.",
        "",
        "### Complete contribution record",
        "",
        `- **PR #123** ${"record ".repeat(20_000)}`,
      ].join("\n"),
      repository: "openclaw/openclaw",
      tag: "v2026.7.1-beta.3",
    });
    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
    const validationIndex = source.indexOf(
      "const releaseNotesCheck = validateCandidateReleaseNotes",
    );
    const fullMatrixDispatchIndex = source.indexOf(
      "if (!options.fullReleaseRunId && !options.skipDispatch)",
    );

    expect(check).toMatchObject({ status: "passed", mode: "compact" });
    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(fullMatrixDispatchIndex).toBeGreaterThan(validationIndex);
    expect(source).toContain('run("git", ["show", `${targetSha}:CHANGELOG.md`]');
  });

  it("rejects contribution-record provenance outside the release tag history", () => {
    const base = "v2026.6.11";
    const recordedTarget = "a".repeat(40);
    const targetSha = "b".repeat(40);
    const changelog = [
      "# Changelog",
      "",
      "## 2026.7.1",
      "",
      "### Highlights",
      "",
      "- User-facing notes.",
      "",
      "### Complete contribution record",
      "",
      `This audited record covers the complete ${base}..${recordedTarget} history: 1 merged PR.`,
      "",
      "#### Pull requests",
      "",
      "- **PR #123** fix: example.",
    ].join("\n");
    const reachable = vi.fn((ancestor: string, target: string) => {
      return ancestor === base && target === recordedTarget;
    });

    expect(() =>
      validateCandidateChangelogProvenance({
        changelog,
        version: "2026.7.1",
        tag: "v2026.7.1-beta.3",
        targetSha,
        isAncestor: reachable,
      }),
    ).toThrow(`contribution record target ${recordedTarget} is not reachable`);
    expect(reachable).toHaveBeenCalledWith(base, recordedTarget);
    expect(reachable).toHaveBeenCalledWith(recordedTarget, targetSha);
  });

  it("rejects duplicate contribution record rows even when the declared count matches", () => {
    const targetSha = "b".repeat(40);
    const changelog = [
      "# Changelog",
      "",
      "## 2026.7.1",
      "",
      "### Highlights",
      "",
      "- User-facing notes.",
      "",
      "### Complete contribution record",
      "",
      `This audited record covers the complete base..${targetSha} history: 1 merged PR.`,
      "",
      "#### Pull requests",
      "",
      "- **PR #123** fix: example.",
      "- **PR #123** fix: duplicate.",
    ].join("\n");

    expect(() =>
      validateCandidateChangelogProvenance({
        changelog,
        version: "2026.7.1",
        tag: "v2026.7.1-beta.3",
        targetSha,
        isAncestor: () => true,
      }),
    ).toThrow("duplicate contribution record PR #123");
  });

  it("rejects canonical provenance whose unique total does not match the PR rows", () => {
    const targetSha = "b".repeat(40);
    const changelog = [
      "# Changelog",
      "",
      "## 2026.7.1",
      "",
      "### Highlights",
      "",
      "- User-facing notes.",
      "",
      "### Complete contribution record",
      "",
      `This audited record covers the complete base..${targetSha} history: 1 in-range PR + 1 retained seed-only PR = 2 unique PRs.`,
      "",
      "#### Pull requests",
      "",
      "- **PR #123** fix: example.",
    ].join("\n");

    expect(() =>
      validateCandidateChangelogProvenance({
        changelog,
        version: "2026.7.1",
        tag: "v2026.7.1-beta.3",
        targetSha,
        isAncestor: () => true,
      }),
    ).toThrow("contribution record row count 1 != 2");
  });

  it("uses numbered historical record rows and skips Unreleased baseline rows", () => {
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "### Complete contribution record",
      "",
      "This audited record covers the complete base..HEAD history: 99 merged PRs.",
      "",
      "#### Pull requests",
      "",
      "- **PR #1** fix: not shipped.",
      "",
      "## 2026.6.11",
      "",
      "### Complete contribution record",
      "",
      "This audited record covers the complete base..HEAD history: 0 merged PRs.",
      "",
      "#### Pull requests",
      "",
      "- **PR #2** fix: shipped.",
    ].join("\n");

    expect([...candidateCumulativeShippedPullRequests(changelog, "test baseline")]).toEqual([2]);
  });

  it("rejects duplicate historical contribution record rows without exact provenance", () => {
    const changelog = [
      "# Changelog",
      "",
      "## 2026.6.11",
      "",
      "### Complete contribution record",
      "",
      "This audited record covers the complete base..HEAD history: 1 merged PR.",
      "",
      "#### Pull requests",
      "",
      "- **PR #2** fix: shipped.",
      "- **PR #2** fix: duplicate.",
    ].join("\n");

    expect(() => candidateCumulativeShippedPullRequests(changelog, "test baseline")).toThrow(
      "test baseline section 2026.6.11 contains duplicate contribution record PR #2",
    );
  });

  it("validates cumulative shipped baseline exclusion metadata", () => {
    const base = "66e676d29b92d040716376a75aca32bad655cfac";
    const recordedTarget = "a".repeat(40);
    const changelog = [
      "# Changelog",
      "",
      "## 2026.7.1",
      "",
      "### Highlights",
      "",
      "- User-facing notes.",
      "",
      "### Complete contribution record",
      "",
      `This audited record covers the complete ${base}..${recordedTarget} history: 1 merged PR.`,
      "",
      "Shipped baseline exclusions: v2026.6.11 (8 PRs: #101, #102, #103, #104, #105, #106, #107, #108).",
      "",
      "#### Pull requests",
      "",
      "- **PR #123** fix: example.",
    ].join("\n");
    const shippedPullRequests = new Set([101, 102, 103, 104, 105, 106, 107, 108]);
    const loadShippedBaseline = vi.fn(() => ({
      ref: "v2026.6.11",
      pullRequests: shippedPullRequests,
    }));
    expect(
      validateCandidateChangelogProvenance({
        changelog,
        version: "2026.7.1",
        tag: "v2026.7.1-beta.3",
        targetSha: recordedTarget,
        isAncestor: () => true,
        loadShippedBaseline,
      }),
    ).toEqual({
      status: "passed",
      base,
      target: recordedTarget,
      shippedBaselines: [
        {
          ref: "v2026.6.11",
          count: 8,
          pullRequests: [101, 102, 103, 104, 105, 106, 107, 108],
        },
      ],
    });
    expect(loadShippedBaseline).toHaveBeenCalledWith("v2026.6.11");

    expect(() =>
      validateCandidateChangelogProvenance({
        changelog: changelog.replace("8 PRs:", "8 pull requests:"),
        version: "2026.7.1",
        tag: "v2026.7.1-beta.3",
        targetSha: recordedTarget,
        isAncestor: () => true,
        loadShippedBaseline,
      }),
    ).toThrow("malformed shipped baseline exclusion");
    expect(() =>
      validateCandidateChangelogProvenance({
        changelog,
        version: "2026.7.1",
        tag: "v2026.7.1-beta.3",
        targetSha: recordedTarget,
        isAncestor: () => true,
        loadShippedBaseline: () => ({
          ref: "v2026.6.11",
          pullRequests: new Set([...shippedPullRequests].slice(1)),
        }),
      }),
    ).toThrow("lists PRs absent from shipped baseline v2026.6.11: #101");
    expect(() =>
      validateCandidateChangelogProvenance({
        changelog: changelog.replace(
          "- **PR #123** fix: example.",
          "- **PR #101** fix: already shipped.",
        ),
        version: "2026.7.1",
        tag: "v2026.7.1-beta.3",
        targetSha: recordedTarget,
        isAncestor: () => true,
        loadShippedBaseline,
      }),
    ).toThrow("still contains shipped PRs from v2026.6.11: #101");
  });

  it("requires contribution records for beta candidates but permits alpha Unreleased fallback", () => {
    const betaChangelog = [
      "# Changelog",
      "",
      "## 2026.7.1",
      "",
      "### Highlights",
      "",
      "- User-facing notes.",
    ].join("\n");
    expect(() =>
      validateCandidateChangelogProvenance({
        changelog: betaChangelog,
        version: "2026.7.1",
        tag: "v2026.7.1-beta.3",
        targetSha: "a".repeat(40),
      }),
    ).toThrow("missing ### Complete contribution record");

    const alpha = validateCandidateChangelogProvenance({
      changelog: betaChangelog.replace("## 2026.7.1", "## Unreleased"),
      version: "2026.7.1",
      tag: "v2026.7.1-alpha.1",
      targetSha: "a".repeat(40),
    });
    expect(alpha).toEqual({
      status: "skipped",
      reason: "alpha release uses the explicit Unreleased fallback",
      shippedBaselines: [],
    });
  });

  it("infers validation profiles from candidate tags", () => {
    expect(parseArgs(["--tag", "v2026.5.14-beta.3"]).releaseProfile).toBe("beta");
    expect(parseArgs(["--tag", "v2026.5.14"]).releaseProfile).toBe("stable");
    expect(parseArgs(["--tag", "v2026.5.14", "--release-profile", "full"]).releaseProfile).toBe(
      "full",
    );
  });

  it("defaults beta and alpha Parallels to postpublish confidence", () => {
    const beta = parseArgs(["--tag", "v2026.5.14-beta.3"]);
    const alpha = parseArgs([
      "--tag",
      "v2026.5.14-alpha.2",
      "--workflow-ref",
      "tideclaw/alpha/2026-07-10-1200Z",
      "--npm-dist-tag",
      "alpha",
    ]);

    for (const options of [beta, alpha]) {
      expect(options.releaseProfile).toBe("beta");
      expect(options.parallelsMode).toBe("auto");
      expect(options.skipParallels).toBe(true);
      expect(options.parallelsSkipReason).toBe("deferred to postpublish release:beta-smoke");
    }
  });

  it("supports explicit and profile-default Parallels execution", () => {
    const beta = parseArgs(["--tag", "v2026.5.14-beta.3", "--run-parallels"]);
    const stable = parseArgs(["--tag", "v2026.5.14", "--windows-node-tag", "v0.6.3"]);
    const full = parseArgs([
      "--tag",
      "v2026.5.14",
      "--windows-node-tag",
      "v0.6.3",
      "--release-profile",
      "full",
    ]);

    expect(beta).toMatchObject({
      parallelsMode: "run",
      parallelsSkipReason: "",
      skipParallels: false,
    });
    for (const options of [stable, full]) {
      expect(options.parallelsMode).toBe("auto");
      expect(options.skipParallels).toBe(false);
      expect(options.parallelsSkipReason).toBe("");
    }
  });

  it("supports an explicit Parallels skip without changing persisted state shape", () => {
    const options = parseArgs([
      "--tag",
      "v2026.5.14",
      "--windows-node-tag",
      "v0.6.3",
      "--skip-parallels",
    ]);
    const state = buildReleaseCandidateState(options, {
      targetSha: "a".repeat(40),
      toolingSha: "b".repeat(40),
    });

    expect(options).toMatchObject({
      parallelsMode: "skip",
      parallelsSkipReason: "operator skipped --skip-parallels",
      skipParallels: true,
    });
    expect(state.skipParallels).toBe(true);
    expect(state).not.toHaveProperty("parallelsMode");
    expect(state).not.toHaveProperty("parallelsSkipReason");
    expect(state).not.toHaveProperty("runParallels");
  });

  it("rejects conflicting Parallels modes", () => {
    expect(() =>
      parseArgs(["--tag", "v2026.5.14-beta.3", "--run-parallels", "--skip-parallels"]),
    ).toThrow("--run-parallels and --skip-parallels cannot be combined");
  });

  it("runs Parallels against the exact prepared candidate tarball", () => {
    expect(candidateParallelsArgs(".artifacts/preflight/openclaw.tgz", [], "/trusted")).toEqual([
      "exec",
      "tsx",
      "/trusted/scripts/e2e/parallels/npm-update-smoke.ts",
      "--target-tarball",
      ".artifacts/preflight/openclaw.tgz",
      "--json",
    ]);
    const command = candidateParallelsShellCommand(
      ".artifacts/preflight/openclaw candidate.tgz",
      "/opt/homebrew/bin/gtimeout",
    );
    expect(command).toContain(
      `set -a; source "$HOME/.profile" >/dev/null 2>&1 || true; set +a; export PATH='${dirname(process.execPath)}':"$PATH"; exec '/opt/homebrew/bin/gtimeout' --foreground 150m pnpm`,
    );
    expect(
      candidateParallelsShellCommand(
        ".artifacts/preflight/openclaw candidate.tgz",
        "/opt/homebrew/bin/gtimeout",
        [".artifacts/preflight/openclaw-ai candidate.tgz"],
      ),
    ).toContain("'--target-tarball' '.artifacts/preflight/openclaw candidate.tgz'");
    expect(
      candidateParallelsArgs(
        ".artifacts/preflight/openclaw.tgz",
        [".artifacts/preflight/openclaw-ai.tgz"],
        "/trusted",
        [".artifacts/preflight/openclaw-codex.tgz"],
        "macOS 26.5 Node 24",
      ),
    ).toEqual([
      "exec",
      "tsx",
      "/trusted/scripts/e2e/parallels/npm-update-smoke.ts",
      "--target-tarball",
      ".artifacts/preflight/openclaw.tgz",
      "--dependency-tarball",
      ".artifacts/preflight/openclaw-ai.tgz",
      "--registry-package-tarball",
      ".artifacts/preflight/openclaw-codex.tgz",
      "--macos-snapshot-hint",
      "macOS 26.5 Node 24",
      "--json",
    ]);
  });

  it("accepts repeatable candidate registry package artifacts", () => {
    expect(
      parseArgs([
        "--tag",
        "v2026.7.1-beta.3",
        "--parallels-registry-package-artifact",
        "/tmp/codex-artifact",
        "--parallels-registry-package-artifact",
        "/tmp/matrix-artifact",
      ]).parallelsRegistryPackageArtifactDirs,
    ).toEqual(["/tmp/codex-artifact", "/tmp/matrix-artifact"]);
  });

  it("binds Parallels registry packages to plugin preflight manifests", () => {
    const artifactDir = tempDirs.make("openclaw-plugin-preflight-");
    const tarballName = "openclaw-codex-2026.7.1-beta.3.tgz";
    const tarballPath = join(artifactDir, tarballName);
    const sourceDir = join(artifactDir, "source");
    const packageDir = join(sourceDir, "package");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({ name: "@openclaw/codex", version: "2026.7.1-beta.3" })}\n`,
    );
    execFileSync("tar", ["-czf", tarballPath, "-C", sourceDir, "package"]);
    rmSync(sourceDir, { force: true, recursive: true });
    const tarballSha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
    const manifestPath = join(artifactDir, "plugin-publication-manifest.json");
    const manifest = {
      schema: "openclaw.plugin-publication-artifact/v1",
      schemaVersion: 1,
      targetSha: "candidate-sha",
      package: { name: "@openclaw/codex", version: "2026.7.1-beta.3" },
      artifact: {
        name: "plugin-npm-package-codex",
        tarball: tarballName,
        sha256: tarballSha256,
      },
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);

    expect(
      validateParallelsRegistryPackageArtifact(artifactDir, {
        targetSha: "candidate-sha",
        targetVersion: "2026.7.1-beta.3",
      }),
    ).toMatchObject({
      artifactName: "plugin-npm-package-codex",
      packageName: "@openclaw/codex",
      packageVersion: "2026.7.1-beta.3",
      tarballPath,
      tarballSha256,
    });
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      `${JSON.stringify({ name: "@openclaw/matrix", version: "2026.7.1-beta.3" })}\n`,
    );
    execFileSync("tar", ["-czf", tarballPath, "-C", sourceDir, "package"]);
    rmSync(sourceDir, { force: true, recursive: true });
    const mismatchedSha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        ...manifest,
        artifact: { ...manifest.artifact, sha256: mismatchedSha256 },
      })}\n`,
    );
    expect(() =>
      validateParallelsRegistryPackageArtifact(artifactDir, {
        targetSha: "candidate-sha",
        targetVersion: "2026.7.1-beta.3",
      }),
    ).toThrow("tarball identity mismatch");
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, targetSha: "other-sha" })}\n`);
    expect(() =>
      validateParallelsRegistryPackageArtifact(artifactDir, {
        targetSha: "candidate-sha",
        targetVersion: "2026.7.1-beta.3",
      }),
    ).toThrow("artifact identity is invalid");
  });

  it("requires exact dependency tarball metadata in npm preflight manifests", () => {
    const manifest = {
      releaseTag: "v2026.7.1-beta.3",
      releaseSha: "candidate-sha",
      npmDistTag: "beta",
      tarballName: "openclaw-2026.7.1-beta.3.tgz",
      tarballSha256: "root-sha",
      dependencyTarballs: [
        {
          packageName: "@openclaw/ai",
          packageVersion: "2026.7.1-beta.3",
          tarballName: "openclaw-ai-2026.7.1-beta.3.tgz",
          tarballSha256: "ai-sha",
        },
      ],
    };
    const params = {
      tag: "v2026.7.1-beta.3",
      targetSha: "candidate-sha",
      npmDistTag: "beta",
    };

    expect(() => validatePreflightManifest(manifest, params)).not.toThrow();
    expect(() =>
      validatePreflightManifest({ ...manifest, dependencyTarballs: undefined }, params),
    ).toThrow("missing dependency tarball metadata");
    expect(() =>
      validatePreflightManifest(
        {
          ...manifest,
          dependencyTarballs: [
            {
              ...manifest.dependencyTarballs[0],
              tarballName: "../openclaw-ai.tgz",
            },
          ],
        },
        params,
      ),
    ).toThrow("invalid dependency tarball metadata");
  });

  it("prefers the complete core package tarball set with legacy manifest fallback", () => {
    const legacyTarball = {
      packageName: "@openclaw/ai",
      packageVersion: "2026.7.1-beta.3",
      tarballName: "openclaw-ai-2026.7.1-beta.3.tgz",
      tarballSha256: "ai-sha",
    };
    const gatewayProtocolTarball = {
      packageName: "@openclaw/gateway-protocol",
      packageVersion: "2026.7.1-beta.3",
      tarballName: "openclaw-gateway-protocol-2026.7.1-beta.3.tgz",
      tarballSha256: "protocol-sha",
    };

    expect(
      preflightCorePackageTarballs({
        corePackageTarballs: [legacyTarball, gatewayProtocolTarball],
        dependencyTarballs: [legacyTarball],
      }),
    ).toEqual([legacyTarball, gatewayProtocolTarball]);
    expect(preflightCorePackageTarballs({ dependencyTarballs: [legacyTarball] })).toEqual([
      legacyTarball,
    ]);
    expect(() =>
      preflightCorePackageTarballs({
        corePackageTarballs: null,
        dependencyTarballs: [legacyTarball],
      }),
    ).toThrow("missing dependency tarball metadata");
  });

  it("passes only root dependency tarballs to Parallels with legacy fallback", () => {
    const aiTarball = {
      packageName: "@openclaw/ai",
      packageVersion: "2026.7.1-beta.3",
      tarballName: "openclaw-ai-2026.7.1-beta.3.tgz",
      tarballSha256: "ai-sha",
    };
    const gatewayProtocolTarball = {
      packageName: "@openclaw/gateway-protocol",
      packageVersion: "2026.7.1-beta.3",
      tarballName: "openclaw-gateway-protocol-2026.7.1-beta.3.tgz",
      tarballSha256: "protocol-sha",
    };
    const gatewayClientTarball = {
      packageName: "@openclaw/gateway-client",
      packageVersion: "2026.7.1-beta.3",
      tarballName: "openclaw-gateway-client-2026.7.1-beta.3.tgz",
      tarballSha256: "client-sha",
    };
    const corePackageTarballs = [aiTarball, gatewayProtocolTarball, gatewayClientTarball];

    expect(
      preflightDependencyTarballs({
        corePackageTarballs,
        dependencyTarballs: [aiTarball],
      }),
    ).toEqual([aiTarball]);
    expect(preflightDependencyTarballs({ corePackageTarballs })).toEqual(corePackageTarballs);
    const manifest = {
      releaseTag: "v2026.7.1-beta.3",
      releaseSha: "candidate-sha",
      npmDistTag: "beta",
      tarballName: "openclaw-2026.7.1-beta.3.tgz",
      tarballSha256: "root-sha",
      corePackageTarballs,
      dependencyTarballs: [aiTarball],
    };
    const params = {
      tag: manifest.releaseTag,
      targetSha: manifest.releaseSha,
      npmDistTag: manifest.npmDistTag,
    };
    expect(() => validatePreflightManifest(manifest, params)).not.toThrow();
    expect(() =>
      validatePreflightManifest(
        {
          ...manifest,
          dependencyTarballs: [
            {
              ...aiTarball,
              tarballName: gatewayProtocolTarball.tarballName,
              tarballSha256: gatewayProtocolTarball.tarballSha256,
            },
          ],
        },
        params,
      ),
    ).toThrow("does not match the core package manifest");
    expect(() =>
      preflightDependencyTarballs({
        corePackageTarballs,
        dependencyTarballs: null,
      }),
    ).toThrow("missing dependency tarball metadata");
  });

  describe("npm preflight source", () => {
    const repo = "openclaw/openclaw";
    const headSha = "a".repeat(40);
    const protectedRef = `release-publish/${headSha.slice(0, 12)}-123`;
    const workflowRun = {
      databaseId: 456,
      runAttempt: 2,
      repository: repo,
      workflowName: "OpenClaw NPM Release",
      workflowPath: ".github/workflows/openclaw-npm-release.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      headSha,
    };
    const source = {
      repository: repo,
      runId: "456",
      workflowRef: "main",
      workflowRun,
      isTrustedWorkflowAncestor: () => true,
    };
    const tagRef = {
      ref: `refs/tags/${protectedRef}`,
      object: { type: "commit", sha: headSha },
    };
    const api = (tag: unknown = tagRef, branches: unknown = []) => ({
      token: "",
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes(`/repos/${repo}/git/ref/tags/`)) {
          return jsonResponse(tag);
        }
        if (url.includes(`/repos/${repo}/git/matching-refs/heads/`)) {
          return jsonResponse(branches);
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    });

    it.each(["main", "tideclaw/alpha/2026-07-10-1200Z"])(
      "retains the exact %s npm workflow source",
      async (workflowRef) => {
        const isTrustedWorkflowAncestor = vi.fn(() => true);
        expect(
          await validateNpmPreflightRunSource({
            ...source,
            workflowRef,
            workflowRun: { ...workflowRun, headBranch: workflowRef },
            isTrustedWorkflowAncestor,
          }),
        ).toEqual({ status: "passed", headSha, workflowRef });
        expect(isTrustedWorkflowAncestor).toHaveBeenCalledWith(
          headSha,
          `refs/remotes/origin/${workflowRef}`,
        );
      },
    );

    it("accepts and records a protected npm preflight tag from trusted main", async () => {
      const validated = await validateNpmPreflightRunSource(
        { ...source, workflowRun: { ...workflowRun, headBranch: protectedRef } },
        api(),
      );
      expect(validated).toEqual({ status: "passed", headSha, workflowRef: protectedRef });
      expect(buildPublishCommand(parseArgs(["--tag", "v2026.7.1-beta.3"]), validated)).toContain(
        `'--ref' '${protectedRef}'`,
      );
    });

    it.each([
      ["moved", { ...tagRef, object: { type: "commit", sha: "b".repeat(40) } }],
      ["annotated", { ...tagRef, object: { type: "tag", sha: headSha } }],
      ["missing", null],
    ])("rejects a %s protected npm preflight tag", async (_label, tag) => {
      await expect(
        Promise.resolve().then(() =>
          validateNpmPreflightRunSource(
            {
              ...source,
              workflowRun: { ...workflowRun, headBranch: protectedRef },
            },
            api(tag),
          ),
        ),
      ).rejects.toThrow("protected release tooling tag");
    });

    it("rejects a same-name branch instead of inferring tag provenance", async () => {
      await expect(
        Promise.resolve().then(() =>
          validateNpmPreflightRunSource(
            {
              ...source,
              workflowRun: { ...workflowRun, headBranch: protectedRef },
            },
            api(tagRef, [{ ref: `refs/heads/${protectedRef}` }]),
          ),
        ),
      ).rejects.toThrow("ambiguous");
    });

    it.each([{}, [{}], [{ ref: 42 }]])(
      "rejects malformed branch lookup data %j",
      async (branches) => {
        await expect(
          validateNpmPreflightRunSource(
            {
              ...source,
              workflowRun: { ...workflowRun, headBranch: protectedRef },
            },
            api(tagRef, branches),
          ),
        ).rejects.toThrow("ambiguous");
      },
    );

    it.each([404, 503])("rejects unreadable tag provenance with HTTP %s", async (status) => {
      await expect(
        validateNpmPreflightRunSource(
          {
            ...source,
            workflowRun: { ...workflowRun, headBranch: protectedRef },
          },
          { token: "", fetchImpl: async () => jsonResponse({}, { status }) },
        ),
      ).rejects.toThrow(`failed with ${status}`);
    });

    it.each([
      { databaseId: 457 },
      { runAttempt: 0 },
      { repository: "other/openclaw" },
      { workflowName: "Other workflow" },
      { workflowPath: ".github/workflows/unrelated.yml" },
      { event: "push" },
      { status: "in_progress" },
      { conclusion: "failure" },
      { headSha: "not-a-sha" },
      { headBranch: "release/2026.7.1" },
      { headBranch: `release-publish/${"b".repeat(12)}-123` },
      { headBranch: `release-publish/${"a".repeat(12)}-0` },
      { workflowPath: ".github/workflows/openclaw-npm-release.yml@refs/heads/other" },
    ])("rejects mismatched npm preflight identity %j", async (override) => {
      await expect(
        Promise.resolve().then(() =>
          validateNpmPreflightRunSource(
            {
              ...source,
              workflowRun: { ...workflowRun, ...override },
            },
            api(),
          ),
        ),
      ).rejects.toThrow();
    });

    it("rejects npm preflight workflow code outside the trusted ref", async () => {
      await expect(
        Promise.resolve().then(() =>
          validateNpmPreflightRunSource({
            ...source,
            isTrustedWorkflowAncestor: () => false,
          }),
        ),
      ).rejects.toThrow("is not reachable from trusted main");
    });
  });

  it("requires run ids when dispatch is disabled", () => {
    expect(() => parseArgs(["--tag", "v2026.5.14-beta.3", "--skip-dispatch"])).toThrow(
      "--skip-dispatch requires --full-release-run",
    );
  });

  it("uses trusted main for regular release workflow tooling", () => {
    expect(parseArgs(["--tag", "v2026.5.14-beta.3"]).workflowRef).toBe("main");
    expect(() =>
      parseArgs(["--tag", "v2026.5.14-beta.3", "--workflow-ref", "release/2026.5.14"]),
    ).toThrow("--workflow-ref must be main");
  });

  it("keeps release validation context on the canonical release branch", () => {
    expect(releaseBranchForTag("v2026.7.1-beta.4")).toBe("release/2026.7.1");
    expect(releaseBranchForTag("v2026.7.1")).toBe("release/2026.7.1");
    expect(releaseBranchForTag("v2026.7.1-1")).toBe("release/2026.7.1-1");
    expect(releaseBranchForTag("v2026.7.1-alpha.4")).toBe("");

    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
    expect(source).toContain("target_context_ref: targetContextRef");
  });

  it("preserves the matching Tideclaw alpha workflow source", () => {
    const workflowRef = "tideclaw/alpha/2026-07-10-1200Z";
    const options = parseArgs([
      "--tag",
      "v2026.7.1-alpha.3",
      "--workflow-ref",
      workflowRef,
      "--npm-dist-tag",
      "alpha",
    ]);

    expect(options.workflowRef).toBe(workflowRef);
    expect(buildPublishCommand(options)).toContain(`'--ref' '${workflowRef}'`);
    expect(() => parseArgs(["--tag", "v2026.7.1-alpha.3"])).toThrow(
      "--workflow-ref must be the matching tideclaw/alpha/",
    );
  });

  it("rejects duplicate release candidate CLI options", () => {
    const requiredArgs = ["--tag", "v2026.5.14-beta.3"];
    const duplicateOption = (
      flag: string,
      firstValue: string,
      secondValue: string,
      prefix = requiredArgs,
    ): [string, string[]] => [flag, [...prefix, flag, firstValue, flag, secondValue]];
    const duplicateFlag = (flag: string): [string, string[]] => [
      flag,
      [...requiredArgs, flag, flag],
    ];
    const duplicateCases = [
      duplicateOption("--tag", "v2026.5.14-beta.3", "v2026.5.14-beta.4", []),
      duplicateOption("--workflow-ref", "release/a", "release/b"),
      duplicateOption("--repo", "openclaw/openclaw", "fork/openclaw"),
      duplicateOption("--full-release-run", "111", "222"),
      duplicateOption("--npm-preflight-run", "111", "222"),
      duplicateOption("--windows-node-tag", "v0.6.3", "v0.6.4"),
      duplicateFlag("--skip-dispatch"),
      duplicateFlag("--skip-local-generated-check"),
      duplicateFlag("--run-parallels"),
      duplicateFlag("--skip-parallels"),
      duplicateFlag("--skip-telegram"),
      duplicateOption("--telegram-provider-mode", "mock-openai", "live-frontier"),
      duplicateOption("--provider", "blacksmith-testbox", "crabbox"),
      duplicateOption("--mode", "fresh", "upgrade"),
      duplicateOption("--release-profile", "beta", "stable"),
      duplicateOption("--npm-dist-tag", "beta", "latest"),
      duplicateOption("--plugin-publish-scope", "all-publishable", "selected"),
      duplicateOption("--plugins", "telegram", "discord"),
      duplicateOption("--output-dir", ".artifacts/a", ".artifacts/b"),
    ] satisfies Array<[string, string[]]>;

    for (const [flag, args] of duplicateCases) {
      expect(() => parseArgs(args), flag).toThrow(`${flag} was provided more than once`);
    }
  });

  it("requires stable validation evidence to include soak and blocking performance", () => {
    const stableManifest = {
      workflowName: "Full Release Validation",
      targetSha: "candidate-sha",
      releaseProfile: "stable",
      rerunGroup: "all",
      runReleaseSoak: "true",
      controls: { performanceBlocking: true },
    };

    expect(() =>
      validateFullManifest(stableManifest, {
        targetSha: "candidate-sha",
        releaseProfile: "stable",
      }),
    ).not.toThrow();

    expect(() =>
      validateFullManifest(
        {
          ...stableManifest,
          runReleaseSoak: "false",
        },
        {
          targetSha: "candidate-sha",
          releaseProfile: "stable",
        },
      ),
    ).toThrow("runReleaseSoak=true");
    expect(() =>
      validateFullManifest(
        {
          ...stableManifest,
          controls: { performanceBlocking: false },
        },
        {
          targetSha: "candidate-sha",
          releaseProfile: "stable",
        },
      ),
    ).toThrow("blocking product performance");
  });

  it("keeps product performance advisory for beta release candidates", () => {
    expect(() =>
      validateFullManifest(
        {
          workflowName: "Full Release Validation",
          targetSha: "candidate-sha",
          releaseProfile: "beta",
          rerunGroup: "all",
          runReleaseSoak: "false",
          controls: { performanceBlocking: false },
        },
        {
          targetSha: "candidate-sha",
          releaseProfile: "beta",
        },
      ),
    ).not.toThrow();
  });

  it.each([
    {
      profile: "beta",
      coveragePolicy: "npm-beta-v1",
      skipTelegram: false,
      expected: "deferred-postpublish",
    },
    { profile: "beta", coveragePolicy: "npm-beta-v1", skipTelegram: true, expected: "skipped" },
    { profile: "beta", coveragePolicy: undefined, skipTelegram: false, expected: "passed" },
    { profile: "stable", coveragePolicy: undefined, skipTelegram: false, expected: "passed" },
    {
      profile: "stable",
      coveragePolicy: "npm-stable-v1",
      skipTelegram: false,
      expected: "passed",
      producerRunId: 444,
    },
    { profile: "full", coveragePolicy: undefined, skipTelegram: false, expected: "passed" },
  ])(
    "records candidate Telegram $expected for $profile qualification ($coveragePolicy)",
    async ({ profile, coveragePolicy, skipTelegram, expected, producerRunId = 222 }) => {
      const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");
      const telegramOwner = source.match(/^async function runTelegramIfNeeded\([\s\S]*?^\}/mu)?.[0];
      const telegramCall = source.match(
        /const npmTelegram = await runTelegramIfNeeded\([\s\S]*?\);/u,
      )?.[0];
      expect(telegramOwner).toBeDefined();
      expect(telegramCall).toBeDefined();
      const options = {
        ...parseArgs([
          "--tag",
          profile === "beta" ? "v2026.7.1-beta.4" : "v2026.7.1",
          ...(profile === "beta" ? [] : ["--windows-node-tag", "v0.6.3"]),
        ]),
        releaseProfile: profile,
        npmPreflightRunId: "222",
        publishWorkflowRef,
        skipTelegram,
      };
      const dispatchWorkflow = vi.fn(() => "333");
      const waitForSuccessfulRun = vi.fn(async () => ({
        run: { url: "https://github.com/openclaw/openclaw/actions/runs/333" },
      }));
      // Execute the private owner and its real caller without exporting a test-only API.
      const result = (await runInNewContext(
        stripTypeScriptTypes(
          `async function fixture() {\n${telegramOwner}\n${telegramCall}\nreturn npmTelegram;\n}\nfixture();`,
        ),
        {
          buildTelegramArtifactInputs,
          dispatchWorkflow,
          waitForSuccessfulRun,
          options,
          npmArtifact: {
            id: 9,
            name: "npm-package",
            digest: `sha256:${"a".repeat(64)}`,
            workflowRunId: producerRunId,
          },
          npmManifest: {
            tarballName: "openclaw.tgz",
            tarballSha256: "b".repeat(64),
            packageVersion: options.tag.slice(1),
          },
          npmRun: { runAttempt: 1 },
          targetSha: "c".repeat(40),
          fullValidationEvidence: { coveragePolicy },
        },
      )) as { status: string; runId?: string };
      expect(result.status).toBe(expected);
      if (expected !== "passed") {
        expect(result).toEqual({ status: expected });
        expect(dispatchWorkflow).not.toHaveBeenCalled();
        expect(waitForSuccessfulRun).not.toHaveBeenCalled();
        expect(buildPublishCommand({ ...options, npmTelegramRunId: result.runId })).not.toContain(
          "npm_telegram_run_id",
        );
      } else {
        expect(result.runId).toBe("333");
        expect(dispatchWorkflow).toHaveBeenCalledOnce();
        expect(dispatchWorkflow).toHaveBeenCalledWith(
          options.repo,
          "npm-telegram-beta-e2e.yml",
          options.workflowRef,
          expect.objectContaining({
            package_artifact_id: 9,
            package_artifact_run_id: String(producerRunId),
            package_source_sha: "c".repeat(40),
          }),
        );
        expect(waitForSuccessfulRun).toHaveBeenCalledWith(options.repo, "333", {
          workflowName: "NPM Telegram Beta E2E",
          workflowRef: options.workflowRef,
        });
      }
    },
  );

  it("binds SHA-pinned full validation evidence through its manifest", () => {
    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");

    expect(source).toContain("allowShaPinnedWorkflowRef: true");
    expect(source).toContain(
      "const fullValidationEvidence = validateFullReleaseValidationEvidence({",
    );
    expect(source).toContain("runStrictReleaseEvidenceValidation({ repository, runId })");
    expect(source).toContain("expectedReleaseTag: options.tag");
    expect(source).toContain("refs/heads/main:refs/remotes/origin/main");
    expect(source).toContain(
      'fullValidationEvidence.source === "direct" && fullRun.headSha !== targetSha',
    );
  });

  it("stops parsing options after the argument terminator", () => {
    const options = parseArgs([
      "--tag",
      "v2026.5.14-beta.3",
      "--full-release-run",
      "111",
      "--npm-preflight-run",
      "222",
      "--skip-dispatch",
      "--",
      "--plugin-publish-scope",
      "selected",
    ]);

    expect(options.pluginPublishScope).toBe("all-publishable");
  });

  it("accepts package-manager argument separators before script options", () => {
    const options = parseArgs([
      "--",
      "--tag",
      "v2026.5.14-beta.3",
      "--full-release-run",
      "111",
      "--npm-preflight-run",
      "222",
      "--skip-dispatch",
      "--skip-parallels",
    ]);

    expect(options.tag).toBe("v2026.5.14-beta.3");
    expect(options.skipParallels).toBe(true);
  });

  it("builds the gated release publish command from green evidence inputs", () => {
    const options = {
      ...parseArgs([
        "--tag",
        "v2026.5.14-beta.3",
        "--workflow-ref",
        "main",
        "--full-release-run",
        "111",
        "--npm-preflight-run",
        "222",
        "--plugin-sdk-api-acknowledgement",
        "a1b2c3d4",
        "--skip-dispatch",
      ]),
      workflowRef: "main",
      publishWorkflowRef,
      fullReleaseRunAttempt: 2,
    };

    const command = buildPublishCommand(options);
    expect(command).toContain("'full_release_validation_run_id=111'");
    expect(command).toContain("'full_release_validation_run_attempt=2'");
    expect(command).toContain("'preflight_run_id=222'");
    expect(command).toContain("'plugin_sdk_api_acknowledgement=a1b2c3d4'");
    expect(command).toContain("'tag=v2026.5.14-beta.3'");
    expect(command).toContain("'plugin_publish_scope=all-publishable'");
    expect(command).toContain(`'--ref' '${publishWorkflowRef}'`);
    expect(command).not.toContain("windows_node_tag=");

    const workflow = parse(
      readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"),
    ) as {
      on: { workflow_dispatch: { inputs: Record<string, unknown> } };
    };
    const emittedInputs = [...command.matchAll(/'-f' '([^=']+)=/gu)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );
    for (const input of emittedInputs) {
      expect(workflow.on.workflow_dispatch.inputs).toHaveProperty(input);
    }
  });

  it("validates Plugin SDK acknowledgement digests", () => {
    expect(() =>
      parseArgs(["--tag", "v2026.5.14-beta.3", "--plugin-sdk-api-acknowledgement", "ABC"]),
    ).toThrow("8-character lowercase digest");
  });

  it("prints a stable publish command without Windows promotion inputs", () => {
    const options = parseArgs([
      "--tag",
      "v2026.5.14",
      "--npm-dist-tag",
      "latest",
      "--full-release-run",
      "111",
      "--npm-preflight-run",
      "222",
    ]);
    const command = buildPublishCommand({
      ...options,
      publishWorkflowRef,
      fullReleaseRunAttempt: 1,
    });

    expect(command).toContain("'tag=v2026.5.14'");
    expect(command).toContain("'npm_dist_tag=latest'");
    expect(command).toContain("'publish_openclaw_npm=true'");
    expect(command).not.toContain("windows_node_");
  });

  it("carries the optional exact Windows Node tag and digests for stable candidates", () => {
    expect(() => parseArgs(["--tag", "v2026.5.14", "--windows-node-tag", "latest"])).toThrow(
      "--windows-node-tag must be an explicit version tag, not latest",
    );

    const options = {
      ...parseArgs([
        "--tag",
        "v2026.5.14",
        "--windows-node-tag",
        "v0.6.3",
        "--workflow-ref",
        "main",
      ]),
      workflowRef: "main",
      publishWorkflowRef,
      windowsNodeInstallerDigests: JSON.stringify({
        "OpenClawCompanion-Setup-x64.exe": `sha256:${"a".repeat(64)}`,
        "OpenClawCompanion-Setup-arm64.exe": `sha256:${"b".repeat(64)}`,
      }),
    };

    expect(buildPublishCommand(options)).toContain("'windows_node_tag=v0.6.3'");
    expect(buildPublishCommand(options)).toContain(
      `'windows_node_installer_digests={"OpenClawCompanion-Setup-x64.exe":"sha256:${"a".repeat(64)}","OpenClawCompanion-Setup-arm64.exe":"sha256:${"b".repeat(64)}"}'`,
    );
  });

  it("validates the stable Windows source release and immutable installer digests", async () => {
    const assets = [
      {
        name: "OpenClawCompanion-Setup-x64.exe",
        digest: `sha256:${"a".repeat(64)}`,
      },
      {
        name: "OpenClawCompanion-Setup-arm64.exe",
        digest: `sha256:${"b".repeat(64)}`,
      },
    ];
    const fetchImpl = vi.fn(async () => {
      return jsonResponse({
        tag_name: "v0.6.3",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/openclaw/openclaw-windows-node/releases/tag/v0.6.3",
        assets,
      });
    });

    await expect(
      validateWindowsSourceRelease("v0.6.3", {
        fetchImpl,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).resolves.toEqual({
      tag: "v0.6.3",
      url: "https://github.com/openclaw/openclaw-windows-node/releases/tag/v0.6.3",
      assets,
    });
  });

  it.each([
    [{ draft: true }, "must be published"],
    [{ prerelease: true }, "must not be a prerelease"],
    [{ tag_name: "v0.6.4" }, "Windows source release tag mismatch: expected v0.6.3, got v0.6.4"],
    [
      { assets: [] },
      "must contain exactly one required asset OpenClawCompanion-Setup-x64.exe; found 0",
    ],
    [
      {
        assets: [
          {
            name: "OpenClawCompanion-Setup-x64.exe",
            digest: `sha256:${"a".repeat(64)}`,
          },
          {
            name: "OpenClawCompanion-Setup-x64.exe",
            digest: `sha256:${"c".repeat(64)}`,
          },
          {
            name: "OpenClawCompanion-Setup-arm64.exe",
            digest: `sha256:${"b".repeat(64)}`,
          },
        ],
      },
      "must contain exactly one required asset OpenClawCompanion-Setup-x64.exe; found 2",
    ],
    [
      {
        assets: [
          { name: "OpenClawCompanion-Setup-x64.exe", digest: "" },
          { name: "OpenClawCompanion-Setup-arm64.exe", digest: `sha256:${"b".repeat(64)}` },
        ],
      },
      "asset OpenClawCompanion-Setup-x64.exe is missing its SHA-256 digest",
    ],
  ])("rejects an invalid stable Windows source release", async (override, message) => {
    const fetchImpl = vi.fn(async () => {
      return jsonResponse({
        tag_name: "v0.6.3",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/openclaw/openclaw-windows-node/releases/tag/v0.6.3",
        assets: [
          {
            name: "OpenClawCompanion-Setup-x64.exe",
            digest: `sha256:${"a".repeat(64)}`,
          },
          {
            name: "OpenClawCompanion-Setup-arm64.exe",
            digest: `sha256:${"b".repeat(64)}`,
          },
        ],
        ...override,
      });
    });

    await expect(
      validateWindowsSourceRelease("v0.6.3", {
        fetchImpl,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).rejects.toThrow(message);
  });

  it("carries the Telegram proof run into the publish command when available", () => {
    const options = {
      ...parseArgs([
        "--tag",
        "v2026.5.14-beta.3",
        "--workflow-ref",
        "main",
        "--full-release-run",
        "111",
        "--npm-preflight-run",
        "222",
        "--skip-dispatch",
      ]),
      workflowRef: "main",
      publishWorkflowRef,
      npmTelegramRunId: "333",
    };

    expect(buildPublishCommand(options)).toContain("'npm_telegram_run_id=333'");
  });

  it("requires explicit plugin names for selected plugin publish scope", () => {
    expect(() =>
      parseArgs(["--tag", "v2026.5.14-beta.3", "--plugin-publish-scope", "selected"]),
    ).toThrow("--plugin-publish-scope selected requires --plugins");
  });

  it("rejects selected plugin publish scope for release candidates", () => {
    expect(() =>
      parseArgs([
        "--tag",
        "v2026.5.14-beta.3",
        "--plugin-publish-scope",
        "selected",
        "--plugins",
        "@openclaw/diffs",
      ]),
    ).toThrow("release candidates publish OpenClaw with --plugin-publish-scope all-publishable");
  });

  it("extracts a workflow run id from gh dispatch output", () => {
    expect(
      parseRunIdFromDispatchOutput(
        "https://github.com/openclaw/openclaw/actions/runs/25922042055\n",
      ),
    ).toBe("25922042055");
  });

  it("fails closed when gh dispatch output does not include the run url", () => {
    expect(() =>
      requireRunIdFromDispatchOutput(
        "Created workflow_dispatch event for full-release-validation.yml",
        "full-release-validation.yml",
      ),
    ).toThrow("refusing to guess from recent workflow_dispatch runs");
  });

  it("keeps contract 1 callers compatible and sends identity for contract 2", () => {
    const workflowSha = "a".repeat(40);
    const source = (contract: string, declareIdentity: boolean) => `env:
  RELEASE_ISOLATION_TOOLING_CONTRACT: "${contract}"
on:
  workflow_dispatch:
    inputs:
      expected_sha: {}
${declareIdentity ? "      trusted_workflow_json: {}\n" : ""}`;

    expect(
      fullReleaseTrustedWorkflowFields({
        workflowRef: "main",
        workflowSha,
        workflowSource: source("1", false),
      }),
    ).toEqual({});
    const fields = fullReleaseTrustedWorkflowFields({
      workflowRef: "main",
      workflowSha,
      workflowSource: source("2", true),
    });
    expect(JSON.parse(fields.trusted_workflow_json ?? "{}")).toEqual({
      ref: "main",
      fullRef: "refs/heads/main",
      sha: workflowSha,
    });
    expect(() =>
      fullReleaseTrustedWorkflowFields({
        workflowRef: "main",
        workflowSha,
        workflowSource: source("2", false),
      }),
    ).toThrow("contract 2 requires trusted_workflow_json");
    for (const contract of ["3", "4"]) {
      expect(() =>
        fullReleaseTrustedWorkflowFields({
          workflowRef: "main",
          workflowSha,
          workflowSource: source(contract, true),
        }),
      ).toThrow("supported release tooling contract");
    }
  });

  it("threads the selected tooling identity into direct full validation dispatch", () => {
    const source = readFileSync("scripts/release-candidate-checklist.mts", "utf8");

    expect(source).toContain("const trustedWorkflowFields = fullReleaseTrustedWorkflowFields({");
    expect(source).toContain("workflowSha: toolingSha");
    expect(source).toContain("...trustedWorkflowFields");
  });

  it("falls back to a single compatible artifact from the same run", () => {
    expect(
      resolveArtifactName(
        [{ name: "openclaw-npm-preflight-dba00", expired: false }],
        "openclaw-npm-preflight-v2026.5.16-beta.2",
        "openclaw-npm-preflight-",
      ),
    ).toBe("openclaw-npm-preflight-dba00");
  });

  it("builds the complete immutable Telegram artifact identity tuple", () => {
    const input = {
      artifact: {
        digest: `sha256:${"a".repeat(64)}`,
        id: 123,
        name: "openclaw-npm-preflight-v2026.7.2-beta.1",
        workflowRunId: 456,
      },
      manifest: {
        packageVersion: "2026.7.2-beta.1",
        tarballName: "openclaw-2026.7.2-beta.1.tgz",
        tarballSha256: "b".repeat(64),
      },
      runAttempt: 2,
      runId: "456",
      sourceSha: "c".repeat(40),
    };
    expect(buildTelegramArtifactInputs(input)).toEqual({
      package_artifact_digest: "a".repeat(64),
      package_artifact_id: 123,
      package_artifact_name: "openclaw-npm-preflight-v2026.7.2-beta.1",
      package_artifact_run_attempt: 2,
      package_artifact_run_id: "456",
      package_file_name: "openclaw-2026.7.2-beta.1.tgz",
      package_sha256: "b".repeat(64),
      package_source_sha: "c".repeat(40),
      package_version: "2026.7.2-beta.1",
    });
    expect(() =>
      buildTelegramArtifactInputs({
        ...input,
        artifact: { ...input.artifact, workflowRunId: undefined },
        runId: "undefined",
      }),
    ).toThrow("belongs to run");
  });

  it("bounds GitHub API requests with a timeout signal", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.headers).toMatchObject({
        Accept: "application/vnd.github+json",
        Authorization: "Bearer test-token",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      return jsonResponse({ workflow_runs: [] });
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs", {
        fetchImpl,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).resolves.toEqual({ workflow_runs: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/openclaw/openclaw/actions/runs",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("uses a positive integer GitHub API timeout env", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ workflow_runs: [] });
    });

    await withGithubApiTimeoutEnv("2500", async () => {
      await expect(
        githubApi("repos/openclaw/openclaw/actions/runs", {
          fetchImpl,
          token: "test-token",
        }),
      ).resolves.toEqual({ workflow_runs: [] });
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["1e3", "10.5", "0", "soon"])(
    "rejects malformed GitHub API timeout env %s",
    async (raw) => {
      const fetchImpl = vi.fn();

      await withGithubApiTimeoutEnv(raw, async () => {
        await expect(
          githubApi("repos/openclaw/openclaw/actions/runs", {
            fetchImpl,
            token: "test-token",
          }),
        ).rejects.toThrow(
          "OPENCLAW_RELEASE_CANDIDATE_GITHUB_API_TIMEOUT_MS must be a positive integer",
        );
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("bounds GitHub API error bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response("x".repeat(65), {
        headers: { "content-length": "65" },
        status: 500,
      });
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs", {
        fetchImpl,
        maxBodyBytes: 64,
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).rejects.toThrow(
      "GitHub API repos/openclaw/openclaw/actions/runs response body exceeded 64 bytes",
    );
  });

  it("keeps GitHub API timeouts active while reading response bodies", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
      });
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs", {
        fetchImpl,
        timeoutMs: 25,
        token: "test-token",
      }),
    ).rejects.toThrow("GitHub API repos/openclaw/openclaw/actions/runs timed out after 25ms");
  });

  it("includes the GitHub API path when a request times out", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("request timed out", "TimeoutError");
    });

    await expect(
      githubApi("repos/openclaw/openclaw/actions/runs/123/jobs", {
        fetchImpl,
        timeoutMs: 5,
        token: "test-token",
      }),
    ).rejects.toThrow(
      "GitHub API repos/openclaw/openclaw/actions/runs/123/jobs timed out after 5ms",
    );
  });
});

describe("GitHub API public fallback", () => {
  it.each([403, 429])(
    "retries anonymously after an authenticated rate limit response %s",
    async (status) => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status }),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

      await expect(
        githubApi("repos/openclaw/openclaw/actions/runs/123", {
          token: "x",
          fetchImpl,
        }),
      ).resolves.toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer x" });
      expect(fetchImpl.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Authorization");
    },
  );
});
