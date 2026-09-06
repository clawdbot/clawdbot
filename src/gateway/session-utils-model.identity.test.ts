import { afterEach, expect, test } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { getSessionDefaults, projectSessionPatchResult } from "./session-utils-model.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

afterEach(() => {
  resetConfigRuntimeState();
  resetPluginRuntimeStateForTest();
});

test.each([
  { provider: "demo-cli", model: "shared-model", expectedProvider: "demo-provider" },
  { provider: "standalone-cli", model: "shared-model", expectedProvider: "standalone-cli" },
  { provider: "demo-cli", model: "demo-provider/shared-model", expectedProvider: "demo-provider" },
  { provider: "demo-provider", model: "shared-model", expectedProvider: "demo-provider" },
])("keeps $provider/$model identity across session reads", async (fixture) => {
  await withStateDirEnv("session-model-identity-", async ({ stateDir }) => {
    const registry = createEmptyPluginRegistry();
    registry.cliBackends = [
      {
        pluginId: "fixture",
        source: "fixture",
        backend: {
          id: "demo-cli",
          modelProvider: "demo-provider",
          config: { command: "false", output: "text", input: "arg" },
        },
      },
      {
        pluginId: "fixture",
        source: "fixture",
        backend: {
          id: "standalone-cli",
          config: { command: "false", output: "text", input: "arg" },
        },
      },
    ];
    setActivePluginRegistry(registry);
    const selected = `${fixture.provider}/${fixture.model}`;
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: {
          model: "unrelated/shared-model",
          models: { [selected]: { agentRuntime: { id: "openclaw" } } },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:identity";
    const entry: SessionEntry = {
      sessionId: "identity",
      updatedAt: 1,
      providerOverride: fixture.provider,
      modelOverride: fixture.model,
      modelOverrideRouteResolution: "resolved",
    };
    const store = { [key]: entry };
    const expected = { modelProvider: fixture.expectedProvider, model: "shared-model" };
    for (const lightweightListRow of [false, true]) {
      const row = buildGatewaySessionRow({
        cfg,
        agentId: "main",
        storePath: stateDir,
        store,
        key,
        entry,
        lightweightListRow,
        skipTranscriptUsageFallback: true,
      });
      expect(row).toMatchObject(expected);
      expect(row.agentRuntime?.id).toBe("openclaw");
    }
    expect(
      projectSessionPatchResult({
        cfg,
        canonicalKey: key,
        entry,
        targetAgentId: "main",
        storePath: stateDir,
      }).resolved,
    ).toMatchObject({ ...expected, agentRuntime: { id: "openclaw" } });
    const listed = await listSessionFixture({
      cfg,
      storePath: stateDir,
      store,
      opts: { agentId: "main", search: `${fixture.expectedProvider}/shared-model` },
    });
    expect(listed.sessions).toMatchObject([{ key, ...expected }]);
    const defaultConfig: OpenClawConfig = {
      ...cfg,
      agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, model: selected } },
    };
    expect(getSessionDefaults(defaultConfig, [], { agentId: "main" })).toMatchObject(expected);
  });
});
