// Qa Lab tests cover live OpenAI scenario catalog metadata.
import { describe, expect, it } from "vitest";
import { readQaScenarioById, readQaScenarioExecutionConfig } from "./scenario-catalog.js";
import { selectQaFlowSuiteScenarios } from "./suite-planning.js";

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
    const flow = JSON.stringify(scenario.execution.flow);
    expect(flow).toContain("/debug/request-cursor");
    expect(flow).toContain("/debug/requests?after=${offRequestCursor}");
    expect(flow).toContain("/debug/requests?after=${maxRequestCursor}");
  });

  it("includes the OpenAI native web search live scenario", () => {
    const scenario = readQaScenarioById("openai-native-web-search-live");
    const config = readQaScenarioExecutionConfig("openai-native-web-search-live") as
      | {
          requiredProviderMode?: string;
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
    expect(config?.requiredProviderMode).toBe("live-frontier");
    expect(config?.requiredProvider).toBe("openai");
    expect(config?.requiredModel).toBe("gpt-5.6-luna");
    expect(config?.expectedMarker).toBe("WEB-SEARCH-OK");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "confirms live OpenAI GPT-5.6 Luna web search auto mode",
      "searches official OpenAI News through the live model",
    ]);
    expect(scenario.execution.flow?.steps.at(-1)?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ call: "runAgentPrompt" }),
        expect.objectContaining({ call: "waitForOutboundMessage" }),
      ]),
    );
  });

  it("rejects the native web-search probe from matching-provider mock lanes", () => {
    const scenario = readQaScenarioById("openai-native-web-search-live");
    const mockLane = {
      scenarios: [scenario],
      providerMode: "mock-openai" as const,
      primaryModel: "openai/gpt-5.6-luna",
    };

    expect(selectQaFlowSuiteScenarios({ ...mockLane, providerMode: "live-frontier" })).toEqual([
      scenario,
    ]);
    expect(selectQaFlowSuiteScenarios(mockLane)).toEqual([]);
    expect(() => selectQaFlowSuiteScenarios({ ...mockLane, scenarioIds: [scenario.id] })).toThrow(
      "providerMode=live-frontier",
    );
  });

  it("includes the live inbound voice talkback scenario", () => {
    const scenario = readQaScenarioById("inbound-voice-talkback-live");
    const config = readQaScenarioExecutionConfig("inbound-voice-talkback-live") as
      | {
          requiredProviderMode?: string;
          requiredProvider?: string;
          requiredModel?: string;
          expectedMarker?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/media/inbound-voice-talkback-live.yaml");
    expect(scenario.coverage?.primary).toEqual(["media.inbound-media-store"]);
    expect(scenario.execution.channel).toBe("qa-channel");
    expect(scenario.gatewayConfigPatch?.tools).toEqual({
      media: {
        models: [
          {
            provider: "openai",
            model: "gpt-4o-transcribe",
            capabilities: ["audio"],
          },
        ],
        audio: {
          enabled: true,
          echoTranscript: false,
        },
      },
    });
    expect(config?.requiredProviderMode).toBe("live-frontier");
    expect(config?.requiredProvider).toBe("openai");
    expect(config?.requiredModel).toBe("gpt-5.4");
    expect(config?.expectedMarker).toBe("MATRIX QA VOICE PREFLIGHT OK");
    expect(JSON.stringify(scenario.execution.flow)).toContain("./voice-preflight.fixture.js");
    expect(JSON.stringify(scenario.execution.flow)).not.toContain("./live-transports/matrix/");
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
          allowedAdversarialDiagnostics?: string[];
          requiredAdversarialDiagnostics?: string[];
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
    expect(config?.requiredAdversarialDiagnostics).toContain(
      "agent tool result middleware must be a function",
    );
    expect(config?.requiredAdversarialDiagnostics).toContain(
      "trusted tool policy registration requires id, description, and evaluate()",
    );
    expect(config?.requiredAdversarialDiagnostics).toContain(
      "plugin must declare contracts.tools for: kitchen-sink-tool",
    );
    expect(config?.requiredAdversarialDiagnostics).toContain(
      'channel "kitchen-sink-channel-probe" registration missing required config helpers',
    );
    expect(config?.requiredAdversarialDiagnostics).toContain(
      'agent harness "kitchen-sink-agent-harness" registration missing required runtime methods',
    );
    expect(config?.allowedAdversarialDiagnostics).toContain(
      "hosted media resolver registration missing resolver",
    );
    expect(config?.allowedAdversarialDiagnostics).toContain(
      "plugin must declare contracts.embeddingProviders for adapter: kitchen-sink-embedding-provider",
    );
    expect(config?.allowedAdversarialDiagnostics).toContain(
      "model catalog provider registration missing provider",
    );
    expect(
      config?.requiredAdversarialDiagnostics?.every((entry) => typeof entry === "string"),
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
