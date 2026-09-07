// Covers direct model directive authorization and upgrade-era repair guidance.
import { describe, expect, it } from "vitest";
import { buildModelAliasIndex } from "../../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelDirectiveSelection } from "./model-selection-directive.js";
import { createModelSelectionState } from "./model-selection.js";

function resolveDirective(params: { cfg: OpenClawConfig; raw: string; agentId?: string }) {
  const defaultProvider = "openai";
  const defaultModel = "safe";
  const policy = createModelVisibilityPolicy({
    cfg: params.cfg,
    catalog: [],
    defaultProvider,
    defaultModel,
    agentId: params.agentId,
  });
  return {
    policy,
    result: resolveModelDirectiveSelection({
      raw: params.raw,
      defaultProvider,
      defaultModel,
      aliasIndex: buildModelAliasIndex({
        cfg: params.cfg,
        defaultProvider,
        agentId: params.agentId,
      }),
      allowedModelKeys: policy.allowedKeys,
      cfg: params.cfg,
      agentId: params.agentId,
    }),
  };
}

describe("resolveModelDirectiveSelection", () => {
  it.each([
    {
      allow: ["fixture-route/namespace/*"],
      raw: "fixture-route/namespace/reasoner",
      agentAllow: undefined,
      allowed: true,
    },
    {
      allow: ["fixture-route/namespace/*"],
      raw: "fixture-route/namespace-other/reasoner",
      agentAllow: undefined,
      allowed: false,
    },
    {
      allow: ["openai/*"],
      raw: "fixture-route/namespace/reasoner",
      agentAllow: ["fixture-route/namespace/*"],
      allowed: true,
    },
    {
      allow: ["fixture-route/*"],
      raw: "fixture-route/namespace/reasoner",
      agentAllow: ["openai/*"],
      allowed: false,
    },
    { allow: ["openai/*"], raw: "fixture-route/namespace/reasoner", agentAllow: [], allowed: true },
  ])(
    "preserves wildcard boundaries and per-agent replacement: %j",
    ({ allow, raw, agentAllow, allowed }) => {
      const { result } = resolveDirective({
        cfg: {
          agents: {
            defaults: { modelPolicy: { allow } },
            list: [{ id: "ops", ...(agentAllow ? { modelPolicy: { allow: agentAllow } } : {}) }],
          },
        },
        raw,
        agentId: "ops",
      });
      if (allowed) {
        expect(result.selection).toMatchObject({
          provider: "fixture-route",
          model: "namespace/reasoner",
        });
      } else {
        expect(result.selection).toBeUndefined();
        expect(result.error).toContain("is not allowed");
      }
    },
  );

  it.each([undefined, {}, { allow: [] }, { allow: ["openai/*"] }])(
    "permits an explicit uncataloged model with policy %j",
    async (modelPolicy) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: "anthropic/claude-sonnet-4-6", modelPolicy } },
      };
      const entries = [{ provider: "anthropic", id: "claude-sonnet-4-6", name: "Sonnet" }];
      const state = await createModelSelectionState({
        cfg,
        agentCfg: cfg.agents?.defaults,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        hasModelDirective: true,
        preparedModelCatalog: { entries, routeVariants: entries },
      });
      const result = resolveModelDirectiveSelection({
        raw: "openai/gpt-5.6-luna",
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        aliasIndex: state.policyAliasIndex,
        allowedModelKeys: state.allowedModelKeys,
        modelPolicy: state.modelPolicy,
        cfg,
      });
      expect(result).toMatchObject({
        selection: { provider: "openai", model: "gpt-5.6-luna", isDefault: false },
      });
    },
  );

  it("rejects a configured fallback that the explicit policy does not allow", () => {
    const { policy, result } = resolveDirective({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/safe", fallbacks: ["external/sensitive"] },
            modelPolicy: { allow: ["openai/safe"] },
          },
        },
      },
      raw: "external/sensitive",
    });

    expect(policy.allowedKeys.has("external/sensitive")).toBe(false);
    expect(result.selection).toBeUndefined();
    expect(result.error).toContain('Model "external/sensitive" is not allowed.');
  });

  it.each([
    {
      name: "defaults",
      cfg: {
        agents: { defaults: { models: { "openai/safe": {} } } },
      } as OpenClawConfig,
      agentId: undefined,
      repairPath: "agents.defaults.modelPolicy.allow",
      legacyPath: "agents.defaults.models",
    },
    // Only agents.defaults.models is a legacy allowlist; per-agent models maps are
    // metadata-only, so there is no per-agent legacy-repair case to cover here.
  ])("points unmarked legacy $name repair at modelPolicy.allow", (testCase) => {
    const { result } = resolveDirective({
      cfg: testCase.cfg,
      raw: "external/sensitive",
      agentId: testCase.agentId,
    });

    expect(result.error).toContain(
      `Add "external/sensitive" or its provider wildcard to ${testCase.repairPath}.`,
    );
    expect(result.error).not.toContain(`to ${testCase.legacyPath}.`);
  });
});
