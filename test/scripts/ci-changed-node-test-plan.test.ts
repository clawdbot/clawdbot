import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listAvailableExtensionIds } from "../../scripts/lib/changed-extensions.mts";
import {
  createChangedExtensionFallbackShards,
  createChangedNodeTestShards,
  hasBuildArtifactAffectingChange,
  hasCoreExtensionImpact,
  hasPromptSnapshotAffectingChange,
  hasQaSmokeAffectingChange,
  hasSqliteSessionLifecycleAffectingChange,
  resolveChangedDockerSeedLanes,
} from "../../scripts/lib/ci-changed-node-test-plan.mts";
import {
  listExtensionTestFilesForRoots,
  resolveExtensionTestConfig,
} from "../../scripts/lib/extension-test-plan.mts";
import {
  hasImportGraphImpactOnTargets,
  resolveChangedTestTargetPlan,
} from "../../scripts/test-projects.test-support.mts";
import { listGitTrackedFiles } from "../../src/test-utils/repo-files.js";
import { isGatewayServerTestFile } from "../vitest/vitest.gateway-server-paths.mjs";

const CODEX_TEST_PROCESS_FILE_LIMIT = 12;
const githubActivityHelper = ".agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh";

function expectBoundedCodexFallback(
  shards: ReturnType<typeof createChangedExtensionFallbackShards>,
) {
  const targets = shards.flatMap((shard) => shard.includePatterns ?? []);

  expect(shards.length).toBeGreaterThan(1);
  expect(
    shards.every(
      (shard) =>
        shard.configs[0] === "test/vitest/vitest.extension-codex.config.ts" &&
        (shard.includePatterns?.length ?? 0) > 0 &&
        (shard.includePatterns?.length ?? 0) <= CODEX_TEST_PROCESS_FILE_LIMIT,
    ),
  ).toBe(true);
  expect(targets).toEqual(listExtensionTestFilesForRoots(["extensions/codex"]));
  expect(new Set(targets).size).toBe(targets.length);
}

function expectAllExtensionConfigs(
  shards: ReturnType<typeof createChangedExtensionFallbackShards>,
) {
  const configs = new Set(shards.flatMap((shard) => shard.configs));
  const expectedConfigs = new Set(
    listAvailableExtensionIds().map((extensionId) =>
      resolveExtensionTestConfig(`extensions/${extensionId}`),
    ),
  );

  expect(configs).toEqual(expectedConfigs);
  expect(configs).toContain("test/vitest/vitest.extension-codex.config.ts");
}

const allDockerSeedLanes = ["mcp-channels", "cron-mcp-cleanup", "mcp-code-mode-gateway"];
it.each([
  [["scripts/e2e/mcp-channels-seed.ts"], ["mcp-channels"]],
  [["scripts/e2e/cron-mcp-cleanup-seed.ts"], ["cron-mcp-cleanup"]],
  [["scripts/e2e/mcp-code-mode-gateway-seed.ts"], ["mcp-code-mode-gateway"]],
  [["scripts/e2e/lib/mcp-code-mode-probe-server.ts"], ["mcp-code-mode-gateway"]],
  [["scripts/e2e/docker-openai-seed.ts"], allDockerSeedLanes],
  [
    [
      "scripts/e2e/mcp-code-mode-gateway-seed.ts",
      "scripts/e2e/mcp-channels-seed.ts",
      "scripts/e2e/lib/mcp-code-mode-probe-server.ts",
      "scripts/e2e/cron-mcp-cleanup-seed.ts",
    ],
    allDockerSeedLanes,
  ],
  [[".github/workflows/ci.yml"], allDockerSeedLanes],
  [["scripts/lib/ci-changed-node-test-plan.mts"], allDockerSeedLanes],
  [["scripts\\e2e\\lib\\mcp-code-mode-probe-server.ts"], ["mcp-code-mode-gateway"]],
  [["scripts/e2e/install-e2e.ts", "docs/ci.md"], []],
])("resolves Docker seed lanes for %j", (changedPaths, expected) => {
  expect(resolveChangedDockerSeedLanes(changedPaths)).toEqual(expected);
});

