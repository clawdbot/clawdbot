// Plugin control-plane cold-import tests guard setup and plugin metadata paths against runtime-heavy imports.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  createColdPluginHermeticEnv,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "../plugins/test-helpers/fs-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildAuthChoiceGroups, formatAuthChoiceChoicesForCli } from "./auth-choice-options.js";
import { listManifestInstalledChannelIds } from "./channel-setup/discovery.js";

const tempDirs: string[] = [];

// Status also checks sandbox containers; keep that unrelated host probe hermetic.
vi.mock("../agents/sandbox/docker.js", () => ({
  execDockerRaw: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
}));

function makeTempDir() {
  return makeTrackedTempDir("openclaw-command-cold-imports", tempDirs);
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  cleanupTrackedTempDirs(tempDirs);
});

describe("command control-plane plugin discovery", () => {
  it.each([true, false])(
    "audits setup-backed channel warnings in status with enabled=%s",
    async (enabled) => {
      await withOpenClawTestState(
        {
          env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_BUNDLED_PLUGINS_DIR: undefined },
        },
        async (state) => {
          const finding = {
            checkId: "channels.cold-channel.setup_warning",
            severity: "warn",
            title: "Cold channel setup warning",
            detail: "The configured fixture channel requests a security warning.",
          };
          const plugin = createColdPluginFixture({
            rootDir: makeTempDir(),
            manifest: { setup: { requiresRuntime: false } },
            setupEntrySource: `module.exports = {
  plugin: {
    id: "cold-channel",
    meta: { id: "cold-channel", label: "Cold Channel" },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (cfg) => cfg.channels["cold-channel"],
      inspectAccount: (cfg) => ({ ...cfg.channels["cold-channel"], configured: true }),
    },
    security: {
      collectWarnings: ({ account }) => account.auditWarning ? [${JSON.stringify(finding)}] : [],
    },
  },
};`,
          });
          const config = {
            ...createColdPluginConfig(plugin.rootDir, plugin.pluginId),
            agents: { defaults: { workspace: state.workspaceDir } },
            channels: { [plugin.channelId]: { enabled, auditWarning: true } },
          };
          const { resolveStatusSecurityAudit } = await import("./status-runtime-shared.js");
          const report = await resolveStatusSecurityAudit({ config, sourceConfig: config });

          expect(report.findings.filter((entry) => entry.checkId === finding.checkId)).toEqual(
            enabled ? [finding] : [],
          );
          expect(isColdPluginRuntimeLoaded(plugin)).toBe(false);
        },
      );
    },
  );

  it("resolves channel setup metadata without importing plugin runtime", () => {
    const plugin = createColdPluginFixture({ rootDir: makeTempDir() });
    const workspaceDir = makeTempDir();
    const cfg = createColdPluginConfig(plugin.rootDir, plugin.pluginId);
    const env = createColdPluginHermeticEnv(workspaceDir);

    expect(
      listManifestInstalledChannelIds({
        cfg,
        workspaceDir,
        env,
      }),
    ).toContain(plugin.channelId);
    expect(isColdPluginRuntimeLoaded(plugin)).toBe(false);
  });

  it("builds onboarding auth choices from manifest metadata without importing plugin runtime", () => {
    const plugin = createColdPluginFixture({ rootDir: makeTempDir() });
    const workspaceDir = makeTempDir();
    const cfg = createColdPluginConfig(plugin.rootDir, plugin.pluginId);
    const env = createColdPluginHermeticEnv(workspaceDir);

    const authChoice = buildAuthChoiceGroups({
      includeSkip: false,
      config: cfg,
      workspaceDir,
      env,
    })
      .groups.flatMap((group) => group.options)
      .find((choice) => choice.value === plugin.authChoiceId);
    expect(authChoice?.label).toBe("Cold Provider API key");
    expect(authChoice?.groupId).toBe(plugin.providerId);
    expect(
      formatAuthChoiceChoicesForCli({
        config: cfg,
        workspaceDir,
        env,
      }).split("|"),
    ).toContain(plugin.authChoiceId);
    expect(isColdPluginRuntimeLoaded(plugin)).toBe(false);
  });
});
