import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { collectClawHubPublishablePluginPackages } from "../../scripts/lib/plugin-clawhub-release.ts";
import { collectPublishablePluginPackages } from "../../scripts/lib/plugin-npm-release.ts";
import {
  canonicalReleasePlanLockJson,
  createReleasePlanLock,
  type ReleasePlan,
  type ReleasePlanLock,
} from "../../scripts/release-plan-contract.mjs";
import {
  deriveReleasePlanPolicy,
  runReleasePlanProducerOperation,
} from "../../scripts/release-plan-producer-core.mts";
import {
  produceReleasePlan as trustedCheckoutProduceReleasePlan,
  verifyReleasePlanLock as trustedCheckoutVerifyReleasePlanLock,
  type MainQualificationValidationIntent,
  type ReleasePlanIntent,
  type ReleasePlanSource,
} from "../../scripts/release-plan-producer.mts";
import { writePublishablePluginFixture } from "../helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TOOLING_CLOSURE = [
  "packages/normalization-core/src/record-coerce.ts",
  "packages/normalization-core/src/string-coerce.ts",
  "packages/plugin-package-contract/src/index.ts",
  "scripts/release-plan-producer.mts",
  "scripts/release-plan-producer-core.mts",
  "scripts/release-plan-contract.mjs",
  "scripts/release-validation-intent.mjs",
  "scripts/release-tooling-identity.mjs",
  "scripts/lib/npm-publish-plan.mjs",
  "scripts/lib/plugin-publication-candidates.ts",
  "scripts/lib/plugin-publication-collector.ts",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/release-version.mjs",
];
const TOOLING_ROOT_FILES = ["package.json", "pnpm-lock.yaml"];

