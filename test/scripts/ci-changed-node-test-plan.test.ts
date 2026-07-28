import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createChangedNodeTestShards,
  hasBuildArtifactAffectingChange,
  hasPromptSnapshotAffectingChange,
  hasQaSmokeAffectingChange,
} from "../../scripts/lib/ci-changed-node-test-plan.mjs";
import { listGitTrackedFiles } from "../../src/test-utils/repo-files.js";

describe("CI changed Node test plan", () => {
  it("routes a focused source change into one targeted job", () => {
    expect(createChangedNodeTestShards(["src/agents/live-model-filter.ts"])).toEqual([
      {
        checkName: "checks-node-changed",
        configs: [],
        requiresDist: false,
        runner: "blacksmith-8vcpu-ubuntu-2404",
        shardName: "changed",
        targets: [
          "src/agents/live-model-filter.test.ts",
          "src/agents/live-model-dynamic-candidates.test.ts",
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
    expect(hasBuildArtifactAffectingChange(["src/agents/foo.ts"])).toBe(true);
    // Build-input classification: only sources and the build pipeline can
    // change dist bytes; repo scripts, workflows, and qa scenarios cannot.
    expect(hasBuildArtifactAffectingChange(["scripts/build-all.mjs"])).toBe(true);
    expect(hasBuildArtifactAffectingChange(["tsconfig.json"])).toBe(true);
    expect(hasBuildArtifactAffectingChange(["scripts/run-vitest.mjs"])).toBe(false);
    expect(hasBuildArtifactAffectingChange([".github/workflows/ci.yml"])).toBe(false);
    expect(hasBuildArtifactAffectingChange(["qa/scenarios/index.yaml"])).toBe(false);
    expect(hasBuildArtifactAffectingChange(["ui/src/app.ts"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["extensions/qa-lab/src/ci-smoke-plan.ts"])).toBe(true);
    expect(hasQaSmokeAffectingChange(["ui/src/app.ts"])).toBe(true);
    // Inside the packaged CLI's import graph -> the smoke scenarios can see it.
    expect(hasQaSmokeAffectingChange(["src/infra/retry.ts"])).toBe(true);
    // Smoke drives matrix + telegram; other channel plugins are invisible to it.
    expect(hasQaSmokeAffectingChange(["extensions/telegram/src/index.ts"])).toBe(true);
    expect(hasQaSmokeAffectingChange(["extensions/discord/src/index.ts"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["scripts/run-vitest.mjs"])).toBe(false);
    expect(hasQaSmokeAffectingChange(["test/scripts/ci-node-test-plan.test.ts"])).toBe(false);
    // The QA lane's own orchestration must not be able to skip the lane.
    expect(hasQaSmokeAffectingChange([".github/workflows/ci.yml"])).toBe(true);
    expect(hasQaSmokeAffectingChange([".github/actions/setup-node-env/action.yml"])).toBe(true);
    expect(hasQaSmokeAffectingChange(["scripts/lib/ci-changed-node-test-plan.mjs"])).toBe(true);
    expect(hasQaSmokeAffectingChange([".github/workflows/labeler.yml"])).toBe(false);
    // Deleted source files cannot be graphed; fail safe to running QA smoke.
    expect(hasQaSmokeAffectingChange(["src/infra/definitely-deleted-module.ts"])).toBe(true);
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
    expect(hasPromptSnapshotAffectingChange(["scripts/lib/ci-changed-node-test-plan.mjs"])).toBe(
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

  it("fails safe to the full plan for broad changes", () => {
    expect(createChangedNodeTestShards(["package.json"])).toBeNull();
  });

  it("fails safe whenever a diff deletes source files", () => {
    expect(createChangedNodeTestShards(["src/infra/format-time/deleted-helper.ts"])).toBeNull();
    expect(
      createChangedNodeTestShards([
        "src/infra/format-time/deleted-helper.ts",
        "src/agents/live-model-filter.ts",
      ]),
    ).toBeNull();
  });

  it("keeps targeting when a diff only deletes test files alongside live source", () => {
    const shards = createChangedNodeTestShards([
      "src/agents/deleted-obsolete.test.ts",
      "src/agents/live-model-filter.ts",
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
      createChangedNodeTestShards(["src/agents/live-model-filter.ts", "tsconfig.json"]),
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
});
