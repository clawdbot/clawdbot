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
    expect(pack.scenarios.some((scenario) => scenario.id === "image-generation-roundtrip")).toBe(
      true,
    );
    expect(pack.scenarios.some((scenario) => scenario.id === "character-vibes-gollum")).toBe(true);
    expect(pack.scenarios.some((scenario) => scenario.id === "character-vibes-c3po")).toBe(true);
    expect(pack.scenarios.every((scenario) => scenario.execution?.kind === "flow")).toBe(true);
    expect(pack.scenarios.some((scenario) => scenario.execution.flow?.steps.length)).toBe(true);
    expect(pack.scenarios.every((scenario) => scenario.coverage?.primary.length)).toBe(true);
    expect(readQaScenarioById("memory-recall").coverage?.primary).toContain("memory.recall");
  });

  it("exposes bootstrap data from the markdown pack", () => {
    const catalog = readQaBootstrapScenarioCatalog();

    expect(catalog.agentIdentityMarkdown).toContain("protocol-minded");
    expect(catalog.kickoffTask).toContain("Track what worked");
    expect(catalog.scenarios.some((scenario) => scenario.id === "subagent-fanout-synthesis")).toBe(
      true,
    );
    expect(
      QA_AGENTIC_PARITY_SCENARIO_IDS.every((scenarioId) =>
        catalog.scenarios.some((scenario) => scenario.id === scenarioId),
      ),
    ).toBe(true);
  });

  it("loads scenario-specific execution config from per-scenario markdown", () => {
    const discovery = readQaScenarioById("source-docs-discovery-report");
    const discoveryConfig = readQaScenarioExecutionConfig("source-docs-discovery-report");
    const codexLeak = readQaScenarioById("codex-harness-no-meta-leak");
    const codexLeakConfig = readQaScenarioExecutionConfig("codex-harness-no-meta-leak") as
      | {
          harnessRuntime?: string;
          harnessFallback?: string;
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
    expect(codexLeakConfig?.harnessFallback).toBe("none");
    expect(codexLeakConfig?.expectedReply).toBe("QA_LEAK_OK");
    expect(codexLeakConfig?.forbiddenReplySubstrings).toContain("checking thread context");
    expect(fallbackConfig?.gracefulFallbackAny as string[] | undefined).toContain(
      "will not reveal",
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

  it("includes the GPT-5.4 thinking visibility switch scenario", () => {
    const scenario = readQaScenarioById("gpt54-thinking-visibility-switch");
    const config = readQaScenarioExecutionConfig("gpt54-thinking-visibility-switch") as
      | {
          requiredLiveProvider?: string;
          requiredLiveModel?: string;
          offDirective?: string;
          maxDirective?: string;
          reasoningDirective?: string;
        }
      | undefined;

    expect(scenario.sourcePath).toBe("qa/scenarios/models/gpt54-thinking-visibility-switch.md");
    expect(config?.requiredLiveProvider).toBe("openai");
    expect(config?.requiredLiveModel).toBe("gpt-5.4");
    expect(config?.offDirective).toBe("/think off");
    expect(config?.maxDirective).toBe("/think medium");
    expect(config?.reasoningDirective).toBe("/reasoning on");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "enables reasoning display and disables thinking",
      "switches to medium thinking",
      "verifies medium thinking emits visible reasoning",
      "verifies medium thinking completes the answer",
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
    expect(config?.requiredModel).toBe("gpt-5.4");
    expect(config?.expectedMarker).toBe("WEB-SEARCH-OK");
    expect(scenario.execution.flow?.steps.map((step) => step.name)).toEqual([
      "confirms live OpenAI GPT-5.4 web search auto mode",
      "searches official OpenAI News through the live model",
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
    expect(config?.openAiXhighModelRef).toBe("openai/gpt-5.4");
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
