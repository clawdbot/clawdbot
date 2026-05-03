import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
  buildVitestArgs,
  buildVitestRunPlans,
  createVitestRunSpecs,
  parseTestProjectsArgs,
  resolveChangedTargetArgs,
  resolveChangedTestTargetPlan,
  resolveParallelFullSuiteConcurrency,
} = (await import("../../scripts/test-projects.test-support.mjs")) as unknown as {
  applyParallelVitestCachePaths: (
    specs: Array<{
      config: string;
      env: NodeJS.ProcessEnv;
    }>,
    params?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ) => Array<{
    config: string;
    env: NodeJS.ProcessEnv;
  }>;
  buildFullSuiteVitestRunPlans: (
    args: string[],
    cwd?: string,
  ) => Array<{
    config: string;
    forwardedArgs: string[];
    includePatterns: string[] | null;
    watchMode: boolean;
  }>;
  buildVitestArgs: (args: string[], cwd?: string) => string[];
  buildVitestRunPlans: (
    args: string[],
    cwd?: string,
    listChangedPaths?: (baseRef: string, cwd: string) => string[],
  ) => Array<{
    config: string;
    forwardedArgs: string[];
    includePatterns: string[] | null;
    watchMode: boolean;
  }>;
  createVitestRunSpecs: (
    args: string[],
    params?: {
      baseEnv?: NodeJS.ProcessEnv;
      cwd?: string;
      tempDir?: string;
    },
  ) => Array<{
    config: string;
    env: NodeJS.ProcessEnv;
    includeFilePath: string | null;
    includePatterns: string[] | null;
    pnpmArgs: string[];
    watchMode: boolean;
  }>;
  parseTestProjectsArgs: (
    args: string[],
    cwd?: string,
  ) => {
    forwardedArgs: string[];
    targetArgs: string[];
    watchMode: boolean;
  };
  resolveChangedTargetArgs: (
    args: string[],
    cwd?: string,
    listChangedPaths?: (baseRef: string, cwd: string) => string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      broad?: boolean;
    },
  ) => string[] | null;
  resolveChangedTestTargetPlan: (
    changedPaths: string[],
  ) =>
    | { mode: "none"; targets: string[] }
    | { mode: "targets"; targets: string[] }
    | { mode: "broad"; targets: string[] };
  resolveParallelFullSuiteConcurrency: (
    specCount: number,
    env?: NodeJS.ProcessEnv,
    hostInfo?: {
      cpuCount?: number;
      loadAverage1m?: number;
      totalMemoryBytes?: number;
    },
  ) => number;
};

const VITEST_NODE_PREFIX = [
  "exec",
  "node",
  "--no-maglev",
  expect.stringMatching(/(?:^|[\\/])node_modules[\\/]vitest[\\/]vitest\.mjs$/),
];