function writeFixture(root: string, path: string, content: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commit(root: string, message: string, options: { allowEmpty?: boolean } = {}): string {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-q",
      ...(options.allowEmpty ? ["--allow-empty"] : []),
      "-m",
      message,
    ],
    { cwd: root },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function copyToolingClosure(root: string) {
  for (const path of [...TOOLING_CLOSURE, ...TOOLING_ROOT_FILES]) {
    writeFixture(root, path, readFileSync(resolve(path), "utf8"));
  }
}

function createFixtureRepo(
  version = "2026.8.1-beta.2",
  options: {
    conflictingPlatformId?: boolean;
    corePackageNameCollision?: boolean;
    duplicateCrossTargetPackageName?: boolean;
    malformedPlugin?: boolean;
    malformedPluginJson?: boolean;
  } = {},
) {
  const root = tempDirs.make("openclaw-release-plan-");
  execFileSync("git", ["init", "-q", "-b", "tooling"], { cwd: root });

  writeFixture(
    root,
    "package.json",
    JSON.stringify({
      name: "openclaw",
      version,
      dependencies: { "@openclaw/ai": "workspace:*" },
    }),
  );
  for (const [path, name] of [
    ["packages/ai", "@openclaw/ai"],
    ["packages/gateway-client", "@openclaw/gateway-client"],
    ["packages/gateway-protocol", "@openclaw/gateway-protocol"],
  ]) {
    writeFixture(
      root,
      `${path}/package.json`,
      JSON.stringify({
        name,
        version,
        openclaw: { release: { publishToNpm: true } },
      }),
    );
  }
  if (options.corePackageNameCollision) {
    writePublishablePluginFixture(root, {
      extensionId: "shadow-ai",
      packageName: "@openclaw/ai",
      version,
      publishTo: "both",
    });
  } else if (options.duplicateCrossTargetPackageName) {
    writePublishablePluginFixture(root, {
      extensionId: "duplicate-npm",
      packageName: "@openclaw/duplicate",
      version,
      publishTo: "npm",
    });
    writePublishablePluginFixture(root, {
      extensionId: "duplicate-clawhub",
      packageName: "@openclaw/duplicate",
      version,
      publishTo: "clawhub",
    });
  } else if (options.malformedPluginJson) {
    writeFixture(root, "extensions/broken/package.json", "{ not-json\n");
  } else if (options.malformedPlugin) {
    writeFixture(
      root,
      "extensions/broken/package.json",
      JSON.stringify({
        name: "@openclaw/broken",
        version,
        type: "commonjs",
        private: true,
        repository: { type: "git", url: "https://github.com/openclaw/openclaw" },
        openclaw: {
          extensions: ["./index.ts"],
          compat: { pluginApi: `>=${version}` },
          build: { openclawVersion: version },
          install: { npmSpec: "@openclaw/broken" },
          release: { publishToNpm: true },
        },
      }),
    );
  }
  const candidateSha = commit(root, "candidate");
  const candidateRef = `refs/tags/v${version}`;

  writeFixture(
    root,
    ".github/workflows/full-release-validation.yml",
    [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      rerun_group:",
      "        options:",
      "          - package",
      "          - all",
      "          - ci",
      "",
    ].join("\n"),
  );
  writeFixture(
    root,
    ".github/workflows/openclaw-release-publish.yml",
    [
      "name: Release Publish",
      "jobs:",
      "  publish:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          promote_windows_release_assets() {",
      "            dispatch_workflow windows-node-release.yml",
      "          }",
      "          promote_android_release_asset() {",
      '            dispatch_workflow_at_ref "${RELEASE_TAG}" "${TARGET_SHA}" android-release.yml',
      "          }",
      "          dispatch_workflow plugin-npm-release.yml",
      "  publish_docker:",
      "    uses: ./.github/workflows/docker-release.yml",
      "  publish_vcr:",
      "    uses: ./.github/workflows/vercel-container-registry-publish.yml",
      ...(options.conflictingPlatformId
        ? ["  publish_windows:", "    uses: ./.github/workflows/docker-release.yml"]
        : []),
      "",
    ].join("\n"),
  );
  writeFixture(
    root,
    ".github/workflows/openclaw-npm-release.yml",
    [
      "name: NPM Release",
      "jobs:",
      "  preflight:",
      "    steps:",
      "      - name: Pack publishable core packages",
      "        env:",
      "          CORE_PACKAGE_DIRS: packages/ai packages/gateway-protocol packages/gateway-client",
      "        run: |",
      '          if [[ "$package_dir" == "packages/ai" ]] && ! node -e \'const pkg = require("./package.json"); process.exit(pkg.dependencies?.["@openclaw/ai"] ? 0 : 1)\'; then',
      "            exit 0",
      "          fi",
      "",
    ].join("\n"),
  );
  for (const name of [
    "android-release.yml",
    "docker-release.yml",
    "plugin-npm-release.yml",
    "vercel-container-registry-publish.yml",
    "windows-node-release.yml",
  ]) {
    writeFixture(root, `.github/workflows/${name}`, `name: ${name}\n`);
  }
  copyToolingClosure(root);
  const toolingSha = commit(root, "tooling");
  const toolingFullRef = `refs/tags/release-publish/${toolingSha.slice(0, 12)}-1`;
  return { candidateRef, candidateSha, root, toolingFullRef, toolingSha };
}

function sourceParams(
  fixture: ReturnType<typeof createFixtureRepo>,
  intent: ReleasePlanIntent = "publish",
  validationIntent?: MainQualificationValidationIntent,
): ReleasePlanSource {
  const source = {
    repoRoot: fixture.root,
    candidateSha: fixture.candidateSha,
    candidateRef:
      intent === "diagnostic" || intent === "main-qualification"
        ? fixture.candidateSha
        : fixture.candidateRef,
    toolingSha: fixture.toolingSha,
    toolingFullRef: fixture.toolingFullRef,
    runGh: trustedToolingGh(fixture.toolingFullRef, fixture.toolingSha),
  };
  return (
    intent === "main-qualification"
      ? { ...source, intent, validationIntent }
      : { ...source, intent }
  ) as ReleasePlanSource;
}

function trustedToolingGh(toolingFullRef: string, toolingSha: string) {
  return (args: string[]) => {
    const endpoint = args[1];
    if (
      endpoint ===
      `repos/openclaw/openclaw/git/ref/tags/${toolingFullRef.slice("refs/tags/".length)}`
    ) {
      return JSON.stringify({
        ref: toolingFullRef,
        object: { type: "commit", sha: toolingSha },
      });
    }
    throw new Error(`unexpected GitHub API request: ${args.join(" ")}`);
  };
}

function runCoreOperation(
  request:
    | { operation: "produce"; params: ReleasePlanSource }
    | { operation: "verify-lock"; lockJson: string; params: ReleasePlanSource },
) {
  const { runGh, ...params } = request.params;
  return runReleasePlanProducerOperation(
    { ...request, params },
    {
      runGh:
        runGh ??
        (() => {
          throw new Error("unexpected GitHub API request");
        }),
      parseYamlDocuments: (sources) =>
        sources.map((source) => parse(source)) as [unknown, unknown, unknown],
    },
  );
}

function produceReleasePlan(params: ReleasePlanSource) {
  return runCoreOperation({ operation: "produce", params }) as ReleasePlan;
}

function verifyReleasePlanLock(lockJson: string, params: ReleasePlanSource) {
  return runCoreOperation({ operation: "verify-lock", lockJson, params }) as ReleasePlanLock;
}

type YamlPackageHarnessParams = {
  fixture: ReturnType<typeof createFixtureRepo>;
  packageRoot: string;
  sentinelPath: string;
  tempRoot: string;
};

function runYamlPackageSubprocess(
  options: {
    beforeProduce?: (params: YamlPackageHarnessParams) => string;
    environment?: (params: YamlPackageHarnessParams) => Record<string, string>;
    mutate?: (params: YamlPackageHarnessParams) => void;
    mutateTooling?: (fixture: ReturnType<typeof createFixtureRepo>) => void;
    beforeImport?: (params: YamlPackageHarnessParams) => string;
    executionHead?: (fixture: ReturnType<typeof createFixtureRepo>) => string;
    remoteToolingSha?: (params: YamlPackageHarnessParams) => string;
  } = {},
) {
  let fixture = createFixtureRepo();
  if (options.mutateTooling) {
    options.mutateTooling(fixture);
    const toolingSha = commit(fixture.root, "mutated tooling");
    fixture = {
      ...fixture,
      toolingSha,
      toolingFullRef: `refs/tags/release-publish/${toolingSha.slice(0, 12)}-2`,
    };
  }
  const packageRoot = join(fixture.root, "node_modules/yaml");
  cpSync(realpathSync(resolve("node_modules/yaml")), packageRoot, { recursive: true });
  const sentinelPath = join(fixture.root, "yaml-executed");
  const tempRoot = join(fixture.root, "yaml-temp");
  mkdirSync(tempRoot);
  const params = { fixture, packageRoot, sentinelPath, tempRoot };
  options.mutate?.(params);
  writeFixture(
    fixture.root,
    "yaml-package-harness.mts",
    `
${options.beforeImport?.(params) ?? ""}
const { produceReleasePlan } = await import("./scripts/release-plan-producer.mts");
${options.beforeProduce?.(params) ?? ""}

const toolingFullRef = ${JSON.stringify(fixture.toolingFullRef)};
const toolingSha = ${JSON.stringify(fixture.toolingSha)};
produceReleasePlan({
  repoRoot: ${JSON.stringify(fixture.root)},
  intent: "publish",
  candidateSha: ${JSON.stringify(fixture.candidateSha)},
  candidateRef: ${JSON.stringify(fixture.candidateRef)},
  toolingSha,
  toolingFullRef,
  runGh: () => JSON.stringify({
    ref: toolingFullRef,
    object: { type: "commit", sha: ${JSON.stringify(options.remoteToolingSha?.(params) ?? fixture.toolingSha)} },
  }),
});
const moduleApi = await import("node:module");
const harnessRequire = moduleApi.createRequire(import.meta.url);
const leakedSnapshotCache = Object.keys(harnessRequire.cache).filter(path =>
  path.includes("openclaw-release-yaml-")
);
if (leakedSnapshotCache.length > 0) {
  throw new Error("verified yaml snapshot leaked into parent require.cache");
}
    `,
  );
  if (options.executionHead) {
    execFileSync("git", ["update-ref", "HEAD", options.executionHead(fixture)], {
      cwd: fixture.root,
    });
  }
  return {
    result: spawnSync(process.execPath, [join(fixture.root, "yaml-package-harness.mts")], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: tempRoot,
        ...options.environment?.(params),
      },
    }),
    fixture,
    packageRoot,
    sentinelPath,
    tempRoot,
  };
}

