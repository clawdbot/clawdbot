// Qa Lab tests cover scenario catalog plugin behavior.
import { describe, expect, it } from "vitest";
import { QA_AGENTIC_PARITY_SCENARIO_IDS } from "./agentic-parity.js";
import {
  listQaScenarioMarkdownPaths,
  readQaBootstrapScenarioCatalog,
  readQaScenarioById,
  readQaScenarioExecutionConfig,
  readQaScenarioPack,
  validateQaScenarioExecutionConfig,
} from "./scenario-catalog.js";

describe("qa scenario catalog", () => {
  it("loads the markdown pack as the canonical source of truth", () => {
    const pack = readQaScenarioPack();

    expect(pack.version).toBe(1);
    expect(pack.agent.identityMarkdown).toContain("Dev C-3PO");
    expect(pack.kickoffTask).toContain("Lobster Invaders");
    expect(listQaScenarioMarkdownPaths().length).toBe(pack.scenarios.length);
    expect(listQaScenarioMarkdownPaths()).toContain(
      "qa/scenarios/media/image-generation-roundtrip.md",
    );
    const scenarioIds = pack.scenarios.map((scenario) => scenario.id);
    const requiredScenarioIds = [
      "image-generation-roundtrip",
      "character-vibes-gollum",
      "character-vibes-c3po",
    ].toSorted();
    expect(
      scenarioIds.filter((scenarioId) => requiredScenarioIds.includes(scenarioId)).toSorted(),
    ).toEqual(requiredScenarioIds);
    expect(
      pack.scenarios
        .filter((scenario) => scenario.execution?.kind !== "flow")
        .map((scenario) => scenario.id),
    ).toStrictEqual([]);
    expect(
      pack.scenarios.filter((scenario) => (scenario.execution.flow?.steps.length ?? 0) > 0),
    ).not.toStrictEqual([]);
    expect(
      pack.scenarios
        .filter((scenario) => !(scenario.coverage?.primary.length ?? 0))
        .map((scenario) => scenario.id),
    ).toStrictEqual([]);
    expect(readQaScenarioById("memory-recall").coverage?.primary).toContain("memory.recall");
  });

  it("exposes bootstrap data from the markdown pack", () => {
    const catalog = readQaBootstrapScenarioCatalog();

    expect(catalog.agentIdentityMarkdown).toContain("protocol-minded");
    expect(catalog.kickoffTask).toContain("Track what worked");
    const scenarioIds = catalog.scenarios.map((scenario) => scenario.id);
    expect(scenarioIds).toContain("subagent-fanout-synthesis");
    expect(
      QA_AGENTIC_PARITY_SCENARIO_IDS.filter((scenarioId) => !scenarioIds.includes(scenarioId)),
    ).toStrictEqual([]);
  });

  it("loads scenario-specific execution config from per-scenario markdown", () => {
    const discovery = readQaScenarioById("source-docs-discovery-report");
    const discoveryConfig = readQaScenarioExecutionConfig("source-docs-discovery-report");
    const codexLeak = readQaScenarioById("codex-harness-no-meta-leak");
    const codexLeakConfig = readQaScenarioExecutionConfig("codex-harness-no-meta-leak") as
      | {
          harnessRuntime?: string;
          expectedReply?: string;
          forbiddenReplySubstrings?: string[];
        }
      | undefined;
    const fallbackConfig = readQaScenarioExecutionConfig("memory-failure-fallback");
    const bundledSkill = readQaScenarioById("bundled-plugin-skill-runtime");
    const bundledSkillConfig = readQaScenarioExecutionConfig("bundled-plugin-skill-runtime") as
      | { pluginId?: string; expectedSkillName?: string }
      | undefined;
    const fanoutConfig = readQaScenarioExecutionConfig("subagent-fanout-synthesis") as
      | { expectedReplyGroups?: unknown[][] }
      | undefined;

    expect(discovery.title).toBe("Source and docs discovery report");
    expect((discoveryConfig?.requiredFiles as string[] | undefined)?.[0]).toBe(
      "repo/qa/scenarios/index.md",
    );
    expect(codexLeak.title).toBe("Codex harness no meta leak");
    expect(codexLeakConfig?.harnessRuntime).toBe("codex");
    expect(JSON.stringify(codexLeak.execution.flow)).toContain("agentRuntime");
    expect(JSON.stringify(codexLeak.execution.flow)).not.toContain("embeddedHarness");
    expect(codexLeakConfig?.expectedReply).toBe("QA_LEAK_OK");
    expect(codexLeakConfig?.forbiddenReplySubstrings).toContain("checking thread context");
    expect(fallbackConfig?.gracefulFallbackAny as string[] | undefined).toContain(
      "will not reveal",
    );
    expect(JSON.stringify(readQaScenarioById("memory-failure-fallback").execution.flow)).toContain(
      "liveTurnTimeoutMs(env, 180000)",
    );
    expect(bundledSkill.title).toBe("Bundled plugin skill runtime");
    expect(bundledSkillConfig?.pluginId).toBe("open-prose");
    expect(bundledSkillConfig?.expectedSkillName).toBe("prose");
    expect(fanoutConfig?.expectedReplyGroups?.flat()).toContain("subagent-1: ok");
    expect(fanoutConfig?.expectedReplyGroups?.flat()).toContain("subagent-2: ok");
  });

  it("loads scenario-declared gateway runtime options from markdown", () => {
    const scenario = readQaScenarioById("control-ui-qa-channel-image-roundtrip");

    expect(scenario.gatewayRuntime?.forwardHostHome).toBe(true);
  });

  it("loads runtime parity tier metadata for first-hour and soak lanes", () => {
    const firstHour = readQaScenarioById("runtime-first-hour-20-turn");
    const soak = readQaScenarioById("runtime-soak-100-turn");

    expect(firstHour.runtimeParityTier).toBe("standard");
    expect(readQaScenarioExecutionConfig(firstHour.id)).toMatchObject({
      runtimeParityComparison: "outcome-only",
      turnCount: 20,
    });
    expect(soak.runtimeParityTier).toBe("soak");
    expect(readQaScenarioExecutionConfig(soak.id)).toMatchObject({ turnCount: 100 });
  });

  it("loads runtime tool fixture metadata for standard and optional lanes", () => {
    const applyPatch = readQaScenarioById("runtime-tool-apply-patch");
    const messageTool = readQaScenarioById("runtime-tool-message-tool");
    const tavilySearch = readQaScenarioById("runtime-tool-tavily-search");
    const webSearch = readQaScenarioById("runtime-tool-web-search");

    expect(applyPatch.runtimeParityTier).toBe("standard");
    expect(messageTool.runtimeParityTier).toBe("optional");
    expect(tavilySearch.runtimeParityTier).toBe("optional");
    expect(readQaScenarioExecutionConfig(applyPatch.id)).toMatchObject({
      toolName: "apply_patch",
      toolCoverage: {
        bucket: "codex-native-workspace",
        expectedLayer: "codex-native-workspace",
      },
    });
    expect(readQaScenarioExecutionConfig(messageTool.id)).toMatchObject({
      toolName: "message",
      expectedAvailable: false,
      toolCoverage: {
        bucket: "optional-profile-or-plugin",
        expectedLayer: "profile-or-plugin",
        required: false,
      },
    });
    expect(readQaScenarioExecutionConfig(webSearch.id)).toMatchObject({
      toolName: "web_search",
      toolCoverage: {
        bucket: "openclaw-dynamic-integration",
        expectedLayer: "openclaw-dynamic",
        capabilityLayer: "openclaw-dynamic-direct",
        required: true,
      },
    });
    expect(readQaScenarioExecutionConfig(webSearch.id)).not.toHaveProperty("knownHarnessGap");
  });

  it("loads the Codex legacy Read vocabulary live parity canary", () => {
    const scenario = readQaScenarioById("codex-legacy-read-tool-vocabulary");
    const config = readQaScenarioExecutionConfig(scenario.id) as
      | {
          runtimeParityComparison?: string;
          fixtureFile?: string;
          expectedMarker?: string;
          unavailableNeedles?: string[];
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/runtime/codex-legacy-read-tool-vocabulary.md");
    expect(scenario.runtimeParityTier).toBe("live-only");
    expect(config?.runtimeParityComparison).toBe("codex-native-workspace");
    expect(config?.fixtureFile).toBe("LEGACY_READ_TOOL_FIXTURE.txt");
    expect(config?.expectedMarker).toBe("LEGACY_READ_TOOL_OK");
    expect(config?.unavailableNeedles).toContain("not in my available tool surface");
  });

  it("loads live gateway sentinel scenarios for harness self-health", () => {
    const scenarioIds = [
      "plugin-hook-health-sentinel",
      "plugin-manifest-contract-health",
      "webchat-direct-reply-routing",
      "long-context-progress-watchdog",
      "gateway-restart-inflight-run",
      "streaming-final-integrity",
    ];

    for (const scenarioId of scenarioIds) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.runtimeParityTier).toBe("live-only");
      expect(scenario.execution.flow?.steps.length).toBeGreaterThan(0);
      expect(scenario.coverage?.primary.length).toBeGreaterThan(0);
    }
    expect(readQaScenarioById("webchat-direct-reply-routing").sourcePath).toBe(
      "qa/scenarios/channels/webchat-direct-reply-routing.md",
    );
    expect(readQaScenarioById("long-context-progress-watchdog").sourcePath).toBe(
      "qa/scenarios/runtime/long-context-progress-watchdog.md",
    );
    expect(
      JSON.stringify(readQaScenarioById("gateway-restart-inflight-run").execution.flow),
    ).toContain("EmbeddedAttemptSessionTakeoverError");
    expect(
      JSON.stringify(readQaScenarioById("gateway-restart-inflight-run").execution.flow),
    ).toContain("AbortError");
    expect(
      JSON.stringify(readQaScenarioById("gateway-restart-inflight-run").execution.flow),
    ).toContain("This operation was aborted");
    expect(
      JSON.stringify(readQaScenarioById("gateway-restart-inflight-run").execution.flow),
    ).toContain("liveTurnTimeoutMs(env, 180000)");
    expect(readQaScenarioExecutionConfig("long-context-progress-watchdog")).toMatchObject({
      requiredProviderMode: "live-frontier",
      harnessRuntime: "codex",
    });
    expect(readQaScenarioById("long-context-progress-watchdog").plugins).toBeUndefined();
    expect(readQaScenarioById("long-context-progress-watchdog").gatewayConfigPatch).toBeUndefined();
  });

  it("loads the QA bus tool trace visibility harness scenario", () => {
    const scenario = readQaScenarioById("qa-bus-tool-trace-visibility");
    const config = readQaScenarioExecutionConfig(scenario.id) as
      | {
          expectedToolName?: string;
          expectedRedaction?: string;
          searchQuery?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/runtime/qa-bus-tool-trace-visibility.md");
    expect(scenario.coverage?.primary).toContain("harness.tool-trace-visibility");
    expect(scenario.coverage?.secondary).toContain("runtime.qa-bus");
    expect(config?.expectedToolName).toBe("exec");
    expect(config?.expectedRedaction).toBe("[redacted]");
    expect(config?.searchQuery).toBe("exec");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "preserves searchable sanitized tool-call traces",
    ]);
  });

  it("loads the opt-in update.run package self-upgrade sentinel", () => {
    const scenario = readQaScenarioById("update-run-package-self-upgrade");
    const config = readQaScenarioExecutionConfig(scenario.id) as
      | {
          requiredProviderMode?: string;
          allowEnv?: string;
          sourceVersion?: string;
          targetTag?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/runtime/update-run-package-self-upgrade.md");
    expect(scenario.coverage?.primary).toContain("runtime.update-run");
    expect(scenario.coverage?.secondary).toContain("runtime.package-update");
    expect(config?.requiredProviderMode).toBe("live-frontier");
    expect(config?.allowEnv).toBe("OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF");
    expect(config?.sourceVersion).toBe("2026.4.26");
    expect(config?.targetTag).toBe("latest");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "asks the agent to self-update through update.run",
    ]);
  });

  it("loads the Codex plugin lifecycle fixture scenarios into the standard runtime tier", () => {
    const scenarioIds = [
      "codex-plugin-cold-install",
      "codex-plugin-install-race",
      "codex-plugin-pinned-old",
      "codex-plugin-pinned-new",
      "auth-profile-codex-mixed-profiles",
      "auth-profile-doctor-migration-safety",
    ];

    for (const scenarioId of scenarioIds) {
      const scenario = readQaScenarioById(scenarioId);
      expect(scenario.runtimeParityTier).toBe("standard");
      expect(scenario.coverage?.primary.length).toBeGreaterThan(0);
      expect(scenario.execution.flow?.steps.length).toBe(1);
    }
    expect(readQaScenarioExecutionConfig("codex-plugin-pinned-old")).toMatchObject({
      pluginVersion: "2026.5.19",
      hostVersion: "2026.5.21",
      pluginRelation: "older",
    });
    expect(readQaScenarioExecutionConfig("auth-profile-doctor-migration-safety")).toMatchObject({
      matrixCells: ["oauth-only", "mixed-no-pin"],
    });
  });

  it("keeps the character eval scenario natural and task-shaped", () => {
    const characterConfig = readQaScenarioExecutionConfig("character-vibes-gollum") as
      | {
          workspaceFiles?: Record<string, string>;
          turns?: Array<{ text?: string; expectFile?: { path?: string } }>;
        }
      | undefined;

    const turnTexts = characterConfig?.turns?.map((turn) => turn.text ?? "") ?? [];

    expect(characterConfig?.workspaceFiles?.["SOUL.md"]).toContain("# This is your character");
    expect(turnTexts.join("\n")).toContain("precious-status.html");
    expect(turnTexts.join("\n")).not.toContain("How would you react");
    expect(turnTexts.join("\n")).not.toContain("character check");
    expect(
      characterConfig?.turns?.some((turn) => turn.expectFile?.path === "precious-status.html"),
    ).toBe(true);
  });

  it("includes the codex leak scenario in the markdown pack", () => {
    const pack = readQaScenarioPack();
    const scenario = pack.scenarios.find(
      (candidate) => candidate.id === "codex-harness-no-meta-leak",
    );

    expect(scenario?.sourcePath).toBe("qa/scenarios/models/codex-harness-no-meta-leak.md");
    expect(scenario?.execution.flow?.steps.map((step) => step.name)).toContain(
      "keeps codex coordination chatter out of the visible reply",
    );
  });

  it("includes the GPT-5.5 thinking visibility switch scenario", () => {
    const scenario = readQaScenarioById("gpt55-thinking-visibility-switch");
    const config = readQaScenarioExecutionConfig("gpt55-thinking-visibility-switch") as
      | {
          requiredProvider?: string;
          requiredModel?: string;
          offDirective?: string;
          maxDirective?: string;
          reasoningDirective?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/models/gpt55-thinking-visibility-switch.md");
    expect(config?.requiredProvider).toBe("openai");
    expect(config?.requiredModel).toBe("gpt-5.5");
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

    expect(scenario.sourcePath).toBe("qa/scenarios/models/openai-native-web-search-live.md");
    expect(scenario.gatewayConfigPatch?.tools).toEqual({
      web: {
        search: {
          enabled: true,
          provider: null,
        },
      },
    });
    expect(config?.requiredProvider).toBe("openai");
    expect(config?.requiredModel).toBe("gpt-5.5");
    expect(config?.expectedMarker).toBe("WEB-SEARCH-OK");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "confirms live OpenAI GPT-5.5 web search auto mode",
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

    expect(scenario.sourcePath).toBe("qa/scenarios/plugins/kitchen-sink-live-openai.md");
    expect(config?.requiredProviderMode).toBe("live-frontier");
    expect(config?.requiredProvider).toBe("openai");
    expect(config?.pluginSpec).toBe("npm:@openclaw/kitchen-sink@latest");
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
      "only bundled plugins can register agent tool result middleware",
    );
    expect(config?.expectedAdversarialDiagnostics).toContain(
      "control UI descriptor registration requires id, surface, label, and valid optional fields",
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

  it("includes the thinking slash model remap scenario", () => {
    const scenario = readQaScenarioById("thinking-slash-model-remap");
    const config = readQaScenarioExecutionConfig("thinking-slash-model-remap") as
      | {
          requiredProviderMode?: string;
          anthropicModelRef?: string;
          openAiXhighModelRef?: string;
          noXhighModelRef?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/models/thinking-slash-model-remap.md");
    expect(config?.requiredProviderMode).toBe("live-frontier");
    expect(config?.anthropicModelRef).toBe("anthropic/claude-sonnet-4-6");
    expect(config?.openAiXhighModelRef).toBe("openai/gpt-5.5");
    expect(config?.noXhighModelRef).toBe("anthropic/claude-sonnet-4-6");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "selects Anthropic and verifies adaptive options",
      "maps adaptive to medium when switching to OpenAI",
      "maps xhigh to high on a model without xhigh",
    ]);
  });

  it("includes the seeded mock-only broken-turn scenarios in the markdown pack", () => {
    const scenarioIds = [
      "reasoning-only-recovery-replay-safe-read",
      "reasoning-only-no-auto-retry-after-write",
      "empty-response-recovery-replay-safe-read",
      "empty-response-retry-budget-exhausted",
    ];

    for (const scenarioId of scenarioIds) {
      const scenario = readQaScenarioById(scenarioId);
      const config = readQaScenarioExecutionConfig(scenarioId) as
        | {
            requiredProvider?: string;
            prompt?: string;
          }
        | undefined;

      expect(scenario.sourcePath).toBe(`qa/scenarios/runtime/${scenarioId}.md`);
      expect(config?.requiredProvider).toBe("mock-openai");
      expect(config?.prompt).toContain("check");
      expect(scenario.execution.flow?.steps.length).toBeGreaterThan(0);
    }
  });

  it("keeps mock-only image debug assertions guarded in live-frontier runs", () => {
    const scenario = readQaScenarioPack().scenarios.find(
      (candidate) => candidate.id === "image-understanding-attachment",
    );
    const imageRequestAction = scenario?.execution.flow?.steps
      .flatMap((step) => step.actions ?? [])
      .find(
        (
          action,
        ): action is {
          set: string;
          value?: { expr?: string };
        } =>
          typeof action === "object" &&
          action !== null &&
          "set" in action &&
          action.set === "imageRequest",
      );
    const imageRequestExpr = imageRequestAction?.value?.expr;

    expect(imageRequestExpr).toContain("env.mock ?");
    expect(imageRequestExpr).toContain("/debug/requests");
  });

  it("adds a repo-instruction followthrough scenario to the parity pack", () => {
    const scenario = readQaScenarioById("instruction-followthrough-repo-contract");
    const config = readQaScenarioExecutionConfig("instruction-followthrough-repo-contract") as
      | {
          workspaceFiles?: Record<string, string>;
          prompt?: string;
          expectedReplyAll?: string[];
          expectedArtifactAll?: string[];
          expectedArtifactAny?: string[];
        }
      | undefined;

    expect(config?.workspaceFiles?.["AGENT.md"]).toContain("Step order:");
    expect(config?.workspaceFiles?.["SOUL.md"]).toContain("action-first");
    expect(config?.workspaceFiles?.["FOLLOWTHROUGH_INPUT.md"]).toContain(
      "Mission: prove you followed the repo contract.",
    );
    expect(config?.prompt).toContain("Repo contract followthrough check.");
    expect(config?.expectedReplyAll).toEqual(["read:", "wrote:", "status:"]);
    expect(config?.expectedArtifactAll).toEqual(["repo contract"]);
    expect(config?.expectedArtifactAny).toContain("evidence path");
    expect(scenario.title).toBe("Instruction followthrough repo contract");
  });

  it("adds a dreaming shadow trial report scenario", () => {
    const scenario = readQaScenarioById("dreaming-shadow-trial-report");
    const config = readQaScenarioExecutionConfig("dreaming-shadow-trial-report") as
      | {
          prompt?: string;
          reportName?: string;
          expectedReportAll?: string[];
          forbiddenReplyNeedles?: string[];
          seededMemory?: string;
        }
      | undefined;
    const flow = JSON.stringify(scenario.execution.flow);

    expect(scenario.sourcePath).toBe("qa/scenarios/memory/dreaming-shadow-trial-report.md");
    expect(scenario.coverage?.primary).toContain("memory.dreaming");
    expect(config?.prompt).toContain("Dreaming shadow trial report check");
    expect(config?.reportName).toBe("dreaming-shadow-trial-report.md");
    expect(config?.seededMemory).toBe("# Memory\n\n");
    expect(config?.expectedReportAll).toContain("verdict: helpful");
    expect(config?.expectedReportAll).toContain("exact verification commands and remaining risk");
    expect(config?.expectedReportAll).toContain("omits the exact command and remaining risk");
    expect(config?.expectedReportAll).toContain("calls out the remaining review risk");
    expect(config?.forbiddenReplyNeedles).toContain("candidate was promoted to MEMORY.md");
    expect(flow).toContain("plannedToolName === 'write'");
    expect(flow).toContain("readIndices[1] < firstWrite");
    expect(flow).toContain("String(memoryAfter) === config.seededMemory");
  });

  it("rejects malformed string matcher lists before running a flow", () => {
    expect(() =>
      validateQaScenarioExecutionConfig({
        gracefulFallbackAny: [{ confirmed: "the hidden fact is present" }],
      }),
    ).toThrow(/gracefulFallbackAny entries must be strings/);
  });

  it("returns undefined execution config for an unknown scenario id", () => {
    expect(readQaScenarioExecutionConfig("missing-scenario-id")).toBeUndefined();
  });
});
