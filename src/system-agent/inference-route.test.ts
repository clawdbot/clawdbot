import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { selectAgentHarness } from "../agents/harness/selection.js";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SYSTEM_AGENT_ID } from "./agent-id.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";

function devConfig(agentRuntime?: string): OpenClawConfig {
  return {
    agents: {
      defaults: { model: "openai/gpt-5.5" },
      entries: {
        dev: { default: true, workspace: "/tmp/x" },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          ...(agentRuntime ? { agentRuntime: { id: agentRuntime } } : {}),
          models: [
            {
              id: "gpt-5.5",
              name: "GPT-5.5",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8_192,
            },
          ],
        },
      },
    },
  };
}

afterEach(() => {
  clearAgentHarnesses();
});

describe("resolveSystemAgentConfiguredRouteFromConfig", () => {
  it("admits the reserved execution agent for a dev-shaped roster", async () => {
    const route = await resolveSystemAgentConfiguredRouteFromConfig(devConfig());

    expect(route).not.toBeNull();
    expect(() =>
      resolveRunWorkspaceDir({
        workspaceDir: "/tmp/x",
        agentId: SYSTEM_AGENT_ID,
        config: route!.runConfig,
      }),
    ).not.toThrow();
  });

  it("keeps implicit harness selection fallible while forcing explicit policy", async () => {
    const supports = vi.fn((ctx: { modelProvider?: { requestTransportOverrides?: string } }) =>
      ctx.modelProvider?.requestTransportOverrides === "present"
        ? { supported: false as const, reason: "authored request transport overrides" }
        : { supported: true as const, priority: 100 },
    );
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: supports as never,
      runAttempt: vi.fn() as never,
    });
    const preparedModelProvider = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "present" as const,
    };

    const implicitRoute = await resolveSystemAgentConfiguredRouteFromConfig(devConfig());
    expect(implicitRoute).toMatchObject({ runner: "embedded" });
    expect(implicitRoute).not.toHaveProperty("agentHarnessRuntimeOverride");
    expect(
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider: preparedModelProvider,
        config: implicitRoute!.runConfig,
        agentHarnessRuntimeOverride:
          implicitRoute!.runner === "embedded"
            ? implicitRoute!.agentHarnessRuntimeOverride
            : undefined,
      }).id,
    ).toBe("openclaw");

    const explicitRoute = await resolveSystemAgentConfiguredRouteFromConfig(devConfig("codex"));
    expect(explicitRoute).toMatchObject({
      runner: "embedded",
      agentHarnessRuntimeOverride: "codex",
    });
    expect(() =>
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider: preparedModelProvider,
        config: explicitRoute!.runConfig,
        agentHarnessRuntimeOverride:
          explicitRoute!.runner === "embedded"
            ? explicitRoute!.agentHarnessRuntimeOverride
            : undefined,
      }),
    ).toThrow("authored request transport overrides");
  });
});
