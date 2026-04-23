import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEST_PROJECTS_VITEST_NO_OUTPUT_TIMEOUT_MS,
  applyDefaultMultiSpecVitestCachePaths,
  applyDefaultVitestNoOutputTimeout,
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
  buildVitestRunPlans,
  listFullExtensionVitestProjectConfigs,
  shouldAcquireLocalHeavyCheckLock,
  resolveChangedTestTargetPlan,
  resolveChangedTargetArgs,
  resolveParallelFullSuiteConcurrency,
  shouldRetryVitestNoOutputTimeout,
} from "../../scripts/test-projects.test-support.mjs";

describe("scripts/test-projects changed-target routing", () => {
  it("maps changed source files into scoped lane targets", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "src/shared/string-normalization.ts",
        "src/utils/provider-utils.ts",
      ]),
    ).toEqual(["src/shared/string-normalization.ts", "src/utils/provider-utils.ts"]);
  });

  it("keeps the broad changed run for Vitest wiring edits", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "test/vitest/vitest.shared.config.ts",
        "src/utils/provider-utils.ts",
      ]),
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

  it("keeps the broad changed run for shared test helpers", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "test/helpers/channels/plugin.ts",
      ]),
    ).toBeNull();
  });

  it("keeps the broad changed run for unknown root surfaces", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "unknown/file.txt",
      ]),
    ).toBeNull();
  });

  it("skips changed docs files that cannot map to test lanes", () => {
    expect(
      resolveChangedTargetArgs(["--changed", "origin/main"], process.cwd(), () => [
        "docs/help/testing.md",
      ]),
    ).toEqual([]);
  });

  it("skips root agent guidance changes instead of broad-running tests", () => {
    expect(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => ["AGENTS.md"]),
    ).toEqual([]);
  });

  it("skips app-only changes because app tests are separate from Vitest lanes", () => {
    expect(
      buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
        "apps/macos/OpenClaw/AppDelegate.swift",
      ]),
    ).toEqual([]);
  });

  it("adds extension tests for public plugin SDK changes", () => {
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
        includePatterns: ["extensions/lmstudio/src/**/*.test.ts"],
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

  it("narrows default-lane changed source files to include globs", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "packages/sdk/src/index.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.unit.config.ts",
        forwardedArgs: [],
        includePatterns: ["packages/sdk/src/**/*.test.ts"],
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
        "src/auto-reply/reply/dispatch-from-config.test.ts",
        "src/auto-reply/reply/effective-reply-route.test.ts",
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
        includePatterns: ["src/utils/**/*.test.ts"],
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

  it("keeps non-allowlisted plugin-sdk source files on the heavy lane plus extension tests", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/plugin-sdk/facade-runtime.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.plugin-sdk.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/**/*.test.ts"],
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

  it("keeps non-allowlisted commands source files on the heavy lane", () => {
    const plans = buildVitestRunPlans(["--changed", "origin/main"], process.cwd(), () => [
      "src/commands/channels.add.ts",
    ]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.commands.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/**/*.test.ts"],
        watchMode: false,
      },
    ]);
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
        process.env,
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
        process.env,
      ),
    ).toBe(true);
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
          ...process.env,
          OPENCLAW_TEST_PROJECTS_FORCE_LOCK: "1",
        },
      ),
    ).toBe(true);
  });
});

describe("scripts/test-projects full-suite sharding", () => {
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

  it("splits untargeted runs into fixed core shards and per-extension configs", () => {
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
        "test/vitest/vitest.extension-acpx.config.ts",
        "test/vitest/vitest.extension-bluebubbles.config.ts",
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
        "test/vitest/vitest.extension-misc.config.ts",
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
      "test/vitest/vitest.gateway-server.config.ts",
      "test/vitest/vitest.cli.config.ts",
      "test/vitest/vitest.commands-light.config.ts",
      "test/vitest/vitest.commands.config.ts",
      "test/vitest/vitest.agents.config.ts",
      "test/vitest/vitest.daemon.config.ts",
      "test/vitest/vitest.plugin-sdk-light.config.ts",
      "test/vitest/vitest.plugin-sdk.config.ts",
      "test/vitest/vitest.plugins.config.ts",
      "test/vitest/vitest.channels.config.ts",
      "test/vitest/vitest.auto-reply-core.config.ts",
      "test/vitest/vitest.auto-reply-top-level.config.ts",
      "test/vitest/vitest.auto-reply-reply.config.ts",
      "test/vitest/vitest.extension-acpx.config.ts",
      "test/vitest/vitest.extension-bluebubbles.config.ts",
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
      "test/vitest/vitest.extension-misc.config.ts",
    ]);
    expect(plans).toEqual(
      plans.map((plan) => ({
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
