import path from "node:path";
import fg from "fast-glob";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS,
  applyDefaultMultiSpecVitestCachePaths,
  applyDefaultVitestNoOutputTimeout,
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
  buildVitestRunPlans,
  listFullExtensionVitestProjectConfigs,
  orderFullSuiteSpecsForParallelRun,
  shouldAcquireLocalHeavyCheckLock,
  resolveChangedTestTargetPlan,
  resolveChangedTargetArgs,
  resolveParallelFullSuiteConcurrency,
  shouldRetryVitestNoOutputTimeout,
} from "../../scripts/test-projects.test-support.mjs";
import { fullSuiteVitestShards } from "../vitest/vitest.test-shards.mjs";

const normalizeRepoPath = (value: string) => value.replaceAll("\\", "/");

type VitestTestConfig = {
  dir?: string;
  exclude?: string[];
  include?: string[];
};

type VitestConfig = {
  test?: VitestTestConfig;
};

type VitestConfigFactory = (env?: Record<string, string | undefined>) => VitestConfig;

function isVitestConfigFactory(value: unknown): value is VitestConfigFactory {
  return typeof value === "function";
}

function findVitestConfigFactory(mod: Record<string, unknown>): VitestConfigFactory | null {
  for (const [name, value] of Object.entries(mod)) {
    if (
      name !== "default" &&
      /^create.*VitestConfig$/u.test(name) &&
      isVitestConfigFactory(value)
    ) {
      return value;
    }
  }
  return null;
}

async function loadRawVitestConfig(configPath: string): Promise<VitestConfig> {
  const previousArgv = process.argv;
  const previousIncludeFile = process.env.OPENCLAW_VITEST_INCLUDE_FILE;
  process.argv = [previousArgv[0] ?? "node", previousArgv[1] ?? "vitest"];
  delete process.env.OPENCLAW_VITEST_INCLUDE_FILE;
  try {
    const mod = (await import(path.resolve(process.cwd(), configPath))) as Record<string, unknown>;
    return findVitestConfigFactory(mod)?.(process.env) ?? ((mod.default ?? {}) as VitestConfig);
  } finally {
    process.argv = previousArgv;
    if (previousIncludeFile === undefined) {
      delete process.env.OPENCLAW_VITEST_INCLUDE_FILE;
    } else {
      process.env.OPENCLAW_VITEST_INCLUDE_FILE = previousIncludeFile;
    }
  }
}

async function listMatchedTestFilesForConfig(configPath: string): Promise<string[]> {
  const testConfig = (await loadRawVitestConfig(configPath)).test ?? {};
  const dir = testConfig.dir ? path.resolve(process.cwd(), testConfig.dir) : process.cwd();
  const include = testConfig.include ?? [];
  const exclude = (testConfig.exclude ?? []).map((pattern) =>
    path.isAbsolute(pattern)
      ? normalizeRepoPath(path.relative(dir, pattern))
      : normalizeRepoPath(pattern),
  );
  return fg
    .sync(include, {
      absolute: false,
      cwd: dir,
      dot: false,
      ignore: exclude,
    })
    .map((file) => normalizeRepoPath(path.relative(process.cwd(), path.resolve(dir, file))))
    .toSorted((left, right) => left.localeCompare(right));
}

async function listFullSuiteTestFileMatches(): Promise<Map<string, string[]>> {
  const configs = [...new Set(fullSuiteVitestShards.flatMap((shard) => shard.projects))];
  const matches = new Map<string, string[]>();
  for (const config of configs) {
    for (const file of await listMatchedTestFilesForConfig(config)) {
      matches.set(file, [...(matches.get(file) ?? []), config]);
    }
  }
  return matches;
}

