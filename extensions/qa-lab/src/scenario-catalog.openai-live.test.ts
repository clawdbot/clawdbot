// Qa Lab tests cover live OpenAI scenario catalog metadata.
import { describe, expect, it } from "vitest";
import { readQaScenarioById, readQaScenarioExecutionConfig } from "./scenario-catalog.js";

describe("qa scenario catalog", () => {
  it("includes the GPT-5.6 Luna thinking visibility switch scenario", () => {
    const scenario = readQaScenarioById("luna-thinking-visibility-switch");
    const config = readQaScenarioExecutionConfig("luna-thinking-visibility-switch") as
      | {
          liveProvider?: string;
          requiredModel?: string;
          offDirective?: string;
          maxDirective?: string;
          reasoningDirective?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/models/luna-thinking-visibility-switch.yaml");
    expect(config?.liveProvider).toBe("openai");
    expect(config?.requiredModel).toBe("gpt-5.6-luna");
    expect(config?.offDirective).toBe("/think off");
    expect(config?.maxDirective).toBe("/think medium");
    expect(config?.reasoningDirective).toBe("/reasoning on");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "enables reasoning display and disables thinking",
      "switches to medium thinking",
      "verifies medium thinking reaches the provider",
    ]);
  });

  it("includes the OpenAI native web search live scenario", () => {
    const scenario = readQaScenarioById("openai-native-web-search-live");
    const config = readQaScenarioExecutionConfig("openai-native-web-search-live") as
      | {
          requiredProvider?: string;
          requiredModel?: string;
          expectedMarker?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/models/openai-native-web-search-live.yaml");
    expect(scenario.gatewayConfigPatch?.tools).toEqual({
      web: {
        search: {
          enabled: true,
          provider: null,
        },
      },
    });
    expect(config?.requiredProvider).toBe("openai");
    expect(config?.requiredModel).toBe("gpt-5.6-luna");
    expect(config?.expectedMarker).toBe("WEB-SEARCH-OK");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "confirms live OpenAI GPT-5.6 Luna web search auto mode",
      "searches official OpenAI News through the live model",
    ]);
  });

  it("includes the Kitchen Sink live OpenAI plugin gauntlet", () => {
    const scenario = readQaScenarioById("kitchen-sink-live-openai");
    const config = readQaScenarioExecutionConfig("kitchen-sink-live-openai") as
      | {
          requiredProviderMode?: string;
          requiredProvider?: string;
          pluginSpec?: string;
          pluginId?: string;
          pluginPersonality?: string;
          adversarialPersonality?: string;
          expectedSurfaceIds?: Record<string, string[]>;
          expectedAdversarialDiagnostics?: string[];
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/plugins/kitchen-sink-live-openai.yaml");
    expect(config?.requiredProviderMode).toBe("live-frontier");
    expect(config?.requiredProvider).toBe("openai");
    expect(config?.pluginSpec).toBe("npm:@openclaw/kitchen-sink@latest");
    expect(JSON.stringify(scenario.execution.flow)).toContain('"--force"');
    expect(config?.pluginId).toBe("openclaw-kitchen-sink-fixture");
    expect(config?.pluginPersonality).toBe("conformance");
    expect(config?.adversarialPersonality).toBe("adversarial");
    expect(config?.expectedSurfaceIds?.webSearchProviderIds).toContain(
      "kitchen-sink-web-search-provider",
    );
    expect(config?.expectedSurfaceIds?.realtimeVoiceProviderIds).toContain(
      "kitchen-sink-realtime-voice-provider",
    );
    expect(config?.expectedAdversarialDiagnostics).toContain(
      "agent tool result middleware must be a function",
    );
    expect(config?.expectedAdversarialDiagnostics).toContain(
      "trusted tool policy registration requires id, description, and evaluate()",
    );
    expect(config?.expectedAdversarialDiagnostics).toContain(
      "hosted media resolver registration missing resolver",
    );
    expect(config?.expectedAdversarialDiagnostics).toContain(
      "plugin must declare contracts.embeddingProviders for adapter: kitchen-sink-embedding-provider",
    );
    expect(config?.expectedAdversarialDiagnostics).toContain(
      "model catalog provider registration missing provider",
    );
    expect(
      config?.expectedAdversarialDiagnostics?.every((entry) => typeof entry === "string"),
    ).toBe(true);
    expect(JSON.stringify(scenario.execution.flow)).toContain("--runtime");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "installs and inspects the Kitchen Sink plugin",
      "restarts gateway with Kitchen Sink configured",
      "exercises command inventory and MCP tool surfaces",
      "runs live OpenAI turn with Kitchen Sink loaded",
      "records gateway CPU RSS and log anomaly evidence",
      "verifies adversarial diagnostics personality",
    ]);
  });
});
