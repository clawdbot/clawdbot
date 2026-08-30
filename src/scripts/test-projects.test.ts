// Test project script tests cover fixture project discovery and validation.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveVitestCliEntry, resolveVitestNodeArgs } from "../../scripts/run-vitest.mts";
import { withEnv } from "../test-utils/env.js";

const {
  applyParallelVitestCachePaths,
  buildFullSuiteVitestRunPlans,
  buildVitestRunPlans,
  createVitestRunSpecs,
  findUnmatchedExplicitTestTargets,
  parseTestProjectsArgs,
  resolveChangedTargetArgs,
  resolveChangedTestTargetPlan,
  resolveParallelFullSuiteConcurrency,
} = await import("../../scripts/test-projects.test-support.mts");

const VITEST_NODE_PREFIX = [
  "exec",
  "node",
  ...resolveVitestNodeArgs(process.env),
  resolveVitestCliEntry(),
];

describe("test-projects args", () => {
  beforeAll(() => {
    for (const target of [
      "src/gateway/gateway-connection.test-mocks.ts",
      "extensions/memory-core/src/memory/test-runtime-mocks.ts",
      "test/helpers/temp-dir.ts",
      "src/commands/onboard-non-interactive.test-helpers.ts",
    ]) {
      buildVitestRunPlans([target]);
    }
  });

  it("drops a pnpm passthrough separator while preserving targeted filters", () => {
    expect(parseTestProjectsArgs(["--", "src/foo.test.ts", "-t", "target"])).toEqual({
      forwardedArgs: ["src/foo.test.ts", "-t", "target"],
      targetArgs: ["src/foo.test.ts"],
      watchMode: false,
    });
  });

  it("keeps watch mode explicit without leaking the sentinel to Vitest", () => {
    const spec = expectDefined(
      createVitestRunSpecs(["--watch", "--", "src/foo.test.ts"])[0],
      "watch run spec",
    );
    expect(spec.pnpmArgs).toEqual([
      ...VITEST_NODE_PREFIX,
      "--config",
      "test/vitest/vitest.unit.config.ts",
      "src/foo.test.ts",
    ]);
  });

  it("uses run mode by default", () => {
    const spec = expectDefined(createVitestRunSpecs(["src/foo.test.ts"])[0], "run spec");
    expect(spec.pnpmArgs).toEqual([
      ...VITEST_NODE_PREFIX,
      "run",
      "--config",
      "test/vitest/vitest.unit.config.ts",
      "src/foo.test.ts",
    ]);
  });

  it.each([
    {
      title: "routes boundary targets to the boundary config",
      target: "src/infra/openclaw-root.test.ts",
      config: "test/vitest/vitest.boundary.config.ts",
    },
    {
      title: "routes bundled-plugin-dependent unit targets to the bundled config",
      target: "src/plugins/loader.test.ts",
      config: "test/vitest/vitest.bundled.config.ts",
    },
    {
      title: "routes top-level repo tests to the contracts config",
      target: "test/appcast.test.ts",
      config: "test/vitest/vitest.tooling.config.ts",
    },
    {
      title: "routes script tests to the tooling config",
      target: "src/scripts/test-projects.test.ts",
      config: "test/vitest/vitest.tooling.config.ts",
    },
    {
      title: "routes config baseline integration tests to the contracts config",
      target: "src/config/doc-baseline.integration.test.ts",
      config: "test/vitest/vitest.tooling.config.ts",
    },
    {
      title: "routes runtime config targets to the runtime-config config",
      target: "src/config/sessions.test.ts",
      config: "test/vitest/vitest.runtime-config.config.ts",
    },
    {
      title: "routes cron targets to the cron config",
      target: "src/cron/isolated-agent.lane.test.ts",
      config: "test/vitest/vitest.cron.config.ts",
    },
    {
      title: "routes daemon targets to the daemon config",
      target: "src/daemon/inspect.test.ts",
      config: "test/vitest/vitest.daemon.config.ts",
    },
    {
      title: "routes media targets to the media config",
      target: "src/media/fetch.test.ts",
      config: "test/vitest/vitest.media.config.ts",
    },
    {
      title: "routes plugin-sdk targets to the plugin-sdk config",
      target: "src/plugin-sdk/migration-runtime.test.ts",
      config: "test/vitest/vitest.plugin-sdk.config.ts",
    },
    {
      title: "routes unit-fast light targets to the cache-friendly unit-fast config",
      target: "src/plugin-sdk/provider-entry.test.ts",
      config: "test/vitest/vitest.unit-fast.config.ts",
    },
    {
      title: "routes fake-timer unit-fast targets to the serial fake-timer config",
      target: "src/acp/control-plane/manager.test.ts",
      config: "test/vitest/vitest.unit-fast-fake-timers.config.ts",
    },
    {
      title: "routes process targets to the process config",
      target: "src/process/exec.test.ts",
      config: "test/vitest/vitest.process.config.ts",
    },
    {
      title: "routes secrets targets to the secrets config",
      target: "src/secrets/resolve.test.ts",
      config: "test/vitest/vitest.secrets.config.ts",
    },
    {
      title: "routes unit-fast shared-core targets to the unit-fast config",
      target: "src/shared/text-chunking.test.ts",
      config: "test/vitest/vitest.unit-fast.config.ts",
    },
    {
      title: "routes tasks targets to the tasks config",
      target: "src/tasks/task-registry.test.ts",
      config: "test/vitest/vitest.tasks.config.ts",
    },
    {
      title: "routes logging targets to the logging config",
      target: "src/logging/console-settings.test.ts",
      config: "test/vitest/vitest.logging.config.ts",
    },
    {
      title: "routes wizard targets to the wizard config",
      target: "src/wizard/setup.test.ts",
      config: "test/vitest/vitest.wizard.config.ts",
    },
    {
      title: "routes tui targets to the tui config",
      target: "src/tui/tui.test.ts",
      config: "test/vitest/vitest.tui.config.ts",
    },
    {
      title: "routes media-understanding targets to the media-understanding config",
      target: "src/media-understanding/runtime.test.ts",
      config: "test/vitest/vitest.media-understanding.config.ts",
    },
    {
      title: "routes command targets to the commands config",
      target: "src/commands/status.summary.test.ts",
      config: "test/vitest/vitest.commands.config.ts",
    },
    {
      title: "routes auto-reply targets to the auto-reply config",
      target: "src/auto-reply/reply/get-reply.message-hooks.test.ts",
      config: "test/vitest/vitest.auto-reply.config.ts",
    },
    {
      title: "routes agent tool targets to the agents-tools config",
      target: "src/agents/tools/image-tool.test.ts",
      config: "test/vitest/vitest.agents-tools.config.ts",
    },
    {
      title: "routes gateway targets to the gateway config",
      target: "src/gateway/call.test.ts",
      config: "test/vitest/vitest.gateway.config.ts",
    },
    {
      title: "routes hooks targets to the hooks config",
      target: "src/hooks/install.test.ts",
      config: "test/vitest/vitest.hooks.config.ts",
    },
    {
      title: "routes channel targets to the channels config",
      target: "src/channels/session.test.ts",
      config: "test/vitest/vitest.channels.config.ts",
    },
    {
      title: "routes unit-fast acp targets to the cache-friendly unit-fast config",
      target: "src/acp/runtime/registry.test.ts",
      config: "test/vitest/vitest.unit-fast.config.ts",
    },
    {
      title: "routes reset-heavy acp targets to the acp config",
      target: "src/acp/runtime/session-meta.test.ts",
      config: "test/vitest/vitest.acp.config.ts",
    },
    {
      title: "routes cli targets to the cli config",
      target: "src/cli/test-runtime-capture.test.ts",
      config: "test/vitest/vitest.cli.config.ts",
    },
    {
      title: "routes msteams extension tests to the msteams config",
      target: "extensions/msteams/src/config.test.ts",
      config: "test/vitest/vitest.extension-msteams.config.ts",
    },
    {
      title: "routes telegram extension tests to the telegram config",
      target: "extensions/telegram/src/fetch.test.ts",
      config: "test/vitest/vitest.extension-telegram.config.ts",
    },
    {
      title: "routes whatsapp extension tests to the whatsapp config",
      target: "extensions/whatsapp/src/send.test.ts",
      config: "test/vitest/vitest.extension-whatsapp.config.ts",
    },
    {
      title: "routes voice-call extension tests to the voice-call config",
      target: "extensions/voice-call/src/runtime.test.ts",
      config: "test/vitest/vitest.extension-voice-call.config.ts",
    },
    {
      title: "routes mattermost extension tests to the mattermost config",
      target: "extensions/mattermost/src/channel.test.ts",
      config: "test/vitest/vitest.extension-mattermost.config.ts",
    },
    {
      title: "routes zalo extension tests to the zalo config",
      target: "extensions/zalo/src/channel.test.ts",
      config: "test/vitest/vitest.extension-zalo.config.ts",
    },
    {
      title: "routes matrix extension tests to the matrix config",
      target: "extensions/matrix/src/channel.test.ts",
      config: "test/vitest/vitest.extension-matrix.config.ts",
    },
    {
      title: "routes feishu extension tests to the feishu config",
      target: "extensions/feishu/src/channel.test.ts",
      config: "test/vitest/vitest.extension-feishu.config.ts",
    },
    {
      title: "routes irc extension tests to the irc config",
      target: "extensions/irc/src/channel.test.ts",
      config: "test/vitest/vitest.extension-irc.config.ts",
    },
    {
      title: "routes acpx extension tests to the acpx config",
      target: "extensions/acpx/src/runtime.test.ts",
      config: "test/vitest/vitest.extension-acpx.config.ts",
    },
    {
      title: "routes diffs extension tests to the diffs config",
      target: "extensions/diffs/src/render.test.ts",
      config: "test/vitest/vitest.extension-diffs.config.ts",
    },
    {
      title: "routes unit ui targets to the unit ui config",
      target: "ui/src/ui/views/channels.test.ts",
      config: "test/vitest/vitest.ui.config.ts",
    },
    {
      title: "routes utils targets to the utils config",
      target: "src/utils/path.test.ts",
      config: "test/vitest/vitest.utils.config.ts",
    },
    {
      title: "routes browser extension targets to the browser config",
      target: "extensions/browser/index.test.ts",
      config: "test/vitest/vitest.extension-browser.config.ts",
    },
    {
      title: "routes line extension targets to the line config",
      target: "extensions/line/src/send.test.ts",
      config: "test/vitest/vitest.extension-line.config.ts",
    },
    {
      title: "routes matrix extension file targets to the matrix config",
      target: "extensions/matrix/src/channel.test.ts",
      config: "test/vitest/vitest.extension-matrix.config.ts",
    },
    {
      title: "routes direct OpenAI provider extension file targets to the OpenAI provider config",
      target: "extensions/openai/openai-chatgpt-provider.test.ts",
      config: "test/vitest/vitest.extension-provider-openai.config.ts",
    },
    {
      title: "routes misc extension file targets to the misc extensions config",
      target: "extensions/firecrawl/index.test.ts",
      config: "test/vitest/vitest.extension-misc.config.ts",
    },
  ])("$title", ({ target, config }) => {
    expect(buildVitestRunPlans([target])).toEqual([
      {
        config,
        forwardedArgs: [],
        includePatterns: [target],
        watchMode: false,
      },
    ]);
  });

  it("keeps split test entries in their owner configs", () => {
    expect(buildVitestRunPlans(["src/agents/openai-transport-stream.base.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.agents-core.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/agents/openai-transport-stream.base.test.ts"],
        watchMode: false,
      },
    ]);
    expect(buildVitestRunPlans(["src/auto-reply/reply/dispatch-from-config.test.ts"])).toEqual([
      {
        config: "test/vitest/vitest.auto-reply.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/auto-reply/reply/dispatch-from-config.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("expands a test filename prefix into standalone sibling suites", () => {
    expect(buildVitestRunPlans(["src/agents/openai-transport-stream"])).toEqual([
      {
        config: "test/vitest/vitest.agents-core.config.ts",
        forwardedArgs: [],
        includePatterns: [
          "src/agents/openai-transport-stream.base.test.ts",
          "src/agents/openai-transport-stream.deepseek-and-shaping.test.ts",
          "src/agents/openai-transport-stream.failed-sse.test.ts",
          "src/agents/openai-transport-stream.incomplete-output.test.ts",
          "src/agents/openai-transport-stream.incomplete-sse.test.ts",
          "src/agents/openai-transport-stream.reasoning-and-cache.test.ts",
          "src/agents/openai-transport-stream.replay-and-tools.test.ts",
          "src/agents/openai-transport-stream.usage-and-calls.test.ts",
        ],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.agents-core-isolated.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/agents/openai-transport-stream.streaming.test.ts"],
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

  it("keeps conservative local full-suite runs on leaf project configs", () => {
    withEnv(
      {
        OPENCLAW_VITEST_MAX_WORKERS: "1",
        OPENCLAW_TEST_WORKERS: undefined,
        OPENCLAW_TEST_PROJECTS_PARALLEL: undefined,
        OPENCLAW_TEST_PROJECTS_LEAF_SHARDS: undefined,
        CI: undefined,
        GITHUB_ACTIONS: undefined,
      },
      () => {
        const configs = buildFullSuiteVitestRunPlans([]).map((plan) => plan.config);

        expect(configs).toContain("test/vitest/vitest.unit-fast.config.ts");
        expect(configs).toContain("test/vitest/vitest.boundary.config.ts");
        expect(configs).toContain("test/vitest/vitest.agents-core.config.ts");
        expect(configs).toContain("test/vitest/vitest.plugins.config.ts");
        expect(configs).not.toContain("test/vitest/vitest.full-core-unit-fast.config.ts");
        expect(configs).not.toContain("test/vitest/vitest.full-agentic.config.ts");
      },
    );
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

  it("uses the global host worker budget for full-suite project parallelism", () => {
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
    ).toBe(2);
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

    const firstEnv = specs[0]?.env;
    expect(firstEnv?.KEEP_ME).toBe("1");
    expect(firstEnv?.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH?.replaceAll("\\", "/")).toBe(
      "/repo/.cache/vitest/0-test-vitest-vitest.gateway.config.ts",
    );
    expect(specs[1]?.env.OPENCLAW_VITEST_FS_MODULE_CACHE_PATH?.replaceAll("\\", "/")).toBe(
      "/repo/.cache/vitest/1-test-vitest-vitest.gateway-server.config.ts",
    );
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

  it("routes non-test helper file targets to importing tests inside the routed suites", () => {
    expect(buildVitestRunPlans(["src/gateway/gateway-connection.test-mocks.ts"])).toEqual([
      {
        config: "test/vitest/vitest.gateway.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/gateway/call.test.ts"],
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.tui.config.ts",
        forwardedArgs: [],
        includePatterns: ["src/tui/gateway-chat.connection.test.ts"],
        watchMode: false,
      },
    ]);
  });

  it("routes direct and transitive extension helper importers to the owning config", () => {
    const helper = "extensions/memory-core/src/memory/test-runtime-mocks.ts";
    const plans = buildVitestRunPlans([helper]);

    expect(plans).toEqual([
      {
        config: "test/vitest/vitest.extension-memory.config.ts",
        forwardedArgs: [],
        includePatterns: expect.arrayContaining([
          "extensions/memory-core/src/memory/manager.fts-only-reindex.test.ts",
          "extensions/memory-core/src/memory/manager-session-update-race.test.ts",
        ]),
        watchMode: false,
      },
    ]);
    expect(plans[0]?.includePatterns).not.toContain(helper);
  });

  it("routes top-level test helpers to importing repo tests", () => {
    // The importer inventory of test/helpers/temp-dir.ts churns with every new
    // test using the helper; frozen full lists broke main on unrelated test
    // additions. Assert the routing structure instead of the inventory.
    const plans = buildVitestRunPlans(["test/helpers/temp-dir.ts"]);
    const planFiles = plans.map((plan) => plan.includePatterns ?? plan.forwardedArgs);
    const expandedFiles = planFiles.flat();

    // Helper targets expand to importing test files; the helper itself never
    // reaches Vitest as a raw target.
    expect(expandedFiles).toContain("test/helpers/temp-dir.test.ts");
    expect(expandedFiles).not.toContain("test/helpers/temp-dir.ts");
    expect(expandedFiles.filter((file) => !file.endsWith(".test.ts"))).toEqual([]);

    // Lower bound derived from the repo itself: every tracked test file that
    // directly imports the helper must be picked up by the expansion scan, so
    // dropped importers still fail without freezing the full inventory.
    const scanRoots = ["src", "test", "ui", "extensions", "packages"];
    const grep = spawnSync(
      "git",
      ["grep", "-l", "--fixed-strings", "helpers/temp-dir", "--", ...scanRoots],
      { encoding: "utf8" },
    );
    expect(grep.status).toBe(0);
    const directImporterTests = grep.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((file) => file.endsWith(".test.ts") && !file.endsWith(".live.test.ts"))
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return [...source.matchAll(/from\s+["'](\.[^"']+)["']/gu)].some((match) => {
          const importerDir = path.posix.dirname(file);
          const resolved = path.posix.normalize(
            path.posix.join(importerDir, expectDefined(match[1], "match[1] test invariant")),
          );
          return resolved.replace(/\.(?:js|ts)$/u, "") === "test/helpers/temp-dir";
        });
      });
    expect(directImporterTests.length).toBeGreaterThan(0);
    expect(directImporterTests.filter((file) => !expandedFiles.includes(file))).toEqual([]);

    // Importers partition across configs: each file lands in exactly one plan,
    // in deterministic sorted order.
    expect(plans.length).toBeGreaterThan(1);
    expect(new Set(expandedFiles).size).toBe(expandedFiles.length);
    for (const files of planFiles) {
      expect(files).toEqual([...files].toSorted((left, right) => left.localeCompare(right)));
    }

    // Each importer must route to the same config and include-vs-forwarded
    // shape as targeting it directly, so this test fails on real routing
    // regressions but not on new importers of the helper.
    for (const plan of plans) {
      expect(plan.watchMode).toBe(false);
      for (const file of plan.includePatterns ?? plan.forwardedArgs) {
        expect(buildVitestRunPlans([file])).toEqual([
          {
            config: plan.config,
            forwardedArgs: plan.includePatterns ? [] : [file],
            includePatterns: plan.includePatterns ? [file] : null,
            watchMode: false,
          },
        ]);
      }
    }
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

  it("routes the Docker package contract without private-QA E2E setup", () => {
    const target = "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts";

    expect(buildVitestRunPlans([target])).toEqual([
      {
        config: "test/vitest/vitest.package-docker.config.ts",
        forwardedArgs: [target],
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

  it("keeps docs-only changed runs empty instead of widening to the full suite", () => {
    const changedPaths = ["docs/help/testing.md", "AGENTS.md"];

    expect(resolveChangedTestTargetPlan(changedPaths)).toEqual({
      mode: "targets",
      targets: [],
    });
    expect(
      resolveChangedTargetArgs(["--changed=origin/main"], process.cwd(), () => changedPaths),
    ).toStrictEqual([]);
    expect(
      buildVitestRunPlans(["--changed=origin/main"], process.cwd(), () => changedPaths),
    ).toStrictEqual([]);
  });

  it("routes bundled plugin manifest changes through the docs config audit", () => {
    expect(resolveChangedTestTargetPlan(["extensions/voice-call/openclaw.plugin.json"])).toEqual({
      mode: "targets",
      targets: [
        "extensions/voice-call/openclaw.plugin.json",
        "src/config/docs-config-examples.test.ts",
      ],
    });
  });

  it("routes auth setup script changes to the focused auth monitor test", () => {
    const changedPaths = ["scripts/setup-auth-system.sh"];

    expect(resolveChangedTestTargetPlan(changedPaths)).toEqual({
      mode: "targets",
      targets: ["test/scripts/auth-monitor.test.ts"],
    });
    expect(
      buildVitestRunPlans(["--changed=origin/main"], process.cwd(), () => changedPaths),
    ).toEqual([
      {
        config: "test/vitest/vitest.tooling.config.ts",
        forwardedArgs: [],
        includePatterns: ["test/scripts/auth-monitor.test.ts"],
        watchMode: false,
      },
    ]);
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
          "extensions/discord/src/channel-actions.contract.test.ts",
          "extensions/discord/src/channel.message-adapter.test.ts",
          "extensions/discord/src/channel.test.ts",
          "extensions/discord/src/durable-delivery.test.ts",
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

  it("rejects explicit test file targets that do not exist", () => {
    expect(findUnmatchedExplicitTestTargets(["src/not-a-real-openclaw-test.test.ts"])).toEqual([
      {
        target: "src/not-a-real-openclaw-test.test.ts",
        reason: "path-does-not-exist",
      },
    ]);
  });

  it("rejects explicit globs that match no files", () => {
    expect(findUnmatchedExplicitTestTargets(["src/**/not-a-real-openclaw-test.test.ts"])).toEqual([
      {
        target: "src/**/not-a-real-openclaw-test.test.ts",
        reason: "glob-matched-no-files",
      },
    ]);
  });

  it("rejects explicit non-test file targets with no sibling tests", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-targets-"));
    try {
      fs.mkdirSync(path.join(tempDir, "src", "lonely"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src", "lonely", "runtime.ts"), "export {};\n");

      expect(findUnmatchedExplicitTestTargets(["src/lonely/runtime.ts"], tempDir)).toEqual([
        {
          target: "src/lonely/runtime.ts",
          reason: "target-matched-no-test-files",
          includePattern: "src/lonely/**/*.test.ts",
        },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts explicit untracked test files that exist on disk", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-targets-"));
    try {
      fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "src", "new.test.ts"), "test('new', () => {});\n");

      expect(findUnmatchedExplicitTestTargets(["src/new.test.ts"], tempDir)).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts explicit Vitest config targets routed as whole config runs", () => {
    expect(
      findUnmatchedExplicitTestTargets(["test/vitest/vitest.contracts-channel-surface.config.ts"]),
    ).toEqual([]);
  });

  it("accepts split CI Vitest config targets routed as whole config runs", () => {
    expect(
      findUnmatchedExplicitTestTargets([
        "test/vitest/vitest.agents-core.config.ts",
        "test/vitest/vitest.agents-embedded-agent.config.ts",
        "test/vitest/vitest.agents-support.config.ts",
        "test/vitest/vitest.agents-tools.config.ts",
      ]),
    ).toEqual([]);
  });

  it("keeps split CI Vitest config targets on their own configs", () => {
    expect(
      buildVitestRunPlans([
        "test/vitest/vitest.agents-core.config.ts",
        "test/vitest/vitest.agents-tools.config.ts",
      ]),
    ).toEqual([
      {
        config: "test/vitest/vitest.agents-core.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
      {
        config: "test/vitest/vitest.agents-tools.config.ts",
        forwardedArgs: [],
        includePatterns: null,
        watchMode: false,
      },
    ]);
  });

  it("accepts sentinel targets routed as whole config runs", () => {
    expect(findUnmatchedExplicitTestTargets(["ui/src/test-helpers/control-ui-e2e.ts"])).toEqual([]);
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