describe("scripts/test-projects changed-target routing", () => {
  it("maps changed source files into scoped lane targets", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "src/shared/string-normalization.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toEqual(["src/shared/string-normalization.test.ts", "src/utils/provider-utils.test.ts"]);
  });

  it("keeps changed mode focused by default for Vitest wiring edits", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "test/vitest/vitest.shared.config.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toEqual(["src/utils/provider-utils.test.ts"]);
  });

  it("keeps the broad changed run available for Vitest wiring edits", () => {
    expect(
      resolveChangedTargetArgs(
        ["--changed", "origin/main"],
        process.cwd(),
        () => ["test/vitest/vitest.shared.config.ts", "src/utils/provider-utils.ts"],
        { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
      ),
    ).toBeNull();
  });

  it("keeps test runner implementation edits on runner tests", () => {
    expect(
      resolveChangedTestTargetPlan([
        "scripts/check-changed.mjs",
        "scripts/test-projects.test-support.d.mts",
        "scripts/test-projects.test-support.mjs",
        "test/scripts/changed-lanes.test.ts",
      ]),
    ).toEqual({
      mode: "targets",
      targets: ["test/scripts/changed-lanes.test.ts", "test/scripts/test-projects.test.ts"],
    });
  });

  it("routes group visible reply config changes through channel delivery regressions", () => {
    expect(
      resolveChangedTestTargetPlan([
        "src/config/types.messages.ts",
        "src/config/zod-schema.core.ts",
      ]),
    ).toEqual({
      mode: "targets",
      targets: [
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    });
  });

  it("routes source reply prompt changes through prompt and channel delivery regressions", () => {
    expect(resolveChangedTestTargetPlan(["src/agents/system-prompt.ts"])).toEqual({
      mode: "targets",
      targets: [
        "src/agents/system-prompt.test.ts",
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    });
  });

  it("routes source reply delivery mode changes through channel delivery regressions", () => {
    expect(
      resolveChangedTestTargetPlan(["src/auto-reply/reply/source-reply-delivery-mode.ts"]),
    ).toEqual({
      mode: "targets",
      targets: [
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    });
  });

  it("routes channel reply pipeline SDK changes through SDK and channel delivery regressions", () => {
    expect(resolveChangedTestTargetPlan(["src/plugin-sdk/channel-reply-pipeline.ts"])).toEqual({
      mode: "targets",
      targets: [
        "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
      ],
    });
  });

  it("routes reply runtime SDK exports through plugin SDK contract tests", () => {
    expect(resolveChangedTestTargetPlan(["src/plugin-sdk/reply-runtime.ts"])).toEqual({
      mode: "targets",
      targets: ["src/plugins/contracts/plugin-sdk-subpaths.test.ts"],
    });
  });

  it("keeps extension batch runner edits on extension script tests", () => {
    expect(resolveChangedTestTargetPlan(["scripts/test-extension-batch.mjs"])).toEqual({
      mode: "targets",
      targets: ["test/scripts/test-extension.test.ts"],
    });
  });

  it("does not route live tests through the normal changed-test lane", () => {
    expect(
      resolveChangedTestTargetPlan(["src/gateway/gateway-codex-harness.live.test.ts"]),
    ).toEqual({
      mode: "targets",
      targets: [],
    });
  });

  it("routes changed extension vitest configs to their own shard", () => {
    expect(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "test/vitest/vitest.extension-discord.config.ts",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.extension-discord.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("routes contract roots to separate contract shards", () => {
    const plans = buildVitestRunPlans([
      "src/channels/plugins/contracts/channel-catalog.contract.test.ts",
      "src/plugins/contracts/loader.contract.test.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.contracts-channel-surface.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/channels/plugins/contracts/channel-catalog.contract.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.contracts-plugin.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugins/contracts/loader.contract.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes misc extensions to the misc extension shard", () => {
    const plans = buildVitestRunPlans(["extensions/thread-ownership"], process.cwd());

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.extension-misc.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/thread-ownership/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes browser extension changes to the browser extension lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "extensions/browser/src/browser/cdp.helpers.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.extension-browser.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/browser/src/browser/cdp.helpers.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps shared test helpers cheap by default when no precise target exists", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "test/helpers/poll.ts",
      ]),
    ).toStrictEqual([]);
  });

  it("keeps the broad changed run available for shared test helpers", () => {
    expect(
      resolveChangedTargetArgs(
        ["--changed", "origin/main"],
        process.cwd(),
        () => ["test/helpers/poll.ts"],
        { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
      ),
    ).toBeNull();
  });

  it("routes channel contract helper edits through the tests that import them", () => {
    const plan = resolveChangedTestTargetPlan([
      "src/channels/plugins/contracts/test-helpers/manifest.ts",
    ]);

    expect(plan.mode).toBe("targets");
    expect(plan.targets).toContain("src/channels/plugins/contracts/registry.contract.test.ts");
    expect(plan.targets).not.toContain("extensions/discord/src/directory-contract.test.ts");
  });

  it("routes channel SDK helper edits through the tests that import them", () => {
    expect(resolveChangedTestTargetPlan(["src/plugin-sdk/test-helpers/directory-ids.ts"])).toEqual({
      mode: "targets",
      targets: [
        "extensions/discord/src/directory-contract.test.ts",
        "extensions/slack/src/directory-contract.test.ts",
        "extensions/telegram/src/directory-contract.test.ts",
      ],
    });
  });

  it("routes channel contract helper edits through contract shards", () => {
    const plan = resolveChangedTestTargetPlan([
      "src/channels/plugins/contracts/test-helpers/registry-backed-contract-shards.ts",
    ]);

    expect(plan.mode).toBe("targets");
    expect(plan.targets).toContain(
      "src/channels/plugins/contracts/plugin.registry-backed-shard-a.contract.test.ts",
    );
    expect(plan.targets).toContain(
      "src/channels/plugins/contracts/threading.registry-backed-shard-h.contract.test.ts",
    );
    expect(plan.targets).not.toContain("extensions/discord/src/channel-actions.contract.test.ts");
  });

  it("routes precise plugin contract helpers without broad-running every shard", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "src/plugins/contracts/tts-contract-suites.ts",
      ]),
    ).toEqual([
      "src/plugins/contracts/core-extension-facade-boundary.test.ts",
      "src/plugins/contracts/tts.contract.test.ts",
    ]);
  });

  it("keeps unknown root surfaces cheap by default", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "unknown/file.txt",
      ]),
    ).toStrictEqual([]);
  });

  it("keeps the broad changed run available for unknown root surfaces", () => {
    expect(
      resolveChangedTargetArgs(
        ["--changed", "origin/main"],
        process.cwd(),
        () => ["unknown/file.txt"],
        { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
      ),
    ).toBeNull();
  });

  it("skips changed docs files that cannot map to test lanes", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "docs/help/testing.md",
      ]),
    ).toStrictEqual([]);
  });

  it("skips root agent guidance changes instead of broad-running tests", () => {
    expect(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => ["AGENTS.md"]),
    ).toStrictEqual([]);
  });

  it("skips app-only changes because app tests are separate from Vitest lanes", () => {
    expect(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "apps/macos/OpenClaw/AppDelegate.swift",
      ]),
    ).toStrictEqual([]);
  });

  it("keeps public plugin SDK changes focused by default", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/plugin-sdk/provider-entry.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/provider-entry.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("adds extension tests for public plugin SDK changes in broad changed mode", () => {
    const plans = buildVitestRunPlans(
      ["--changed", "origin/main"],
      process.cwd(),
      () => ["src/plugin-sdk/provider-entry.ts"],
      { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
    );

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/provider-entry.test.ts"],
        watchMode: false,
      },
      ...listFullExtensionVitestProjectConfigs().map((config) => ({
        config,
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      })),
    ]);
  });

  it("routes LM Studio changes to the provider extension lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "extensions/lmstudio/src/runtime.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.extension-providers.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/lmstudio/src/runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes QA extension changes to the QA extension lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "extensions/qa-lab/src/scenario-catalog.test.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.extension-qa.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/qa-lab/src/scenario-catalog.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes the top-level extensions target to every extension shard", () => {
    expect(buildVitestRunPlans(["extensions"], process.cwd())).toEqual(
      listFullExtensionVitestProjectConfigs().map((config) => ({
        config,
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      })),
    );
  });

  it("narrows default-lane changed source files to affected tests", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "packages/sdk/src/index.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: ["packages/sdk/src/index.test.ts"],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("routes changed source files to sibling tests when present", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/agents/live-model-turn-probes.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/agents/live-model-turn-probes.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes changed ui support files to the ui lane without dead include globs", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "ui/src/styles/base.css",
      "ui/src/test-helpers/lit-warnings.setup.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.ui.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("routes unit ui test targets to the unit ui lane", () => {
    expect(buildVitestRunPlans(["ui/src/ui/chat/grouped-render.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.unit-ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/chat/grouped-render.test.ts"],
        watchMode: false,
      },
    ]);

    expect(buildVitestRunPlans(["ui/src/ui/views/chat.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.unit-ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/views/chat.test.ts"],
        watchMode: false,
      },
    ]);

    expect(buildVitestRunPlans(["ui/src/ui/views/dreaming.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.unit-ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/views/dreaming.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes changed unit ui tests to the unit ui lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "ui/src/ui/chat/grouped-render.test.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/chat/grouped-render.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes auto-reply route source files to route regression tests", () => {
    expect(
      resolveChangedTestTargetPlan([
        "src/auto-reply/reply/dispatch-from-config.ts",
        "src/auto-reply/reply/effective-reply-route.ts",
        "src/auto-reply/reply/effective-reply-route.test.ts",
      ]),
    ).toEqual({
      mode: "targets",
      targets: [
        "src/auto-reply/reply/dispatch-acp.test.ts",
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/followup-runner.test.ts",
        "src/auto-reply/reply/groups.test.ts",
        "extensions/discord/src/monitor/message-handler.process.test.ts",
        "extensions/slack/src/monitor.tool-result.test.ts",
        "src/auto-reply/reply/effective-reply-route.test.ts",
      ],
    });
  });

  it("routes ACP command source files to ACP command regression tests", () => {
    expect(
      resolveChangedTestTargetPlan([
        "src/auto-reply/reply/commands-acp.ts",
        "src/auto-reply/reply/commands-acp.test.ts",
        "src/auto-reply/reply/dispatch-acp-command-bypass.ts",
        "src/auto-reply/reply/dispatch-acp-command-bypass.test.ts",
      ]),
    ).toEqual({
      mode: "targets",
      targets: [
        "src/auto-reply/reply/commands-acp.test.ts",
        "src/auto-reply/reply/dispatch-acp-command-bypass.test.ts",
      ],
    });
  });

  it("routes Google Meet CLI edits to the lightweight CLI tests", () => {
    expect(resolveChangedTestTargetPlan(["extensions/google-meet/src/cli.ts"])).toEqual({
      mode: "targets",
      targets: ["extensions/google-meet/src/cli.test.ts"],
    });
  });

  it("routes Google Meet OAuth edits to the lightweight OAuth tests", () => {
    expect(resolveChangedTestTargetPlan(["extensions/google-meet/src/oauth.ts"])).toEqual({
      mode: "targets",
      targets: ["extensions/google-meet/src/oauth.test.ts"],
    });
  });

  it("routes Google Meet entry edits to the plugin entry tests", () => {
    expect(resolveChangedTestTargetPlan(["extensions/google-meet/index.ts"])).toEqual({
      mode: "targets",
      targets: ["extensions/google-meet/index.test.ts"],
    });
  });

  it("routes memory doctor and embedding default edits to focused tests", () => {
    expect(
      resolveChangedTestTargetPlan([
        "src/commands/doctor-memory-search.ts",
        "src/memory-host-sdk/host/embedding-defaults.ts",
      ]),
    ).toEqual({
      mode: "targets",
      targets: [
        "src/commands/doctor-memory-search.test.ts",
        "packages/memory-host-sdk/src/host/embeddings.test.ts",
      ],
    });
  });

  it("routes commitment model-selection runtime edits away from broad gateway dependents", () => {
    expect(
      resolveChangedTestTargetPlan([
        "src/agents/model-selection.test.ts",
        "src/commitments/model-selection.runtime.ts",
        "src/commitments/runtime.test.ts",
        "src/commitments/runtime.ts",
      ]),
    ).toEqual({
      mode: "targets",
      targets: ["src/agents/model-selection.test.ts", "src/commitments/runtime.test.ts"],
    });
  });

  it("routes provider auth choice edits to focused auth-choice tests", () => {
    expect(resolveChangedTestTargetPlan(["src/plugins/provider-auth-choice.ts"])).toEqual({
      mode: "targets",
      targets: [
        "src/commands/auth-choice.apply.plugin-provider.test.ts",
        "src/commands/auth-choice.test.ts",
      ],
    });
  });

  it("routes provider env var edits to focused secret tests", () => {
    expect(resolveChangedTestTargetPlan(["src/secrets/provider-env-vars.ts"])).toEqual({
      mode: "targets",
      targets: [
        "src/secrets/provider-env-vars.dynamic.test.ts",
        "src/secrets/provider-env-vars.test.ts",
      ],
    });
  });

  it("routes changed utils and shared files to their light scoped lanes", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/shared/string-normalization.ts",
      "src/utils/provider-utils.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/shared/string-normalization.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.utils.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/utils/provider-utils.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes explicit plugin-sdk light tests to the lighter plugin-sdk lane", () => {
    const plans = buildVitestRunPlans(["src/plugin-sdk/temp-path.test.ts"], process.cwd());

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.plugin-sdk-light.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/temp-path.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes explicit commands light tests to the lighter commands lane", () => {
    const plans = buildVitestRunPlans(["src/commands/status-json-runtime.test.ts"], process.cwd());

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.commands-light.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/status-json-runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes unit-fast light tests to the cache-friendly unit-fast lane", () => {
    const plans = buildVitestRunPlans(
      ["src/commands/status-overview-values.test.ts"],
      process.cwd(),
    );

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/status-overview-values.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes changed commands source allowlist files to sibling light tests", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/commands/status-overview-values.ts",
      "src/commands/gateway-status/helpers.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "src/commands/status-overview-values.test.ts",
          "src/commands/gateway-status/helpers.test.ts",
        ],
        watchMode: false,
      },
    ]);
  });

  it("routes plugin-sdk source files with sibling tests narrowly by default", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/plugin-sdk/facade-runtime.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.bundled.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/facade-runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes plugin-sdk source files with sibling tests plus extensions in broad changed mode", () => {
    const plans = buildVitestRunPlans(
      ["--changed", "origin/main"],
      process.cwd(),
      () => ["src/plugin-sdk/facade-runtime.ts"],
      { env: { OPENCLAW_TEST_CHANGED_BROAD: "1" } },
    );

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.bundled.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/facade-runtime.test.ts"],
        watchMode: false,
      },
      ...listFullExtensionVitestProjectConfigs().map((config) => ({
        config,
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      })),
    ]);
  });

  it("routes command source files with sibling tests narrowly on the command lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/commands/channels.add.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.commands.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/channels.add.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps changed mode to precise targets by default", () => {
    expect(resolveChangedTestTargetPlan(["package.json", "src/commands/channels.add.ts"])).toEqual({
      mode: "targets",
      targets: ["src/commands/channels.add.test.ts"],
    });
  });

  it("keeps broad changed fallback available through explicit env", () => {
    expect(
      resolveChangedTestTargetPlan(["package.json", "src/commands/channels.add.ts"], {
        env: { OPENCLAW_TEST_CHANGED_BROAD: "1" },
      }),
    ).toEqual({
      mode: "broad",
      targets: [],
    });
  });

  it("uses import-graph targets in default changed mode", () => {
    expect(resolveChangedTestTargetPlan(["test/helpers/normalize-text.ts"]).targets).toContain(
      "src/auto-reply/status.test.ts",
    );
  });

  it.each([
    "src/gateway/gateway.test.ts",
    "src/gateway/server.startup-matrix-migration.integration.test.ts",
    "src/gateway/sessions-history-http.test.ts",
  ])("routes gateway integration fixture %s to the e2e lane", (target) => {
    const plans = buildVitestRunPlans([target], process.cwd());

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.e2e.config.ts",
        forwardedArgs: [target],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });
});