function yamlTempEntries(root: string) {
  return readdirSync(root).filter((name) => name.startsWith("openclaw-release-yaml-"));
}

describe("release plan producer", () => {
  it("rejects invalid identity through the verified child dispatcher", () => {
    expect(() =>
      runReleasePlanProducerOperation(
        {
          operation: "produce",
          params: {
            candidateRef: "refs/tags/v2026.8.1-beta.2",
            candidateSha: "not-a-sha",
            intent: "publish",
            toolingFullRef: "refs/heads/main",
            toolingSha: "f".repeat(40),
          },
        },
        {
          parseYamlDocuments: () => [{}, {}, {}],
          runGh: () => {
            throw new Error("unexpected GitHub request");
          },
        },
      ),
    ).toThrow("candidate SHA must be an exact lowercase 40-character commit SHA");
  });

  it("derives purpose, profile, tag, and soak from the canonical version parser", () => {
    expect(deriveReleasePlanPolicy("publish", "2026.8.1-beta.2")).toEqual({
      intent: "release-beta",
      profile: "beta",
      publishable: true,
      purpose: "beta-publish",
      soak: false,
      tag: "v2026.8.1-beta.2",
    });
    expect(deriveReleasePlanPolicy("publish", "2026.8.1")).toEqual({
      intent: "release-stable",
      profile: "stable",
      publishable: true,
      purpose: "stable-publish",
      soak: true,
      tag: "v2026.8.1",
    });
    expect(deriveReleasePlanPolicy("postpublish-confidence", "2026.8.1-beta.2")).toEqual({
      intent: "diagnostic-full",
      profile: "full",
      publishable: false,
      purpose: "postpublish-confidence",
      soak: true,
      tag: "v2026.8.1-beta.2",
    });
    expect(deriveReleasePlanPolicy("diagnostic", "2026.8.1-beta.2")).toEqual({
      intent: "diagnostic-full",
      profile: "full",
      publishable: false,
      purpose: "diagnostic",
      soak: true,
      tag: null,
    });
    expect(() => deriveReleasePlanPolicy("main-qualification", "2026.8.1-beta.2")).toThrow(
      "requires an explicit validation intent",
    );
    expect(deriveReleasePlanPolicy("main-qualification", "2026.8.1-beta.2", "main-daily")).toEqual({
      intent: "main-daily",
      profile: "beta",
      publishable: false,
      purpose: "main-qualification",
      soak: false,
      tag: null,
    });
    expect(deriveReleasePlanPolicy("main-qualification", "2026.8.1-beta.2", "main-weekly")).toEqual(
      {
        intent: "main-weekly",
        profile: "full",
        publishable: false,
        purpose: "main-qualification",
        soak: true,
        tag: null,
      },
    );
    expect(() => deriveReleasePlanPolicy("publish", "2026.08.1")).toThrow(
      "unsupported release version",
    );
    expect(() =>
      deriveReleasePlanPolicy("unexpected" as ReleasePlanIntent, "2026.8.1-beta.2"),
    ).toThrow("unsupported release plan intent");
  });

  it("reads candidate inventory and tooling policy from genuinely different commits", () => {
    const fixture = createFixtureRepo();
    expect(fixture.candidateSha).not.toBe(fixture.toolingSha);
    expect(() =>
      execFileSync("git", ["cat-file", "-e", fixture.candidateRef], {
        cwd: fixture.root,
        stdio: "ignore",
      }),
    ).toThrow();
    expect(() =>
      execFileSync(
        "git",
        ["cat-file", "-e", `${fixture.candidateSha}:scripts/release-plan-producer.mts`],
        { cwd: fixture.root, stdio: "ignore" },
      ),
    ).toThrow();
    expect(
      execFileSync(
        "git",
        ["cat-file", "-e", `${fixture.toolingSha}:scripts/release-plan-producer.mts`],
        { cwd: fixture.root, stdio: "ignore" },
      ),
    ).toBeNull();
    expect(() =>
      execFileSync("git", ["cat-file", "-e", fixture.toolingFullRef], {
        cwd: fixture.root,
        stdio: "ignore",
      }),
    ).toThrow();

    const plan = produceReleasePlan(sourceParams(fixture));
    expect(plan).toMatchObject({
      candidate_sha: fixture.candidateSha,
      purpose: "beta-publish",
      release_id: "2026.8.1-beta.2",
      tag: "v2026.8.1-beta.2",
      target_context_ref: fixture.candidateRef,
      version: "2026.8.1-beta.2",
    });
    expect(plan.tooling).toMatchObject({
      ref: fixture.toolingFullRef,
      sha: fixture.toolingSha,
    });
    expect(plan.validation).toEqual({
      allowed_groups: ["all", "ci", "package"],
      intent: "release-beta",
      profile: "beta",
      soak: false,
    });
    expect(plan.inventory.packages).toEqual([
      { name: "@openclaw/ai", targets: ["npm"], version: "2026.8.1-beta.2" },
      { name: "@openclaw/gateway-client", targets: ["npm"], version: "2026.8.1-beta.2" },
      { name: "@openclaw/gateway-protocol", targets: ["npm"], version: "2026.8.1-beta.2" },
      { name: "openclaw", targets: ["npm"], version: "2026.8.1-beta.2" },
    ]);
    expect(plan.inventory.platforms).toEqual([
      { id: "android", source: ".github/workflows/android-release.yml" },
      { id: "docker", source: ".github/workflows/docker-release.yml" },
      {
        id: "vcr",
        source: ".github/workflows/vercel-container-registry-publish.yml",
      },
      { id: "windows", source: ".github/workflows/windows-node-release.yml" },
    ]);
  });

  it("requires the final tag only for postpublish confidence", () => {
    const fixture = createFixtureRepo();
    expect(produceReleasePlan(sourceParams(fixture))).toMatchObject({
      purpose: "beta-publish",
      target_context_ref: fixture.candidateRef,
    });
    expect(() => produceReleasePlan(sourceParams(fixture, "postpublish-confidence"))).toThrow(
      "published candidate tag does not resolve",
    );

    execFileSync(
      "git",
      ["tag", fixture.candidateRef.slice("refs/tags/".length), fixture.candidateSha],
      {
        cwd: fixture.root,
      },
    );
    expect(produceReleasePlan(sourceParams(fixture, "postpublish-confidence"))).toMatchObject({
      purpose: "postpublish-confidence",
      target_context_ref: fixture.candidateRef,
      validation: {
        intent: "diagnostic-full",
        profile: "full",
        soak: true,
      },
    });
  });

  it("produces tagless diagnostics from trusted main or protected tooling", () => {
    const fixture = createFixtureRepo();
    expect(produceReleasePlan(sourceParams(fixture, "diagnostic"))).toMatchObject({
      candidate_sha: fixture.candidateSha,
      purpose: "diagnostic",
      tag: null,
      target_context_ref: fixture.candidateSha,
      tooling: {
        ref: fixture.toolingFullRef,
        sha: fixture.toolingSha,
      },
      validation: {
        intent: "diagnostic-full",
        profile: "full",
        soak: true,
      },
    });

    expect(
      produceReleasePlan({
        ...sourceParams(fixture, "diagnostic"),
        toolingFullRef: "refs/heads/main",
        runGh: (args) => {
          expect(args[1]).toBe(`repos/openclaw/openclaw/compare/${fixture.toolingSha}...main`);
          return JSON.stringify({ status: "identical" });
        },
      }),
    ).toMatchObject({
      purpose: "diagnostic",
      tag: null,
      target_context_ref: fixture.candidateSha,
      tooling: {
        ref: "refs/heads/main",
        sha: fixture.toolingSha,
      },
    });
  });

  it("requires main qualification producers to choose daily or weekly", () => {
    const fixture = createFixtureRepo();
    expect(() => produceReleasePlan(sourceParams(fixture, "main-qualification"))).toThrow(
      "requires an explicit validation intent",
    );
    expect(
      produceReleasePlan(sourceParams(fixture, "main-qualification", "main-daily")).validation,
    ).toMatchObject({
      intent: "main-daily",
      profile: "beta",
      soak: false,
    });
    expect(
      produceReleasePlan(sourceParams(fixture, "main-qualification", "main-weekly")).validation,
    ).toMatchObject({
      intent: "main-weekly",
      profile: "full",
      soak: true,
    });
  });

  it("requires exact candidate and tooling identity instead of checkout HEAD", () => {
    const fixture = createFixtureRepo();
    expect(() =>
      produceReleasePlan({ ...sourceParams(fixture), candidateSha: "f".repeat(40) }),
    ).toThrow("candidate SHA does not resolve");
    expect(() =>
      produceReleasePlan({
        ...sourceParams(fixture),
        runGh: trustedToolingGh(fixture.toolingFullRef, fixture.candidateSha),
      }),
    ).toThrow(
      "protected release tooling tag is missing, moved, annotated, or bound to the wrong SHA",
    );
    expect(() =>
      produceReleasePlan({ ...sourceParams(fixture), candidateRef: "refs/heads/tooling" }),
    ).toThrow("candidate ref must be");
  });

  it("rejects a locally forged protected tooling tag that GitHub does not own", () => {
    const fixture = createFixtureRepo();
    const forgedFullRef = `refs/tags/release-publish/${fixture.toolingSha.slice(0, 12)}-999`;
    execFileSync("git", ["tag", forgedFullRef.slice("refs/tags/".length), fixture.toolingSha], {
      cwd: fixture.root,
    });

    expect(() =>
      produceReleasePlan({
        ...sourceParams(fixture),
        toolingFullRef: forgedFullRef,
        runGh: () => {
          throw new Error("HTTP 404");
        },
      }),
    ).toThrow("protected release tooling tag is missing or unreadable");
  });

  it("rejects a caller producer that differs from the exact tooling commit", () => {
    const { result } = runYamlPackageSubprocess({
      mutate: ({ fixture }) => {
        const producerPath = join(fixture.root, "scripts/release-plan-producer.mts");
        writeFileSync(producerPath, `${readFileSync(producerPath, "utf8")}\n// ambient mismatch\n`);
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tooling bootstrap differs from tooling SHA");
  });

  it("rejects a byte-identical bootstrap launched from the candidate checkout", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      executionHead: (fixture) => fixture.candidateSha,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tooling bootstrap checkout HEAD must equal tooling SHA");
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("exports bootstrap operations for trusted-checkout callers", () => {
    expect(trustedCheckoutProduceReleasePlan).toBeTypeOf("function");
    expect(trustedCheckoutVerifyReleasePlanLock).toBeTypeOf("function");
  });

  it("rejects a forged remote tooling SHA before executing ambient tooling", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutate: ({ fixture, sentinelPath: sentinel }) => {
        writeFixture(
          fixture.root,
          "scripts/release-plan-producer-core.mts",
          `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ambient-core");\n`,
        );
      },
      remoteToolingSha: ({ fixture }) => fixture.candidateSha,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "protected release tooling tag is missing, moved, annotated, or bound to the wrong SHA",
    );
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("ignores uncommitted ambient tooling after verifying the exact tooling commit", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutate: ({ fixture, sentinelPath: sentinel }) => {
        writeFixture(
          fixture.root,
          "scripts/release-plan-producer-core.mts",
          `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ambient-core");\n`,
        );
      },
    });
    expect(result.status).toBe(0);
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("rejects a symlinked tooling closure before executing its target", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutateTooling: (fixture) => {
        const targetPath = join(fixture.root, "scripts/release-plan-producer-core.mts");
        const sentinelTarget = join(fixture.root, "scripts/release-plan-producer-evil.mts");
        writeFileSync(
          sentinelTarget,
          `require("node:fs").writeFileSync(${JSON.stringify(join(fixture.root, "yaml-executed"))}, "linked-core");\n`,
        );
        unlinkSync(targetPath);
        symlinkSync("release-plan-producer-evil.mts", targetPath);
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tooling closure path must be a regular Git blob");
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("rejects package imports in the retained tooling closure before execution", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutateTooling: (fixture) => {
        const corePath = join(fixture.root, "scripts/release-plan-producer-core.mts");
        writeFileSync(
          corePath,
          `import "yaml";\nrequire("node:fs").writeFileSync(${JSON.stringify(join(fixture.root, "yaml-executed"))}, "bare-import");\n${readFileSync(corePath, "utf8")}`,
        );
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tooling closure contains an unowned import");
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("rejects ambiguous tooling aliases before execution", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutateTooling: (fixture) => {
        writeFixture(
          fixture.root,
          "scripts/lib/release-version.mts",
          `require("node:fs").writeFileSync(${JSON.stringify(join(fixture.root, "yaml-executed"))}, "ambiguous-alias");\n`,
        );
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tooling import must resolve to one unambiguous file");
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("rejects foreign yaml resolved from a distinct execution root", () => {
    const fixture = createFixtureRepo();
    writeFixture(
      fixture.root,
      "node_modules/yaml/package.json",
      JSON.stringify({
        name: "yaml",
        version: "9.9.9",
        type: "commonjs",
        main: "./index.cjs",
        exports: {
          ".": "./index.cjs",
          "./package.json": "./package.json",
        },
      }),
    );
    writeFixture(
      fixture.root,
      "node_modules/yaml/index.cjs",
      `
exports.parse = source => {
  if (source.includes("rerun_group")) {
    return { on: { workflow_dispatch: { inputs: { rerun_group: { options: ["package", "all", "ci"] } } } } };
  }
  if (source.includes("CORE_PACKAGE_DIRS")) {
    return { jobs: { preflight: { steps: [{ env: { CORE_PACKAGE_DIRS: "packages/ai packages/gateway-protocol packages/gateway-client" } }] } } };
  }
  return {
    jobs: {
      publish_docker: { uses: "./.github/workflows/docker-release.yml" },
      publish_vcr: { uses: "./.github/workflows/vercel-container-registry-publish.yml" }
    }
  };
};
`,
    );
    writeFixture(
      fixture.root,
      "foreign-yaml-harness.mts",
      `
import { produceReleasePlan } from "./scripts/release-plan-producer.mts";

const toolingFullRef = ${JSON.stringify(fixture.toolingFullRef)};
const toolingSha = ${JSON.stringify(fixture.toolingSha)};
produceReleasePlan({
  repoRoot: ${JSON.stringify(fixture.root)},
  intent: "publish",
  candidateSha: ${JSON.stringify(fixture.candidateSha)},
  candidateRef: ${JSON.stringify(fixture.candidateRef)},
  toolingSha,
  toolingFullRef,
  runGh: () => JSON.stringify({
    ref: toolingFullRef,
    object: { type: "commit", sha: toolingSha },
  }),
});
`,
    );
    const result = spawnSync(process.execPath, [join(fixture.root, "foreign-yaml-harness.mts")], {
      cwd: fixture.root,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified yaml retained tree digest mismatch");
  });

  it("accepts the complete installed yaml package tree", () => {
    const { result, tempRoot } = runYamlPackageSubprocess();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(yamlTempEntries(tempRoot)).toEqual([]);
  });

  it("rejects a changed yaml entry before executing it", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutate: ({ packageRoot, sentinelPath: sentinel }) => {
        const entryPath = join(packageRoot, "dist/index.js");
        writeFileSync(
          entryPath,
          `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed");\n${readFileSync(entryPath, "utf8")}`,
        );
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified yaml retained tree digest mismatch");
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("rejects a changed yaml transitive module before execution", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutate: ({ packageRoot, sentinelPath: sentinel }) => {
        const transitivePath = join(packageRoot, "dist/public-api.js");
        writeFileSync(
          transitivePath,
          `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed");\n${readFileSync(transitivePath, "utf8")}`,
        );
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified yaml retained tree digest mismatch");
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("rejects internal yaml package symlinks", () => {
    const { result } = runYamlPackageSubprocess({
      mutate: ({ packageRoot }) => {
        const transitivePath = join(packageRoot, "dist/public-api.js");
        unlinkSync(transitivePath);
        symlinkSync("index.js", transitivePath);
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installed yaml package must not contain symbolic links");
  });

  it("rejects extra yaml package files", () => {
    const { result } = runYamlPackageSubprocess({
      mutate: ({ packageRoot }) => {
        writeFileSync(join(packageRoot, "unexpected.js"), "module.exports = {};\n");
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified yaml retained tree digest mismatch");
  });

  it("rejects missing yaml transitive files through tree attestation", () => {
    const { result } = runYamlPackageSubprocess({
      mutate: ({ packageRoot }) => {
        rmSync(join(packageRoot, "dist/public-api.js"));
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified yaml retained tree digest mismatch");
    expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
  });

  it("ignores poisoned direct yaml require cache entries", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      beforeProduce: ({ sentinelPath: sentinel }) => `
const cacheModule = await import("node:module");
const cacheFs = await import("node:fs");
const cacheRequire = cacheModule.createRequire(import.meta.url);
const ambientEntry = cacheRequire.resolve("yaml");
cacheRequire(ambientEntry);
cacheRequire.cache[ambientEntry].exports = {
  parse() {
    cacheFs.writeFileSync(${JSON.stringify(sentinel)}, "direct-cache");
    return {};
  }
};
`,
    });
    expect(result.status).toBe(0);
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("ignores poisoned transitive yaml require cache entries", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      beforeProduce: ({ sentinelPath: sentinel }) => `
const cacheModule = await import("node:module");
const cacheFs = await import("node:fs");
const cachePath = await import("node:path");
const cacheRequire = cacheModule.createRequire(import.meta.url);
const ambientEntry = cacheRequire.resolve("yaml");
cacheRequire(ambientEntry);
const publicApiPath = cachePath.join(cachePath.dirname(ambientEntry), "public-api.js");
cacheRequire.cache[publicApiPath].exports = {
  parse() {
    cacheFs.writeFileSync(${JSON.stringify(sentinel)}, "transitive-cache");
    return {};
  },
  parseAllDocuments() {},
  parseDocument() {},
  stringify() {}
};
delete cacheRequire.cache[ambientEntry];
`,
    });
    expect(result.status).toBe(0);
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("ignores parent yaml Module extension hooks", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      beforeProduce: ({ sentinelPath: sentinel }) => `
const hookModule = (await import("node:module")).createRequire(import.meta.url)("node:module");
const hookFs = await import("node:fs");
const originalJsLoader = hookModule._extensions[".js"];
hookModule._extensions[".js"] = function(module, filename) {
  if (filename.includes("/yaml/") || filename.includes("openclaw-release-yaml-")) {
    hookFs.writeFileSync(${JSON.stringify(sentinel)}, "extension-hook");
  }
  return originalJsLoader(module, filename);
};
`,
    });
    expect(result.status).toBe(0);
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("does not inherit yaml NODE_OPTIONS or NODE_PATH loaders", () => {
    const { result, sentinelPath } = runYamlPackageSubprocess({
      mutate: ({ fixture, sentinelPath: sentinel }) => {
        writeFixture(
          fixture.root,
          "yaml-preload.cjs",
          `
if (process.argv.some(value => value.includes("__openclaw_verified_yaml__"))) {
  require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "node-options");
}
`,
        );
        writeFixture(
          fixture.root,
          "evil-node-path/yaml/index.js",
          `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "node-path");`,
        );
      },
      environment: ({ fixture }) => ({
        NODE_OPTIONS: `--require=${join(fixture.root, "yaml-preload.cjs")}`,
        NODE_PATH: join(fixture.root, "evil-node-path"),
      }),
    });
    expect(result.status).toBe(0);
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("accepts exact-byte yaml hardlinks without creating a snapshot", () => {
    const { result, tempRoot } = runYamlPackageSubprocess({
      mutate: ({ fixture, packageRoot }) => {
        const targetPath = join(packageRoot, "dist/public-api.js");
        const linkSource = join(fixture.root, "public-api-hardlink-source.js");
        writeFileSync(linkSource, readFileSync(targetPath));
        unlinkSync(targetPath);
        linkSync(linkSource, targetPath);
        expect(statSync(targetPath).nlink).toBe(2);
      },
    });
    expect(result.status).toBe(0);
    expect(yamlTempEntries(tempRoot)).toEqual([]);
  });

  it("ignores a same-size ambient yaml replacement after byte retention", () => {
    const mutationPath = "ambient-mutated";
    const { result, sentinelPath, tempRoot } = runYamlPackageSubprocess({
      beforeImport: ({ fixture, packageRoot, sentinelPath: sentinel }) => `
const mutateModule = await import("node:module");
const mutateFs = await import("node:fs");
const mutateChildProcess = mutateModule.createRequire(import.meta.url)("node:child_process");
const originalExecFileSync = mutateChildProcess.execFileSync;
mutateChildProcess.execFileSync = function(command, args, options) {
  if (command === process.execPath && args?.[0] === "--input-type=module") {
    const entryPath = ${JSON.stringify(join(packageRoot, "dist/index.js"))};
    const original = mutateFs.readFileSync(entryPath, "utf8");
    const malicious =
      'require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ambient");' +
      "module.exports={parse:JSON.parse};";
    mutateFs.writeFileSync(entryPath, malicious.padEnd(original.length, " "));
    mutateFs.writeFileSync(${JSON.stringify(join(fixture.root, mutationPath))}, "done");
  }
  return originalExecFileSync(command, args, options);
};
mutateModule.syncBuiltinESMExports();
`,
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(result.status === 0 ? dirname(sentinelPath) : "", mutationPath))).toBe(
      true,
    );
    expect(existsSync(sentinelPath)).toBe(false);
    expect(yamlTempEntries(tempRoot)).toEqual([]);
  });

  it("fails malformed combined yaml parsing without creating a snapshot", () => {
    const { result, tempRoot } = runYamlPackageSubprocess({
      mutateTooling: (fixture) => {
        writeFixture(fixture.root, ".github/workflows/full-release-validation.yml", "on: [\n");
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Flow sequence in block collection");
    expect(yamlTempEntries(tempRoot)).toEqual([]);
  });

  it("rejects malformed publishable plugins while producing the plan", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", { malformedPlugin: true });
    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(
      /Publishable plugin metadata validation failed:[\s\S]*private must not be true[\s\S]*type must be "module"[\s\S]*README\.md must exist/u,
    );
  });

  it("fails closed on malformed candidate manifests across both publishers and ReleasePlan", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", { malformedPluginJson: true });
    const error = "plugin candidate manifest is malformed JSON: extensions/broken/package.json";
    expect(() => collectPublishablePluginPackages(fixture.root)).toThrow(error);
    expect(() => collectClawHubPublishablePluginPackages(fixture.root)).toThrow(error);
    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(error);
  });

  it("rejects duplicate package names split across npm and ClawHub plugin sources", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", {
      duplicateCrossTargetPackageName: true,
    });

    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(
      "package @openclaw/duplicate is declared by multiple plugin sources",
    );
  });

  it("rejects a plugin package name that collides with a core package source", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", {
      corePackageNameCollision: true,
    });

    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(
      "package inventory source mismatch for @openclaw/ai: extensions/shadow-ai/package.json and packages/ai/package.json",
    );
  });

  it("rejects conflicting platform publication sources with the same id", () => {
    const fixture = createFixtureRepo("2026.8.1-beta.2", {
      conflictingPlatformId: true,
    });

    expect(() => produceReleasePlan(sourceParams(fixture))).toThrow(
      "declares conflicting platform windows: .github/workflows/windows-node-release.yml and .github/workflows/docker-release.yml",
    );
  });

  it("matches the exact current publisher inventory: 93 npm and 89 ClawHub packages", () => {
    const root = tempDirs.make("openclaw-release-plan-current-");
    const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: resolve("."),
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", resolve("."), root]);
    execFileSync("git", ["checkout", "-q", "--detach", candidateSha], { cwd: root });
    copyToolingClosure(root);
    const toolingSha = commit(root, "tooling overlay", { allowEmpty: true });
    execFileSync("git", ["update-ref", "refs/heads/main", toolingSha], { cwd: root });

    const plan = produceReleasePlan({
      repoRoot: root,
      intent: "main-qualification",
      validationIntent: "main-weekly",
      candidateSha,
      candidateRef: candidateSha,
      toolingSha,
      toolingFullRef: "refs/heads/main",
      runGh: () => JSON.stringify({ status: "identical" }),
    });
    const npmPackages = plan.inventory.packages.filter((entry) => entry.targets.includes("npm"));
    const clawHubPackages = plan.inventory.packages.filter((entry) =>
      entry.targets.includes("clawhub"),
    );
    expect(npmPackages).toHaveLength(93);
    expect(clawHubPackages).toHaveLength(89);
    const coreNpmPackages = new Set([
      "@openclaw/ai",
      "@openclaw/gateway-client",
      "@openclaw/gateway-protocol",
      "openclaw",
    ]);
    expect(
      npmPackages
        .map((entry) => entry.name)
        .filter((name) => !coreNpmPackages.has(name))
        .toSorted(),
    ).toEqual(
      collectPublishablePluginPackages(root)
        .map((plugin) => plugin.packageName)
        .toSorted(),
    );
    expect(clawHubPackages.map((entry) => entry.name).toSorted()).toEqual(
      collectClawHubPublishablePluginPackages(root)
        .map((plugin) => plugin.packageName)
        .toSorted(),
    );
    expect(npmPackages.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "@openclaw/ai",
        "@openclaw/gateway-client",
        "@openclaw/gateway-protocol",
        "openclaw",
      ]),
    );
  });

  it("rejects recomputed locks with partial groups or bogus inventory", () => {
    const fixture = createFixtureRepo();
    const params = sourceParams(fixture);
    const plan = produceReleasePlan(params);
    const validLock = canonicalReleasePlanLockJson(createReleasePlanLock(plan));
    expect(verifyReleasePlanLock(validLock, params).plan).toEqual(plan);

    const partialGroups = structuredClone(plan);
    partialGroups.validation.allowed_groups = ["all", "ci"];
    const partialPlatforms = structuredClone(plan);
    partialPlatforms.inventory.platforms = partialPlatforms.inventory.platforms.slice(0, -1);
    const bogusPackages = structuredClone(plan);
    bogusPackages.inventory.packages.push({
      name: "zz-not-published",
      targets: ["npm"],
      version: plan.version,
    });
    for (const changed of [partialGroups, partialPlatforms, bogusPackages]) {
      const redigested = canonicalReleasePlanLockJson(createReleasePlanLock(changed));
      expect(() => verifyReleasePlanLock(redigested, params)).toThrow(
        "repository-derived authority",
      );
    }
  });
});
