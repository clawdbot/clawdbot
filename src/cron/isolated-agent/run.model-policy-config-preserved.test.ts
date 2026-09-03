// Cron policy tests cover per-agent defaults flattening before model resolution.
import { describe, expect, it } from "vitest";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveAllowedModelRefCore } from "../../agents/model-selection-resolve.js";
import type { ResolvedPublishedModelCatalogOwner } from "../../agents/prepared-model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { resolveCronModelSelection } from "./model-selection.js";
import { resolveCronAgentConfig } from "./run-config.js";

function buildCronConfig(cfg: OpenClawConfig, agentId: string): OpenClawConfig {
  return resolveCronAgentConfig({
    config: cfg,
    agentConfigOverride: resolveAgentConfig(cfg, agentId),
  }).cfgWithAgentDefaults;
}

function resolveCronPayloadModel(cfg: OpenClawConfig, raw: string) {
  return resolveAllowedModelRefCore({
    cfg,
    catalog: [
      { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    ],
    raw,
    defaultProvider: "openai",
    defaultModel: "baseline",
    manifestPlugins: [],
  });
}

describe("resolveCronAgentConfig model policy preservation", () => {
  it("keeps the inherited default restriction when the per-agent policy is empty", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        list: [{ id: "worker", modelPolicy: {} }],
      },
    };

    const cronCfg = buildCronConfig(cfg, "worker");

    expect(cronCfg.agents?.defaults?.modelPolicy).toEqual({ allow: ["openai/gpt-5.5"] });
    expect(resolveCronPayloadModel(cronCfg, "openai/gpt-5.6-sol")).toEqual({
      error: "model not allowed: openai/gpt-5.6-sol",
    });
  });

  it("applies an explicit per-agent allowlist to cron model resolution", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        list: [{ id: "worker", modelPolicy: { allow: ["openai/gpt-5.6-sol"] } }],
      },
    };

    const cronCfg = buildCronConfig(cfg, "worker");

    expect(cronCfg.agents?.defaults?.modelPolicy).toEqual({ allow: ["openai/gpt-5.6-sol"] });
    expect(resolveCronPayloadModel(cronCfg, "openai/gpt-5.5")).toEqual({
      error: "model not allowed: openai/gpt-5.5",
    });
    expect(resolveCronPayloadModel(cronCfg, "openai/gpt-5.6-sol")).toMatchObject({
      ref: { provider: "openai", model: "gpt-5.6-sol" },
    });
  });

  it.each(["default", "subagent", "agent", "payload", "session", "hook"] as const)(
    "keeps the selected owner's metadata for the %s model",
    async (source) => {
      const snapshot = (workspaceDir: string, model: string) => ({
        ...createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "cron-model-policy",
              modelIdNormalization: {
                providers: {
                  custom: { aliases: { legacy: model } },
                  [DEFAULT_PROVIDER]: { aliases: { legacy: model } },
                },
              },
            },
          ],
        }),
        workspaceDir,
      });
      const metadataSnapshot = snapshot("/tmp/cron-owner", "selected");
      const otherWorkspace = snapshot("/tmp/other-owner", "other");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: source === "default" ? "custom/legacy" : "custom/baseline" },
            modelPolicy: { allow: ["custom/legacy", `${DEFAULT_PROVIDER}/legacy`] },
            ...(source === "subagent" ? { subagents: { model: "custom/legacy" } } : {}),
          },
          entries: {
            worker: {
              agentDir: "/tmp/cron-agent",
              workspace: metadataSnapshot.workspaceDir,
              ...(source === "agent" ? { model: "custom/legacy" } : {}),
            },
          },
        },
        ...(source === "hook" ? { hooks: { gmail: { model: "legacy" } } } : {}),
      };
      const owner: ResolvedPublishedModelCatalogOwner = {
        catalogOwner: { agentId: "worker", workspaceDir: metadataSnapshot.workspaceDir },
        agentId: "worker",
        agentDir: "/tmp/cron-agent",
        workspaceDir: metadataSnapshot.workspaceDir,
        config: cfg,
        providerAuth: {},
        authStore: { version: 1, profiles: {} },
        metadataSnapshot,
        modelCatalog: { entries: [], routeVariants: [] },
      };
      for (const ambient of [metadataSnapshot, otherWorkspace]) {
        const result = await withPluginRuntimeGenerationScope({ metadataSnapshot: ambient }, () =>
          resolveCronModelSelection({
            cfg,
            owner,
            agentConfigOverride: resolveAgentConfig(cfg, owner.agentId),
            agentId: owner.agentId,
            agentDir: owner.agentDir,
            workspaceDir: owner.workspaceDir,
            payload: {
              kind: "agentTurn",
              message: "scheduled work",
              ...(source === "payload" ? { model: "custom/legacy" } : {}),
            },
            sessionEntry:
              source === "session" ? { providerOverride: "custom", modelOverride: "legacy" } : {},
            isGmailHook: source === "hook",
          }),
        );
        expect(result).toMatchObject({
          ok: true,
          provider: source === "hook" ? DEFAULT_PROVIDER : "custom",
          model: "selected",
          modelSource: source,
        });
      }
    },
  );
});