describe("CI changed Node test plan", () => {
  it.each([
    {
      source: "ui/src/styles/chat/layout.css",
      targets: [
        "ui/src/styles/base-theme-tokens.node.test.ts",
        "ui/src/styles/cursor-policy.node.test.ts",
      ],
    },
    {
      source: "ui/public/themes/tide.css",
      targets: [
        "ui/src/styles/base-theme-tokens.node.test.ts",
        "ui/src/styles/base-theme-contrast.node.test.ts",
      ],
    },
  ])("routes $source through source-scanning policy tests", ({ source, targets: expected }) => {
    const shards = createChangedNodeTestShards([source]);
    const targets = shards?.flatMap((shard) => shard.targets ?? []) ?? [];

    expect(targets).toEqual(expected);
  });

  it("routes cron alert sanitization changes through alert policy suites", () => {
    const shards = createChangedNodeTestShards(["src/cron/failure-notification-text.ts"]);
    const targets = shards?.flatMap((shard) => shard.targets ?? []) ?? [];

    expect(targets).toEqual([
      "src/cron/service.stream-trigger.test.ts",
      "src/cron/service.stream-validation.test.ts",
      "src/cron/service/timer.timeout-watchdog.test.ts",
    ]);
  });

  it("routes a focused source change into one targeted job", () => {
    expect(createChangedNodeTestShards(["src/agents/live-provider-owner.ts"])).toEqual([
      {
        checkName: "checks-node-changed",
        configs: [],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed",
        targets: [
          "src/agents/live-model-dynamic-candidates.test.ts",
          "src/agents/live-model-filter.test.ts",
          "src/agents/live-target-matcher.test.ts",
          "src/agents/model-compat.test.ts",
        ],
      },
    ]);
  });

  it("keeps boundary coverage on test-only diffs without the build-artifacts lane", () => {
    // Test-only diffs skip build-artifacts (which hosts the full boundary
    // gate), so the plan carries its own nondist boundary shard instead.
    expect(createChangedNodeTestShards(["test/extension-import-boundaries.test.ts"])).toEqual([
      {
        checkName: "checks-node-changed",
        configs: [],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed",
        targets: ["test/extension-import-boundaries.test.ts"],
      },
      {
        checkName: "checks-node-changed-boundary",
        configs: ["test/vitest/vitest.boundary.config.ts"],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed-boundary",
      },
    ]);
  });

  it("classifies build-artifact and QA smoke impact by changed surface", () => {
    expect(hasBuildArtifactAffectingChange(["src/agents/foo.test.ts", "test/helpers/x.ts"])).toBe(
      false,
    );
    expect(
      hasBuildArtifactAffectingChange([
        "src/gateway/server.auth.control-ui.trusted-proxy.suite.ts",
      ]),
    ).toBe(false);
    expect(hasBuildArtifactAffectingChange(["src/agents/foo.ts"])).toBe(true);
    // Build-input classification: only sources and the build pipeline can
    // change dist bytes; repo scripts, workflows, and qa scenarios cannot.
    expect(hasBuildArtifactAffectingChange(["scripts/build-all.mts"])).toBe(true);
    expect(hasBuildArtifactAffectingChange(["tsconfig.json"])).toBe(true);
    expect(hasBuildArtifactAffectingChange(["scripts/run-vitest.mjs"])).toBe(false);
    expect(hasBuildArtifactAffectingChange([".github/workflows/ci.yml"])).toBe(false);
    expect(hasBuildArtifactAffectingChange(["qa/scenarios/index.yaml"])).toBe(false);
    expect(hasBuildArtifactAffectingChange(["ui/src/app.ts"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["extensions/qa-lab/src/ci-smoke-plan.ts"])).toBe(true);
    expect(hasQaSmokeAffectingChange(["qa/scenarios/index.yaml"])).toBe(true);
    // Smoke drives matrix + telegram; other channel plugins are invisible to it.
    expect(hasQaSmokeAffectingChange(["extensions/telegram/src/index.ts"])).toBe(true);
    expect(hasQaSmokeAffectingChange(["extensions/discord/src/index.ts"])).toBe(false);
    // Broad runtime changes ride the main-push smoke run instead of taxing
    // every PR with the six-part matrix; only QA-owned surfaces select it.
    expect(hasQaSmokeAffectingChange(["ui/src/app.ts"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["src/infra/retry.ts"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["packages/llm-core/src/index.ts"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["pnpm-lock.yaml"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["scripts/run-vitest.mjs"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["test/scripts/ci-node-test-plan.test.ts"])).toBe(false);
    // The QA lane's own orchestration must not be able to skip the lane.
    expect(hasQaSmokeAffectingChange([".github/workflows/ci.yml"])).toBe(true);
    expect(hasQaSmokeAffectingChange([".github/actions/setup-node-env/action.yml"])).toBe(true);
    expect(hasQaSmokeAffectingChange(["scripts/lib/ci-changed-node-test-plan.mts"])).toBe(true);
    expect(hasQaSmokeAffectingChange([".github/workflows/labeler.yml"])).toBe(false);
  });

  it("classifies prompt-snapshot impact by surface and generator import graph", () => {
    // Inside the generator's import graph -> regenerated output can change.
    expect(hasPromptSnapshotAffectingChange(["src/auto-reply/reply/prompt-prelude.ts"])).toBe(true);
    // The codex extension loads through a dynamic bundled-plugin module id the
    // graph walk cannot see; it stays on the always-run surface.
    expect(hasPromptSnapshotAffectingChange(["extensions/codex/src/index.ts"])).toBe(true);
    expect(
      hasPromptSnapshotAffectingChange([
        "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/README.md",
      ]),
    ).toBe(true);
    expect(hasPromptSnapshotAffectingChange(["scripts/generate-prompt-snapshots.ts"])).toBe(true);
    // Workspace packages feed the generator through package-specifier imports
    // the relative graph walk cannot see.
    expect(hasPromptSnapshotAffectingChange(["packages/llm-core/src/index.ts"])).toBe(true);
    // The gate's own orchestration must not be able to skip the gated lane.
    expect(hasPromptSnapshotAffectingChange([".github/workflows/ci.yml"])).toBe(true);
    expect(hasPromptSnapshotAffectingChange(["scripts/lib/ci-changed-node-test-plan.mts"])).toBe(
      true,
    );
    // Outside the surface and the generator graph -> the lane may skip.
    expect(hasPromptSnapshotAffectingChange(["ui/src/app.ts"])).toBe(false);
    expect(hasPromptSnapshotAffectingChange(["extensions/discord/src/index.ts"])).toBe(false);
    expect(hasPromptSnapshotAffectingChange(["docs/index.md"])).toBe(false);
    expect(hasPromptSnapshotAffectingChange(["test/scripts/ci-node-test-plan.test.ts"])).toBe(
      false,
    );
    // Deleted source files cannot be graphed; fail safe to running the check.
    expect(hasPromptSnapshotAffectingChange(["src/infra/definitely-deleted-module.ts"])).toBe(true);
  });

  it("classifies SQLite session lifecycle impact by owner and import graph", () => {
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "src/agents/embedded-agent-runner/run/attempt-session-runtime-prepare.ts",
      ]),
    ).toBe(true);
    expect(
      hasSqliteSessionLifecycleAffectingChange(["src/gateway/server-methods/sessions.ts"]),
    ).toBe(true);
    expect(
      hasSqliteSessionLifecycleAffectingChange(["src/sessions/session-lifecycle-admission.ts"]),
    ).toBe(true);
    expect(hasSqliteSessionLifecycleAffectingChange(["src/config/sessions.ts"])).toBe(true);
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "test/scripts/sqlite-sessions-transcripts-flip-proof.built-cli.e2e.test.ts",
      ]),
    ).toBe(true);
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "packages/media-understanding-common/src/provider-id.ts",
      ]),
    ).toBe(false);
    expect(hasSqliteSessionLifecycleAffectingChange(["src/agents/model-auth.ts"])).toBe(false);
    expect(hasSqliteSessionLifecycleAffectingChange(["extensions/discord/src/index.ts"])).toBe(
      false,
    );
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "src/config/sessions/session-registry-maintenance.test.ts",
      ]),
    ).toBe(false);
    expect(
      hasSqliteSessionLifecycleAffectingChange(["src/infra/definitely-deleted-module.ts"]),
    ).toBe(false);
    expect(
      hasSqliteSessionLifecycleAffectingChange([
        "src/agents/embedded-agent-runner/run/deleted-session-runtime.ts",
      ]),
    ).toBe(true);
  });

  it("fails safe to the full plan for broad changes", () => {
    expect(createChangedNodeTestShards(["package.json"])).toBeNull();
  });

  it("keeps minimal-gateway boot coverage reachable from gateway startup changes", () => {
    // A gateway startup stall must fail in the gateway lane; the boot smoke is
    // selected purely through the import graph, so a rename or an import shape
    // the graph walker cannot see would silently drop it from targeted plans
    // and the stall would first surface on unrelated ui-e2e PRs again.
    const bootSmoke = "src/gateway/server-startup-minimal-boot.test.ts";
    expect(isGatewayServerTestFile(bootSmoke)).toBe(true);
    expect(
      hasImportGraphImpactOnTargets(
        ["src/gateway/server-startup-bootstrap.ts"],
        [bootSmoke],
        process.cwd(),
      ),
    ).toBe(true);
  });

  it("fails safe whenever a diff deletes source files", () => {
    expect(createChangedNodeTestShards(["src/infra/format-time/deleted-helper.ts"])).toBeNull();
    expect(
      createChangedNodeTestShards([
        "src/infra/format-time/deleted-helper.ts",
        "src/agents/live-provider-owner.ts",
      ]),
    ).toBeNull();
  });

  it("keeps targeting when a diff only deletes test files alongside live source", () => {
    const shards = createChangedNodeTestShards([
      "src/agents/deleted-obsolete.test.ts",
      "src/agents/live-provider-owner.ts",
    ]);
    expect(shards).not.toBeNull();
    const targets = shards?.flatMap((shard) => shard.targets ?? []) ?? [];
    expect(targets).toContain("src/agents/live-model-filter.test.ts");
  });

  it("runs only the boundary shard when a diff deletes test files", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ci-deleted-test-"));
    try {
      expect(createChangedNodeTestShards(["src/gone.test.ts"], { cwd })).toEqual([
        {
          checkName: "checks-node-changed-boundary",
          configs: ["test/vitest/vitest.boundary.config.ts"],
          requiresDist: false,
          runner: "blacksmith-8vcpu-ubuntu-2404",
          shardName: "changed-boundary",
        },
      ]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("fails safe when an unresolved path is mixed with a precise source change", () => {
    expect(
      createChangedNodeTestShards(["src/agents/live-provider-owner.ts", "tsconfig.json"]),
    ).toBeNull();
  });

  it("fails safe when public SDK changes affect extension imports", () => {
    expect(createChangedNodeTestShards(["src/plugin-sdk/core.ts"])).toBeNull();
  });

  it("fails safe when a core change reaches package consumers through the public SDK", () => {
    expect(createChangedNodeTestShards(["src/shared/text/strip-markdown.ts"])).toBeNull();
  });

  it("fails safe when a core change reaches a public SDK wrapper through an import", () => {
    expect(createChangedNodeTestShards(["src/channels/chat-meta-shared.ts"])).toBeNull();
  });

  it("fails safe when workspace package consumers use package imports", () => {
    expect(
      createChangedNodeTestShards(["packages/gateway-protocol/src/frame-guards.ts"]),
    ).toBeNull();
  });

  it("supplements mixed package diffs with the affected extension config", () => {
    const changedPaths = [
      "packages/gateway-protocol/src/frame-guards.ts",
      "extensions/codex/src/session-upstream-marker.ts",
    ];

    expect(createChangedNodeTestShards(changedPaths)).toBeNull();
    expectBoundedCodexFallback(createChangedExtensionFallbackShards(changedPaths));
  });

  it("covers every extension config when core changes can impact extension consumers", () => {
    const shards = createChangedExtensionFallbackShards([
      "src/gateway/tool-resolution.ts",
      "src/agents/openclaw-tools.ts",
      "extensions/discord/src/channel.ts",
    ]);

    expectAllExtensionConfigs(shards);
  });

  it("covers every extension config when the fallback planner itself changes", () => {
    expectAllExtensionConfigs(
      createChangedExtensionFallbackShards(["scripts/lib/ci-changed-node-test-plan.mts"]),
    );
  });

  it("covers every extension config when the extension inventory changes", () => {
    expectAllExtensionConfigs(
      createChangedExtensionFallbackShards(["scripts/lib/changed-extensions.mts"]),
    );
  });

  it("classifies core and fallback-gate extension impact", () => {
    expect(hasCoreExtensionImpact(["src/agents/openclaw-tools.ts"])).toBe(true);
    expect(hasCoreExtensionImpact(["scripts/lib/changed-extensions.mts"])).toBe(true);
    expect(hasCoreExtensionImpact(["scripts/lib/ci-changed-node-test-plan.mts"])).toBe(true);
    expect(hasCoreExtensionImpact(["scripts/lib/extension-test-plan.mts"])).toBe(true);
    expect(hasCoreExtensionImpact(["extensions/discord/src/channel.ts"])).toBe(false);
    expect(hasCoreExtensionImpact(["docs/ci.md"])).toBe(false);
  });

  it("keeps extension-only fallbacks scoped to the changed extension config", () => {
    expect(createChangedExtensionFallbackShards(["extensions/discord/src/channel.ts"])).toEqual([
      {
        checkName: "checks-node-changed-extensions-config",
        configs: ["test/vitest/vitest.extension-discord.config.ts"],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed-extensions-config",
      },
    ]);
  });

  it("does not create extension fallback shards for docs-only diffs", () => {
    expect(createChangedExtensionFallbackShards(["docs/ci.md"])).toEqual([]);
  });

  it.each([
    { name: "helper alone", changedPaths: [githubActivityHelper] },
    {
      name: "helper trio",
      changedPaths: [
        githubActivityHelper,
        ".agents/skills/openclaw-pr-maintainer/SKILL.md",
        "test/scripts/github-activity-helper.test.ts",
      ],
    },
  ])(
    "keeps hidden maintainer helper targets and compact core fallback for $name",
    ({ changedPaths }) => {
      expect(hasCoreExtensionImpact(changedPaths)).toBe(false);
      expect(createChangedExtensionFallbackShards(changedPaths)).toEqual([]);
      expect(resolveChangedTestTargetPlan(changedPaths, { broad: true })).toMatchObject({
        mode: "targets",
        targets: expect.arrayContaining(["test/scripts/github-activity-helper.test.ts"]),
      });
      expect(createChangedNodeTestShards(changedPaths)).toBeNull();
    },
  );

  it.each([
    "src/plugin-sdk/core.ts",
    ".agents/skills/openclaw-pr-maintainer/scripts/unknown-helper.sh",
  ])(
    "retains all extension configs for the hidden maintainer helper mixed with %s",
    (changedPath) => {
      const paths = [githubActivityHelper, changedPath];
      expect(hasCoreExtensionImpact(paths)).toBe(true);
      expect(createChangedNodeTestShards(paths)).toBeNull();
      expectAllExtensionConfigs(createChangedExtensionFallbackShards(paths));
    },
  );

  it.each([
    {
      changedPath: "extensions/browser/src/browser/cdp.helpers.test.ts",
      config: "test/vitest/vitest.extension-browser.config.ts",
    },
    {
      changedPath: "extensions/codex/src/session-upstream-marker.ts",
      config: "test/vitest/vitest.extension-codex.config.ts",
    },
  ])("runs the whole owning extension config for $changedPath", ({ changedPath, config }) => {
    const shards = createChangedNodeTestShards([changedPath]);

    expect(shards).not.toBeNull();
    expect(shards?.flatMap((shard) => shard.configs)).toContain(config);
  });

  it("packs Telegram process lifetimes into bounded changed-extension jobs", () => {
    const shards = createChangedExtensionFallbackShards(["extensions/telegram/src/channel.ts"]);
    const targets = shards.flatMap((shard) => shard.includePatterns ?? []);

    expect(shards.length).toBeGreaterThan(1);
    expect(
      shards.every(
        (shard) =>
          shard.configs[0] === "test/vitest/vitest.extension-telegram.config.ts" &&
          (shard.includePatterns?.length ?? 0) > 0 &&
          (shard.includePatterns?.length ?? 0) <= 10,
      ),
    ).toBe(true);
    expect(targets.length).toBeGreaterThan(10);
    expect(new Set(targets).size).toBe(targets.length);
    expect(shards).toHaveLength(Math.ceil(targets.length / 10));
  });

  it("preserves Matrix process bounds in mixed package fallbacks", () => {
    const shards = createChangedExtensionFallbackShards([
      "packages/gateway-protocol/src/frame-guards.ts",
      "extensions/matrix/src/channel.ts",
    ]);
    const targets = shards.flatMap((shard) => shard.includePatterns ?? []);

    expect(shards.length).toBeGreaterThan(1);
    expect(
      shards.every(
        (shard) =>
          shard.configs[0] === "test/vitest/vitest.extension-matrix.config.ts" &&
          (shard.includePatterns?.length ?? 0) > 0 &&
          (shard.includePatterns?.length ?? 0) <= 40,
      ),
    ).toBe(true);
    expect(targets.length).toBeGreaterThan(40);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("skips extension fallback when the core-impact predicate does not fire", () => {
    expect(createChangedExtensionFallbackShards(["src/agents/live-provider-owner.ts"])).toEqual([]);
  });

  it("falls back to bounded Codex config shards for deleted sources", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ci-extension-fallback-"));
    try {
      expectBoundedCodexFallback(
        createChangedExtensionFallbackShards(["extensions/codex/src/deleted-session-runtime.ts"], {
          cwd,
        }),
      );
      expect(
        createChangedExtensionFallbackShards(
          ["extensions/codex/src/deleted-session-runtime.test.ts"],
          { cwd },
        ),
      ).toEqual([]);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("serializes the Memory Core extension fallback config", () => {
    expect(
      createChangedExtensionFallbackShards(["extensions/memory-core/src/memory/mmr.ts"]),
    ).toEqual([
      {
        checkName: "checks-node-changed-extensions-config",
        configs: ["test/vitest/vitest.extension-memory.config.ts"],
        planConcurrency: 1,
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed-extensions-config",
      },
    ]);
  });

  it("prebuilds private QA dist before the QA Lab extension fallback", () => {
    expect(createChangedExtensionFallbackShards(["extensions/qa-lab/src/cli.runtime.ts"])).toEqual([
      expect.objectContaining({
        configs: ["test/vitest/vitest.extension-qa.config.ts"],
        pretestBuildMode: "private-qa",
      }),
    ]);
  });

  it("routes lifecycle edits to the prepared QA config without losing boundary coverage", () => {
    const target = "extensions/qa-lab/src/suite-process-lifecycle.test.ts";
    expect(createChangedNodeTestShards([target])).toEqual([
      expect.objectContaining({
        configs: ["test/vitest/vitest.extension-qa.config.ts"],
        pretestBuildMode: "private-qa",
      }),
      expect.objectContaining({ configs: ["test/vitest/vitest.boundary.config.ts"] }),
    ]);
  });

  it("fails safe when a targeted config needs special shard setup", () => {
    expect(createChangedNodeTestShards(["scripts/docs-i18n/main.go"])).toBeNull();
    expect(createChangedNodeTestShards(["src/tui/tui-pty-harness.e2e.test.ts"])).toBeNull();
  });

  it("fails safe when an unresolved source only finds an unrelated directory test", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "openclaw-ci-target-"));
    try {
      mkdirSync(path.join(cwd, "src"));
      writeFileSync(path.join(cwd, "src/value.ts"), "export const value = 1;\n");
      writeFileSync(path.join(cwd, "src/unrelated.test.ts"), "export const unrelated = true;\n");
      expect(createChangedNodeTestShards(["src/value.ts"], { cwd })).toBeNull();
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("fails safe for aggregate full-suite configs", () => {
    expect(
      createChangedNodeTestShards(["test/vitest/vitest.full-core-support-boundary.config.ts"]),
    ).toBeNull();
  });

  it("fails safe for leaf configs split across full-suite processes", () => {
    expect(createChangedNodeTestShards(["test/vitest/vitest.commands.config.ts"])).toBeNull();
  });

  it("fails safe when source targets expand to a whole config", () => {
    expect(
      createChangedNodeTestShards(["ui/src/app-routes.ts", "ui/src/app-navigation.ts"]),
    ).toBeNull();
  });

  it("chunks many targets into bounded parallel jobs", () => {
    // A wide test-file diff exercises the multi-chunk path against the real
    // tree; the cron suite has well over one chunk's worth of test files.
    const changedTests = listGitTrackedFiles({ pathspecs: "src/cron" })
      ?.filter((file) => file.endsWith(".test.ts") && !/\.(?:e2e|live)\.test\.ts$/u.test(file))
      .slice(0, 15);
    expect(changedTests?.length).toBe(15);
    const shards = createChangedNodeTestShards(changedTests ?? []);
    expect(shards).not.toBeNull();
    const targetShards = shards?.filter((shard) => shard.targets) ?? [];
    expect(targetShards.length).toBeGreaterThan(1);
    expect(
      targetShards.every((shard, index) => shard.checkName === `checks-node-changed-${index + 1}`),
    ).toBe(true);
    expect(targetShards.every((shard) => (shard.targets?.length ?? 0) <= 12)).toBe(true);
    const targets = targetShards.flatMap((shard) => shard.targets ?? []);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("serializes the owning Memory Core extension config for direct changes", () => {
    const shards = createChangedNodeTestShards([
      "extensions/memory-core/src/memory/mmr.ts",
      "extensions/memory-core/src/memory/mmr.test.ts",
    ]);
    expect(shards).not.toBeNull();
    expect(shards).toContainEqual({
      checkName: "checks-node-changed-extensions-config",
      configs: ["test/vitest/vitest.extension-memory.config.ts"],
      planConcurrency: 1,
      requiresDist: false,
      runner: "blacksmith-8vcpu-ubuntu-2404",
      shardName: "changed-extensions-config",
    });
  });
});