describe("scripts/test-projects local heavy-check lock", () => {
  const localCheckEnv = () => ({
    ...process.env,
    OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: undefined,
    OPENCLAW_TEST_PROJECTS_FORCE_LOCK: undefined,
  });

  it("skips the lock for a single scoped tooling run", () => {
    expect(
      shouldAcquireLocalHeavyCheckLock(
        [
          {
            config: "test/vitest/vitest.tooling.config.ts",
            includePatterns: ["test/scripts/committer.test.ts"],
            watchMode: false,
          },
        ],
        localCheckEnv(),
      ),
    ).toBe(false);
  });

  it("keeps the lock for non-tooling runs", () => {
    expect(
      shouldAcquireLocalHeavyCheckLock(
        [
          {
            config: "test/vitest/vitest.unit.config.ts",
            includePatterns: ["src/infra/vitest-config.test.ts"],
            watchMode: false,
          },
        ],
        localCheckEnv(),
      ),
    ).toBe(true);
  });

  it("skips the lock when a parent changed gate already holds it", () => {
    expect(
      shouldAcquireLocalHeavyCheckLock(
        [
          {
            config: "test/vitest/vitest.unit.config.ts",
            includePatterns: ["src/infra/vitest-config.test.ts"],
            watchMode: false,
          },
        ],
        {
          ...localCheckEnv(),
          OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD: "1",
        },
      ),
    ).toBe(false);
  });

  it("allows forcing the lock back on", () => {
    expect(
      shouldAcquireLocalHeavyCheckLock(
        [
          {
            config: "test/vitest/vitest.tooling.config.ts",
            includePatterns: ["test/scripts/committer.test.ts"],
            watchMode: false,
          },
        ],
        {
          ...localCheckEnv(),
          OPENCLAW_TEST_PROJECTS_FORCE_LOCK: "1",
        },
      ),
    ).toBe(true);
  });
});