describe("test-projects args", () => {
  it("drops a pnpm passthrough separator while preserving targeted filters", () => {
    expect(parseTestProjectsArgs(["--", "src/foo.test.ts", "-t", "target"])).toEqual({
      forwardedArgs: ["src/foo.test.ts", "-t", "target"],
      targetArgs: ["src/foo.test.ts"],
      watchMode: false,
    });
  });

  it("keeps watch mode explicit without leaking the sentinel to Vitest", () => {
    expect(buildVitestArgs(["--watch", "--", "src/foo.test.ts"])).toEqual([
      ...VITEST_NODE_PREFIX,
      "--config",
      "test/vitest/vitest.unit.config.ts",
      "src/foo.test.ts",
    ]);
  });

  it("uses run mode by default", () => {
    expect(buildVitestArgs(["src/foo.test.ts"])).toEqual([
      ...VITEST_NODE_PREFIX,
      "run",
      "--config",
      "test/vitest/vitest.unit.config.ts",
      "src/foo.test.ts",
    ]);
  });

  it("routes boundary targets to the boundary config", () => {
    expect(buildVitestRunPlans(["src/infra/openclaw-root.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.boundary.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/infra/openclaw-root.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes bundled-plugin-dependent unit targets to the bundled config", () => {
    expect(buildVitestRunPlans(["src/plugins/loader.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.bundled.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugins/loader.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes top-level repo tests to the contracts config", () => {
    expect(buildVitestRunPlans(["test/appcast.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/appcast.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes script tests to the tooling config", () => {
    expect(buildVitestRunPlans(["src/scripts/test-projects.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/scripts/test-projects.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes plugin contract tests to the plugin contracts config", () => {
    expect(
      buildVitestRunPlans(["src/plugins/contracts/memory-embedding-provider.contract.test.ts"]),
    ).toEqual([
      {
        config: "test/vitest/vitest.contracts-plugin.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugins/contracts/memory-embedding-provider.contract.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes config baseline integration tests to the contracts config", () => {
    expect(buildVitestRunPlans(["src/config/doc-baseline.integration.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/config/doc-baseline.integration.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes runtime config targets to the runtime-config config", () => {
    expect(buildVitestRunPlans(["src/config/sessions.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.runtime-config.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/config/sessions.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes cron targets to the cron config", () => {
    expect(buildVitestRunPlans(["src/cron/isolated-agent.lane.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.cron.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/cron/isolated-agent.lane.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes daemon targets to the daemon config", () => {
    expect(buildVitestRunPlans(["src/daemon/inspect.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.daemon.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/daemon/inspect.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes media targets to the media config", () => {
    expect(buildVitestRunPlans(["src/media/fetch.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.media.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/media/fetch.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes plugin-sdk targets to the plugin-sdk config", () => {
    expect(buildVitestRunPlans(["src/plugin-sdk/anthropic-vertex-auth-presence.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.plugin-sdk.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/anthropic-vertex-auth-presence.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes unit-fast light targets to the cache-friendly unit-fast config", () => {
    expect(buildVitestRunPlans(["src/plugin-sdk/provider-entry.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugin-sdk/provider-entry.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes process targets to the process config", () => {
    expect(buildVitestRunPlans(["src/process/exec.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.process.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/process/exec.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes secrets targets to the secrets config", () => {
    expect(buildVitestRunPlans(["src/secrets/resolve.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.secrets.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/secrets/resolve.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes unit-fast shared-core targets to the unit-fast config", () => {
    expect(buildVitestRunPlans(["src/shared/text-chunking.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/shared/text-chunking.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes tasks targets to the tasks config", () => {
    expect(buildVitestRunPlans(["src/tasks/task-registry.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.tasks.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/tasks/task-registry.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes logging targets to the logging config", () => {
    expect(buildVitestRunPlans(["src/logging/console-settings.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.logging.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/logging/console-settings.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes wizard targets to the wizard config", () => {
    expect(buildVitestRunPlans(["src/wizard/setup.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.wizard.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/wizard/setup.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes tui targets to the tui config", () => {
    expect(buildVitestRunPlans(["src/tui/tui.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.tui.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/tui/tui.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes media-understanding targets to the media-understanding config", () => {
    expect(buildVitestRunPlans(["src/media-understanding/runtime.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.media-understanding.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/media-understanding/runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes command targets to the commands config", () => {
    expect(buildVitestRunPlans(["src/commands/status.summary.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.commands.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/commands/status.summary.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes auto-reply targets to the auto-reply config", () => {
    expect(buildVitestRunPlans(["src/auto-reply/reply/get-reply.message-hooks.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.auto-reply.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/auto-reply/reply/get-reply.message-hooks.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes agents targets to the agents config", () => {
    expect(buildVitestRunPlans(["src/agents/tools/image-tool.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.agents.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/agents/tools/image-tool.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes gateway targets to the gateway config", () => {
    expect(buildVitestRunPlans(["src/gateway/call.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.gateway.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/gateway/call.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes hooks targets to the hooks config", () => {
    expect(buildVitestRunPlans(["src/hooks/install.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.hooks.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/hooks/install.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes channel targets to the channels config", () => {
    expect(buildVitestRunPlans(["src/channels/session.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.channels.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/channels/session.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes infra targets to the infra config", () => {
    expect(buildVitestRunPlans(["src/infra/openclaw-root.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.boundary.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/infra/openclaw-root.test.ts"],
        watchMode: false,
      },
    ]);

    expect(buildVitestRunPlans(["src/infra/migrations.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.infra.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/infra/migrations.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes unit-fast acp targets to the cache-friendly unit-fast config", () => {
    expect(buildVitestRunPlans(["src/acp/control-plane/runtime-cache.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.unit-fast.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/acp/control-plane/runtime-cache.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes reset-heavy acp targets to the acp config", () => {
    expect(buildVitestRunPlans(["src/acp/runtime/session-meta.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.acp.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/acp/runtime/session-meta.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("caps project-level parallelism when the Vitest worker budget is conservative", () => {
    expect(
      resolveParallelFullSuiteConcurrency(58, {
        OPENCLAW_VITEST_MAX_WORKERS: "1",
      }),
    ).toBe(1);

    expect(
      resolveParallelFullSuiteConcurrency(58, {
        OPENCLAW_TEST_WORKERS: "1",
      }),
    ).toBe(1);
  });

  it("keeps conservative core full-suite runs on aggregate shards", () => {
    const originalVitestMaxWorkers = process.env.OPENCLAW_VITEST_MAX_WORKERS;
    const originalTestWorkers = process.env.OPENCLAW_TEST_WORKERS;
    const originalProjectParallel = process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
    const originalLeafShards = process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
    try {
      process.env.OPENCLAW_VITEST_MAX_WORKERS = "1";
      delete process.env.OPENCLAW_TEST_WORKERS;
      delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
      delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;

      const configs = buildFullSuiteVitestRunPlans([]).map((plan) => plan.config);

      expect(configs).toContain("test/vitest/vitest.full-core-unit-fast.config.ts");
      expect(configs).toContain("test/vitest/vitest.full-core-support-boundary.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.boundary.config.ts");
      expect(configs).toContain("test/vitest/vitest.full-agentic.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.agents.config.ts");
      expect(configs).not.toContain("test/vitest/vitest.plugins.config.ts");
    } finally {
      if (originalVitestMaxWorkers === undefined) {
        delete process.env.OPENCLAW_VITEST_MAX_WORKERS;
      } else {
        process.env.OPENCLAW_VITEST_MAX_WORKERS = originalVitestMaxWorkers;
      }
      if (originalTestWorkers === undefined) {
        delete process.env.OPENCLAW_TEST_WORKERS;
      } else {
        process.env.OPENCLAW_TEST_WORKERS = originalTestWorkers;
      }
      if (originalProjectParallel === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_PARALLEL;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_PARALLEL = originalProjectParallel;
      }
      if (originalLeafShards === undefined) {
        delete process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS;
      } else {
        process.env.OPENCLAW_TEST_PROJECTS_LEAF_SHARDS = originalLeafShards;
      }
    }
  });

  it("keeps explicit project-level parallelism authoritative", () => {
    expect(
      resolveParallelFullSuiteConcurrency(58, {
        GITHUB_ACTIONS: "true",
        OPENCLAW_TEST_PROJECTS_PARALLEL: "3",
        OPENCLAW_VITEST_MAX_WORKERS: "1",
      }),
    ).toBe(3);
  });

  it("uses a bounded local default for full-suite project parallelism", () => {
    expect(
      resolveParallelFullSuiteConcurrency(
        58,
        {
          OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: "1",
        },
        {
          cpuCount: 8,
          loadAverage1m: 0,
          totalMemoryBytes: 16 * 1024 ** 3,
        },
      ),
    ).toBe(4);
  });

  it("gives parallel Vitest shards separate filesystem module caches", () => {
    const specs = applyParallelVitestCachePaths(
      [
        {
          config: "test/vitest/vitest.gateway.config.ts",
          env: { KEEP_ME: "1" },
        },
        {
          config: "test/vitest/vitest.gateway-server.config.ts",
          env: {},
        },
      ],
      {
        cwd: "/repo",
        env: {},
      },
    );

    expect(specs[0]?.env).toMatchObject({
      KEEP_ME: "1",
      OPENCLAW_VITEST_FS_MODULE_CACHE_PATH:
        "/repo/node_modules/.experimental-vitest-cache/0-test-vitest-vitest.gateway.config.ts",
    });
    expect(specs[1]?.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH).toBe(
      "/repo/node_modules/.experimental-vitest-cache/1-test-vitest-vitest.gateway-server.config.ts",
    );
  });

  it("preserves explicit Vitest filesystem module cache paths", () => {
    const specs = [
      {
        config: "test/vitest/vitest.gateway.config.ts",
        env: {},
      },
    ];

    expect(
      applyParallelVitestCachePaths(specs, {
        cwd: "/repo",
        env: {
          OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: "/tmp/cache",
        },
      }),
    ).toBe(specs);
  });

  it("routes cli targets to the cli config", () => {
    expect(buildVitestRunPlans(["src/cli/test-runtime-capture.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.cli.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/cli/test-runtime-capture.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes plugin targets to the plugins config", () => {
    expect(buildVitestRunPlans(["src/plugins/loader.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.bundled.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugins/loader.test.ts"],
        watchMode: false,
      },
    ]);

    expect(buildVitestRunPlans(["src/plugins/discovery.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.plugins.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/plugins/discovery.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("widens non-test helper file targets to sibling tests inside the routed suite", () => {
    expect(buildVitestRunPlans(["src/gateway/gateway-connection.test-mocks.ts"])).toEqual([
      {
        config: "test/vitest/vitest.gateway.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/gateway/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("widens extension helper targets to sibling extension tests", () => {
    expect(
      buildVitestRunPlans(["extensions/memory-core/src/memory/test-runtime-mocks.ts"]),
    ).toEqual([
      {
        config: "test/vitest/vitest.extension-memory.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/memory-core/src/memory/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes msteams extension tests to the msteams config", () => {
    expect(buildVitestRunPlans(["extensions/msteams/src/config.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-msteams.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/msteams/src/config.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes telegram extension tests to the telegram config", () => {
    expect(buildVitestRunPlans(["extensions/telegram/src/fetch.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-telegram.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/telegram/src/fetch.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes whatsapp extension tests to the whatsapp config", () => {
    expect(buildVitestRunPlans(["extensions/whatsapp/src/send.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-whatsapp.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/whatsapp/src/send.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes voice-call extension tests to the voice-call config", () => {
    expect(buildVitestRunPlans(["extensions/voice-call/src/runtime.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-voice-call.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/voice-call/src/runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes mattermost extension tests to the mattermost config", () => {
    expect(buildVitestRunPlans(["extensions/mattermost/src/channel.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-mattermost.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/mattermost/src/channel.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes zalo extension tests to the zalo config", () => {
    expect(buildVitestRunPlans(["extensions/zalo/src/channel.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-zalo.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/zalo/src/channel.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes matrix extension tests to the matrix config", () => {
    expect(buildVitestRunPlans(["extensions/matrix/src/channel.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-matrix.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/matrix/src/channel.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes bluebubbles extension tests to the bluebubbles config", () => {
    expect(buildVitestRunPlans(["extensions/bluebubbles/src/monitor.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-bluebubbles.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/bluebubbles/src/monitor.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes feishu extension tests to the feishu config", () => {
    expect(buildVitestRunPlans(["extensions/feishu/src/channel.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-feishu.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/feishu/src/channel.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes irc extension tests to the irc config", () => {
    expect(buildVitestRunPlans(["extensions/irc/src/channel.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-irc.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/irc/src/channel.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes acpx extension tests to the acpx config", () => {
    expect(buildVitestRunPlans(["extensions/acpx/src/runtime.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-acpx.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/acpx/src/runtime.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes diffs extension tests to the diffs config", () => {
    expect(buildVitestRunPlans(["extensions/diffs/src/render.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-diffs.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/diffs/src/render.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes unit ui targets to the unit ui config", () => {
    expect(buildVitestRunPlans(["ui/src/ui/views/channels.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.unit-ui.config.ts",
        forwardedArgs: [],
        includePatterns: ["ui/src/ui/views/channels.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes utils targets to the utils config", () => {
    expect(buildVitestRunPlans(["src/utils/path.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.utils.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/utils/path.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("widens top-level test helpers to sibling repo tests under contracts", () => {
    expect(buildVitestRunPlans(["test/helpers/temp-dir.ts"])).toEqual([
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/helpers/**/*.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes e2e targets straight to the e2e config", () => {
    expect(buildVitestRunPlans(["src/commands/models.set.e2e.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.e2e.config.ts",
        forwardedArgs: ["src/commands/models.set.e2e.test.ts"],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("routes direct Discord extension file targets to the Discord config", () => {
    expect(
      buildVitestRunPlans(["extensions/discord/src/monitor/message-handler.preflight.test.ts"]),
    ).toEqual([
      {
        config: "test/vitest/vitest.extension-discord.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/discord/src/monitor/message-handler.preflight.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes browser extension targets to the browser config", () => {
    expect(buildVitestRunPlans(["extensions/browser/index.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-browser.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/browser/index.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes line extension targets to the line config", () => {
    expect(buildVitestRunPlans(["extensions/line/src/send.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-line.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/line/src/send.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes matrix extension file targets to the matrix config", () => {
    expect(buildVitestRunPlans(["extensions/matrix/src/channel.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-matrix.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/matrix/src/channel.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes direct OpenAI provider extension file targets to the OpenAI provider config", () => {
    expect(buildVitestRunPlans(["extensions/openai/openai-codex-provider.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-provider-openai.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/openai/openai-codex-provider.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes misc extension file targets to the misc extensions config", () => {
    expect(buildVitestRunPlans(["extensions/firecrawl/index.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.extension-misc.config.ts",
        forwardedArgs: [],
        includePatterns: ["extensions/firecrawl/index.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("keeps docs-only changed runs empty instead of widening to the full suite", () => {
    const changedPaths = ["docs/help/testing.md", "AGENTS.md"];

    expect(resolveChangedTestTargetPlan(changedPaths)).toEqual({
      mode: "targets",
      targets: [],
    });
    expect(
      resolveChangedTargetArgs(["--changed=origin/main"], process.cwd(), () => changedPaths),
    ).toEqual([]);
    expect(
      buildVitestRunPlans(["--changed=origin/main"], process.cwd(), () => changedPaths),
    ).toEqual([]);
  });

  it("keeps core test-only changes on their owning test lane", () => {
    const changedPaths = ["src/auto-reply/reply/commands-approve.test.ts"];

    expect(
      buildVitestRunPlans(["--changed=origin/main"], process.cwd(), () => changedPaths),
    ).toEqual([
      {
        config: "test/vitest/vitest.auto-reply.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/auto-reply/reply/commands-approve.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes extension-facing core contract changes and supports broad extension opt-in", () => {
    const changedPaths = ["src/plugin-sdk/core.ts"];
    const plans = buildVitestRunPlans(["--changed=origin/main"], process.cwd(), () => changedPaths);
    const targetArgs = resolveChangedTargetArgs(
      ["--changed=origin/main"],
      process.cwd(),
      () => changedPaths,
    );

    expect(targetArgs).toEqual(["src/plugin-sdk/core.test.ts"]);
    expect(
      resolveChangedTargetArgs(["--changed=origin/main"], process.cwd(), () => changedPaths, {
        env: { OPENCLAW_TEST_CHANGED_BROAD: "1" },
      }),
    ).toEqual(["src/plugin-sdk/core.test.ts", "extensions"]);
    expect(plans[0]).toEqual({
      config: "test/vitest/vitest.plugin-sdk.config.ts",
      forwardedArgs: [],
      includePatterns: ["src/plugin-sdk/core.test.ts"],
      watchMode: false,
    });
    expect(plans).toHaveLength(1);
  });

  it("keeps extension production changes on the owning extension lane", () => {
    const changedPaths = ["extensions/discord/src/monitor/message-handler.ts"];

    expect(
      buildVitestRunPlans(["--changed=origin/main"], process.cwd(), () => changedPaths),
    ).toEqual([
      {
        config: "test/vitest/vitest.extension-discord.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "extensions/discord/src/api-barrel.test.ts",
          "extensions/discord/src/channel-actions.contract.test.ts",
          "extensions/discord/src/channel.test.ts",
          "extensions/discord/src/monitor/message-handler.bot-self-filter.test.ts",
          "extensions/discord/src/monitor/message-handler.queue.test.ts",
          "extensions/discord/src/monitor/provider.skill-dedupe.test.ts",
          "extensions/discord/src/monitor/provider.test.ts",
        ],
        watchMode: false,
      },
    ]);
  });

  it("splits mixed core and extension targets into separate vitest runs", () => {
    expect(
      buildVitestRunPlans([
        "src/config/config-misc.test.ts",
        "extensions/discord/src/monitor/message-handler.preflight.test.ts",
        "-t",
        "mention",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.runtime-config.config.ts",
        forwardedArgs: ["-t", "mention"],
        includePatterns: ["src/config/config-misc.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.extension-discord.config.ts",
        forwardedArgs: ["-t", "mention"],
        includePatterns: ["extensions/discord/src/monitor/message-handler.preflight.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("writes scoped include files for routed extension runs", () => {
    const [spec] = createVitestRunSpecs([
      "extensions/discord/src/monitor/message-handler.preflight.test.ts",
    ]);

    expect(spec?.pnpmArgs).toEqual([
      ...VITEST_NODE_PREFIX,
      "run",
      "--config",
      "test/vitest/vitest.extension-discord.config.ts",
    ]);
    expect(spec?.includePatterns).toEqual([
      "extensions/discord/src/monitor/message-handler.preflight.test.ts",
    ]);
    expect(spec?.includeFilePath).toContain("openclaw-vitest-include-");
    expect(spec?.env.OPENCLAW_VITEST_INCLUDE_FILE).toBe(spec?.includeFilePath);
  });

  it("skips channel contract configs with no matching external include patterns", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-contract-include-"));
    try {
      const includeFile = path.join(tempDir, "include.json");
      fs.writeFileSync(
        includeFile,
        JSON.stringify([
          "src/channels/plugins/contracts/surfaces-only.registry-backed-shard-b.contract.test.ts",
        ]),
        "utf8",
      );

      const specs = createVitestRunSpecs(
        [
          "test/vitest/vitest.contracts-channel-surface.config.ts",
          "test/vitest/vitest.contracts-channel-config.config.ts",
          "test/vitest/vitest.contracts-channel-registry.config.ts",
          "test/vitest/vitest.contracts-channel-session.config.ts",
        ],
        {
          baseEnv: {
            OPENCLAW_VITEST_INCLUDE_FILE: includeFile,
          } as NodeJS.ProcessEnv,
        },
      );

      expect(specs.map((spec) => spec.config)).toEqual([
        "test/vitest/vitest.contracts-channel-config.config.ts",
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects watch mode when a command spans multiple suites", () => {
    expect(() =>
      buildVitestRunPlans([
        "--watch",
        "src/config/config-misc.test.ts",
        "extensions/discord/src/monitor/message-handler.preflight.test.ts",
      ]),
    ).toThrow("watch mode with mixed test suites is not supported");
  });
});