describe("scripts/test-projects full-suite sharding", () => {
  it("interleaves heavy and light configs for cold parallel full-suite runs", () => {
    const specs = [
      "test/vitest/vitest.gateway.config.ts",
      "test/vitest/vitest.gateway-server.config.ts",
      "test/vitest/vitest.commands.config.ts",
      "test/vitest/vitest.extension-memory.config.ts",
      "test/vitest/vitest.extension-msteams.config.ts",
    ].map((config) => ({ config }));

    expect(orderFullSuiteSpecsForParallelRun(specs).map((spec) => spec.config)).toEqual([
      "test/vitest/vitest.gateway-server.config.ts",
      "test/vitest/vitest.extension-msteams.config.ts",
      "test/vitest/vitest.gateway.config.ts",
      "test/vitest/vitest.extension-memory.config.ts",
      "test/vitest/vitest.commands.config.ts",
    ]);
  });

  it("covers each normal full-suite test file exactly once", async () => {
    const matches = await listFullSuiteTestFileMatches();
    const e2eNamedIntegrationTests = new Set([
      "src/gateway/gateway.test.ts",
      "src/gateway/server.startup-matrix-migration.integration.test.ts",
      "src/gateway/sessions-history-http.test.ts",
    ]);
    const normalTestFiles = fg
      .sync(["**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"], {
        cwd: process.cwd(),
        dot: false,
        ignore: ["**/.*/**", "**/dist/**", "**/node_modules/**", "**/vendor/**"],
      })
      .map(normalizeRepoPath)
      .filter(
        (file) =>
          !file.includes(".live.test.") &&
          !file.includes(".e2e.test.") &&
          !file.startsWith("test/fixtures/") &&
          !e2eNamedIntegrationTests.has(file),
      )
      .toSorted((left, right) => left.localeCompare(right));

    const missing = normalTestFiles.filter((file) => !matches.has(file));
    const duplicated = [...matches.entries()]
      .filter(([, configs]) => configs.length > 1)
      .map(([file, configs]) => `${file}: ${configs.join(", ")}`)
      .toSorted((left, right) => left.localeCompare(right));

    expect(missing).toStrictEqual([]);
    expect(duplicated).toStrictEqual([]);
  });

  it("uses the large host-aware local profile on roomy local hosts", () => {
    expect(
      resolveParallelFullSuiteConcurrency(
        61,
        {},
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toBe(10);
  });

  it("keeps CI full-suite runs serial even on roomy hosts", () => {
    expect(
      resolveParallelFullSuiteConcurrency(
        61,
        {
          CI: "true",
        },
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toBe(1);
  });

  it("keeps explicit parallel overrides ahead of the host-aware profile", () => {
    expect(
      resolveParallelFullSuiteConcurrency(
        61,
        {
          OPENCLAW_TEST_PROJECTS_PARALLEL: "3",
        },
        {
          cpuCount: 14,
          loadAverage1m: 0,
          totalMemoryBytes: 48 * 1024 ** 3,
        },
      ),
    ).toBe(3);
  });

  it("keeps serial untargeted runs on aggregate shards", () => {
    const previousParallel = process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    const previousSerial = process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
    delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    delete process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD;
    delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    process.env.OPENCLAW_TEST_PROJECTS_SERIAL = "1";
    try {
      expect(buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config)).toEqual([
        "test/vitest/vitest.full-core-unit-fast.config.ts",
        "test/vitest/vitest.full-core-unit-src.config.ts",
        "test/vitest/vitest.full-core-unit-security.config.ts",
        "test/vitest/vitest.full-core-unit-ui.config.ts",
        "test/vitest/vitest.full-core-unit-support.config.ts",
        "test/vitest/vitest.full-core-support-boundary.config.ts",
        "test/vitest/vitest.full-core-contracts.config.ts",
        "test/vitest/vitest.full-core-bundled.config.ts",
        "test/vitest/vitest.full-core-runtime.config.ts",
        "test/vitest/vitest.full-agentic.config.ts",
        "test/vitest/vitest.full-auto-reply.config.ts",
        "test/vitest/vitest.full-extensions.config.ts",
      ]);
    } finally {
      if (previousParallel === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_PARALLEL = previousParallel;
      }
      if (previousSerial === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_SERIAL = previousSerial;
      }
    }
  });

  it("expands untargeted local runs to leaf project configs by default", () => {
    const previousLeafShards = process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    const previousParallel = process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    const previousSerial = process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
    const previousCi = process.env.CI;
    const previousActions = process.env.GITHUB_ACTIONS;
    const previousVitestMaxWorkers = process.env.OPENCLAW_VITEST_MAX_WORKERS;
    const previousTestWorkers = process.env.OPENCLAW_TEST_WORKERS;
    delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    delete process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.OPENCLAW_VITEST_MAX_WORKERS;
    delete process.env.OPENCLAW_TEST_WORKERS;
    try {
      const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

      expect(configs).toContain("test/vitest/vitest.gateway-server.config.ts");
      expect(configs).toContain("test/vitest/vitest.extension-telegram.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.full-agentic.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.full-core-unit-fast.config.ts");
    } finally {
      if (previousLeafShards === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = previousLeafShards;
      }
      if (previousParallel === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_PARALLEL = previousParallel;
      }
      if (previousSerial === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_SERIAL = previousSerial;
      }
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
      if (previousActions === undefined) {
        delete process.env.GITHUB_ACTIONS;
      } else {
        process.env.GITHUB_ACTIONS = previousActions;
      }
      if (previousVitestMaxWorkers === undefined) {
        delete process.env.OPENCLAW_VITEST_MAX_WORKERS;
      } else {
        process.env.OPENCLAW_VITEST_MAX_WORKERS = previousVitestMaxWorkers;
      }
      if (previousTestWorkers === undefined) {
        delete process.env.OPENCLAW_TEST_WORKERS;
      } else {
        process.env.OPENCLAW_TEST_WORKERS = previousTestWorkers;
      }
    }
  });

  it("can skip the aggregate extension shard when CI runs dedicated extension shards", () => {
    const previous = process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD;
    const previousParallel = process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    const previousSerial = process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
    delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    process.env.OPENCLAW_TEST_PROJECTS_SERIAL = "1";
    process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD = "1";
    try {
      const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

      expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
      expect(configs).toContain("test/vitest/vitest.full-auto-reply.config.ts");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD;
      } else {
        process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD = previous;
      }
      if (previousParallel === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_PARALLEL = previousParallel;
      }
      if (previousSerial === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_SERIAL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_SERIAL = previousSerial;
      }
    }
  });

  it("can expand full-suite shards to project configs for perf experiments", () => {
    const previous = process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    const gatewayServerConfig = "test/vitest/vitest.gateway-server.config.ts";
    process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = "1";
    let plans: ReturnType<typeof buildFullSuiteVitestRunPlans>;
    try {
      plans = buildFullSuiteVitestRunPlans([], process.cwd());
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = previous;
      }
    }

    expect(plans.map((plan) => plan.config)).toEqual([
      "test/vitest/vitest.unit-fast.config.ts",
      "test/vitest/vitest.unit-src.config.ts",
      "test/vitest/vitest.unit-security.config.ts",
      "test/vitest/vitest.unit-ui.config.ts",
      "test/vitest/vitest.unit-support.config.ts",
      "test/vitest/vitest.boundary.config.ts",
      "test/vitest/vitest.tooling.config.ts",
      "test/vitest/vitest.contracts-channel-surface.config.ts",
      "test/vitest/vitest.contracts-channel-config.config.ts",
      "test/vitest/vitest.contracts-channel-registry.config.ts",
      "test/vitest/vitest.contracts-channel-session.config.ts",
      "test/vitest/vitest.contracts-plugin.config.ts",
      "test/vitest/vitest.bundled.config.ts",
      "test/vitest/vitest.infra.config.ts",
      "test/vitest/vitest.hooks.config.ts",
      "test/vitest/vitest.acp.config.ts",
      "test/vitest/vitest.runtime-config.config.ts",
      "test/vitest/vitest.secrets.config.ts",
      "test/vitest/vitest.logging.config.ts",
      "test/vitest/vitest.process.config.ts",
      "test/vitest/vitest.cron.config.ts",
      "test/vitest/vitest.media.config.ts",
      "test/vitest/vitest.media-understanding.config.ts",
      "test/vitest/vitest.shared-core.config.ts",
      "test/vitest/vitest.tasks.config.ts",
      "test/vitest/vitest.tui.config.ts",
      "test/vitest/vitest.ui.config.ts",
      "test/vitest/vitest.utils.config.ts",
      "test/vitest/vitest.wizard.config.ts",
      "test/vitest/vitest.gateway-core.config.ts",
      "test/vitest/vitest.gateway-client.config.ts",
      "test/vitest/vitest.gateway-methods.config.ts",
      gatewayServerConfig,
      gatewayServerConfig,
      gatewayServerConfig,
      gatewayServerConfig,
      "test/vitest/vitest.cli.config.ts",
      "test/vitest/vitest.commands-light.config.ts",
      "test/vitest/vitest.commands.config.ts",
      "test/vitest/vitest.agents-core.config.ts",
      "test/vitest/vitest.agents-pi-embedded.config.ts",
      "test/vitest/vitest.agents-support.config.ts",
      "test/vitest/vitest.agents-tools.config.ts",
      "test/vitest/vitest.daemon.config.ts",
      "test/vitest/vitest.plugin-sdk-light.config.ts",
      "test/vitest/vitest.plugin-sdk.config.ts",
      "test/vitest/vitest.plugins.config.ts",
      "test/vitest/vitest.channels.config.ts",
      "test/vitest/vitest.auto-reply-core.config.ts",
      "test/vitest/vitest.auto-reply-top-level.config.ts",
      "test/vitest/vitest.auto-reply-reply.config.ts",
      "test/vitest/vitest.extension-acpx.config.ts",
      "test/vitest/vitest.extension-diffs.config.ts",
      "test/vitest/vitest.extension-discord.config.ts",
      "test/vitest/vitest.extension-feishu.config.ts",
      "test/vitest/vitest.extension-imessage.config.ts",
      "test/vitest/vitest.extension-irc.config.ts",
      "test/vitest/vitest.extension-line.config.ts",
      "test/vitest/vitest.extension-mattermost.config.ts",
      "test/vitest/vitest.extension-matrix.config.ts",
      "test/vitest/vitest.extension-memory.config.ts",
      "test/vitest/vitest.extension-messaging.config.ts",
      "test/vitest/vitest.extension-msteams.config.ts",
      "test/vitest/vitest.extension-provider-openai.config.ts",
      "test/vitest/vitest.extension-providers.config.ts",
      "test/vitest/vitest.extension-signal.config.ts",
      "test/vitest/vitest.extension-slack.config.ts",
      "test/vitest/vitest.extension-telegram.config.ts",
      "test/vitest/vitest.extension-voice-call.config.ts",
      "test/vitest/vitest.extension-whatsapp.config.ts",
      "test/vitest/vitest.extension-zalo.config.ts",
      "test/vitest/vitest.extension-browser.config.ts",
      "test/vitest/vitest.extension-qa.config.ts",
      "test/vitest/vitest.extension-media.config.ts",
      "test/vitest/vitest.extensions.config.ts",
      "test/vitest/vitest.extension-misc.config.ts",
    ]);

    const gatewayPlans = plans.filter((plan) => plan.config === gatewayServerConfig);
    const gatewayTargets = gatewayPlans.flatMap((plan) => plan.forwardedArgs);
    const gatewayChunkSizes = gatewayPlans.map((plan) => plan.forwardedArgs.length);
    expect(gatewayPlans).toHaveLength(4);
    expect(gatewayTargets.length).toBeGreaterThan(90);
    expect(new Set(gatewayTargets).size).toBe(gatewayTargets.length);
    expect(gatewayTargets).toContain("src/gateway/server-network-runtime.e2e.test.ts");
    expect(gatewayTargets).not.toContain("src/gateway/gateway.test.ts");
    expect(Math.max(...gatewayChunkSizes) - Math.min(...gatewayChunkSizes)).toBeLessThanOrEqual(1);
    expect(plans.filter((plan) => plan.config !== gatewayServerConfig)).toEqual(
      plans
        .filter((plan) => plan.config !== gatewayServerConfig)
        .map((plan) => ({
          config: plan.config,
          forwardedArgs: [],
          includePatterns: null,
          watchMode: false,
        })),
    );
  });

  it("skips extension project configs when leaf sharding and the aggregate extension shard is disabled", () => {
    const previousLeafShards = process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    const previousSkipExtensions = process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD;
    process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = "1";
    process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD = "1";
    try {
      const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

      expect(configs).not.toContain("test/vitest/vitest.extensions.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.extension-providers.config.ts");
      expect(configs).toContain("test/vitest/vitest.auto-reply-reply.config.ts");
    } finally {
      if (previousLeafShards === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = previousLeafShards;
      }
      if (previousSkipExtensions === undefined) {
        delete process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD;
      } else {
        process.env.OPENCLAW_TEST_SKIP_FULL_EXTENSIONS_SHARD = previousSkipExtensions;
      }
    }
  });

  it("expands full-suite shards before running them in parallel", () => {
    const previousLeafShards = process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    const previousParallel = process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    process.env.OPENCLAW_TEST_PROJECTS_PARALLEL = "6";
    try {
      const configs = buildFullSuiteVitestRunPlans([], process.cwd()).map((plan) => plan.config);

      expect(configs).toContain("test/vitest/vitest.extension-telegram.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.full-extensions.config.ts");
    } finally {
      if (previousLeafShards === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = previousLeafShards;
      }
      if (previousParallel === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_PARALLEL = previousParallel;
      }
    }
  });

  it("keeps untargeted watch mode on the native root config", () => {
    expect(buildFullSuiteVitestRunPlans(["--watch"], process.cwd())).toEqual([
      {
        config: "vitest.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: true,
      },
    ]);
  });
});

describe("scripts/test-projects parallel cache paths", () => {
  it("assigns isolated Vitest fs-module cache paths per parallel shard", () => {
    const specs = applyParallelVitestCachePaths(
      [
        { config: "test/vitest/vitest.gateway.config.ts", env: {}, pnpmArgs: [] },
        { config: "test/vitest/vitest.extension-matrix.config.ts", env: {}, pnpmArgs: [] },
      ],
      { cwd: "/repo", env: {} },
    );

    expect(specs.map((spec) => spec.env)).toEqual([
      {
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(
          "/repo",
          "node_modules",
          ".experimental-vitest-cache",
          "0-test-vitest-vitest.gateway.config.ts",
        ),
      },
      {
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(
          "/repo",
          "node_modules",
          ".experimental-vitest-cache",
          "1-test-vitest-vitest.extension-matrix.config.ts",
        ),
      },
    ]);
  });

  it("keeps an explicit global cache path", () => {
    const [spec] = applyParallelVitestCachePaths(
      [{ config: "test/vitest/vitest.gateway.config.ts", env: {}, pnpmArgs: [] }],
      { cwd: "/repo", env: { OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/cache" } },
    );

    expect(spec?.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBeUndefined();
  });
});

describe("scripts/test-projects Vitest stall watchdog", () => {
  it("adds a default no-output timeout to non-watch specs", () => {
    const [spec] = applyDefaultVitestNoOutputTimeout(
      [
        {
          config: "test/vitest/vitest.extension-feishu.config.ts",
          env: { PATH: "/usr/bin" },
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
      ],
      { env: { PATH: "/usr/bin" } },
    );

    expect(spec?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe(
      DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS,
    );
  });

  it("keeps explicit watchdog settings and watch mode untouched", () => {
    const specs = applyDefaultVitestNoOutputTimeout(
      [
        {
          config: "test/vitest/vitest.extension-feishu.config.ts",
          env: { PATH: "/usr/bin" },
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: true,
        },
        {
          config: "test/vitest/vitest.extension-memory.config.ts",
          env: { OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS: "0", PATH: "/usr/bin" },
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
      ],
      { env: { PATH: "/usr/bin" } },
    );

    expect(specs[0]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBeUndefined();
    expect(specs[1]?.env.OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS).toBe("0");
  });

  it("allows changed checks to disable automatic silent-run retries", () => {
    expect(shouldRetryVitestNoOutputTimeout({})).toBe(true);
    expect(shouldRetryVitestNoOutputTimeout({ OPENCLAW_VITEST_NO_OUTPUT_RETRY: "1" })).toBe(true);
    expect(shouldRetryVitestNoOutputTimeout({ OPENCLAW_VITEST_NO_OUTPUT_RETRY: "0" })).toBe(false);
    expect(shouldRetryVitestNoOutputTimeout({ OPENCLAW_VITEST_NO_OUTPUT_RETRY: "false" })).toBe(
      false,
    );
  });
});

describe("scripts/test-projects Vitest cache isolation", () => {
  it("assigns isolated fs-module caches to multi-spec non-watch runs", () => {
    const specs = applyDefaultMultiSpecVitestCachePaths(
      [
        {
          config: "test/vitest/vitest.unit-fast.config.ts",
          env: {},
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
        {
          config: "test/vitest/vitest.extension-memory.config.ts",
          env: {},
          includeFilePath: null,
          includePatterns: null,
          pnpmArgs: [],
          watchMode: false,
        },
      ],
      { cwd: "/repo", env: {} },
    );

    expect(specs.map((spec) => spec.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH)).toEqual([
      path.join(
        "/repo",
        "node_modules",
        ".experimental-vitest-cache",
        "0-test-vitest-vitest.unit-fast.config.ts",
      ),
      path.join(
        "/repo",
        "node_modules",
        ".experimental-vitest-cache",
        "1-test-vitest-vitest.extension-memory.config.ts",
      ),
    ]);
  });

  it("keeps single-spec and watch runs on the default cache", () => {
    const single = [
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        env: {},
        includeFilePath: null,
        includePatterns: null,
        pnpmArgs: [],
        watchMode: false,
      },
    ];
    expect(applyDefaultMultiSpecVitestCachePaths(single, { cwd: "/repo", env: {} })).toBe(single);

    const watch = [
      {
        config: "vitest.config.ts",
        env: {},
        includeFilePath: null,
        includePatterns: null,
        pnpmArgs: [],
        watchMode: true,
      },
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        env: {},
        includeFilePath: null,
        includePatterns: null,
        pnpmArgs: [],
        watchMode: false,
      },
    ];
    expect(applyDefaultMultiSpecVitestCachePaths(watch, { cwd: "/repo", env: {} })).toBe(watch);
  });
});
