import { describe, expect, it } from "vitest";
import {
  readQaBootstrapScenarioCatalog,
  readQaScenarioById,
  readQaScenarioExecutionConfig,
} from "../../scenario-catalog.js";
import { requireFlowScenario } from "../../scenario-catalog.test-utils.js";
import { collectQaSuitePluginIds } from "../../suite-planning.js";

const MATRIX_MENTION_GATE_PRIMARY_SCENARIOS = [
  "matrix-allowbots-default-block",
  "matrix-allowbots-mentions-mentioned-room",
  "matrix-allowbots-mentions-unmentioned-open-room-block",
  "matrix-allowbots-room-override-blocks-account-true",
  "matrix-allowbots-room-override-enables-account-off",
  "matrix-allowbots-self-sender-ignored",
  "matrix-allowbots-true-unmentioned-open-room",
  "matrix-mention-metadata-spoof-block",
] as const;

const MATRIX_ISOLATED_ALLOWBOTS_ADMISSION_SCENARIOS = [
  "matrix-allowbots-mentions-mentioned-room",
  "matrix-allowbots-room-override-enables-account-off",
  "matrix-allowbots-true-unmentioned-open-room",
] as const;

function readModuleBinding(
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
) {
  if (scenario.execution.kind !== "flow") {
    throw new Error(`expected Matrix module flow: ${scenario.id}`);
  }
  const actions = scenario.execution.flow?.steps.flatMap((step) => step.actions) ?? [];
  const importAction = actions.find(
    (action): action is { set: string; value: { expr: string } } =>
      typeof action === "object" &&
      action !== null &&
      "set" in action &&
      action.set === "scenarioModule" &&
      "value" in action &&
      typeof action.value === "object" &&
      action.value !== null &&
      "expr" in action.value &&
      typeof action.value.expr === "string" &&
      action.value.expr.includes("./live-transports/matrix/scenarios/scenario-runtime-"),
  );
  const callAction = actions.find(
    (action): action is { call: string; args?: unknown[] } =>
      typeof action === "object" &&
      action !== null &&
      "call" in action &&
      typeof action.call === "string" &&
      action.call.startsWith("scenarioModule."),
  );
  if (!importAction || !callAction) {
    throw new Error(`Matrix module flow is incomplete: ${scenario.id}`);
  }
  return { importAction, callAction };
}

describe("Matrix QA Lab scenario flows", () => {
  const catalog = readQaBootstrapScenarioCatalog();
  const scenarios = catalog.scenarios.filter((scenario) => {
    if (scenario.execution.kind !== "flow" || scenario.execution.channel !== "matrix") {
      return false;
    }
    return scenario.execution.flow?.steps.some((step) =>
      step.actions.some(
        (action) =>
          typeof action === "object" &&
          action !== null &&
          "set" in action &&
          action.set === "scenarioModule",
      ),
    );
  });

  it("expands every Matrix module call through the shared flow host", () => {
    const bindings = new Set<string>();
    expect(scenarios).toHaveLength(84);
    for (const scenario of scenarios) {
      expect(scenario.execution.kind, scenario.id).toBe("flow");
      if (scenario.execution.kind !== "flow") {
        continue;
      }
      const { importAction, callAction } = readModuleBinding(scenario);
      bindings.add(`${importAction.value.expr}:${callAction.call}`);
      if (scenario.id !== "matrix-allowlist-hot-reload") {
        expect(scenario.objective, scenario.id).toBe(scenario.title);
        expect(scenario.successCriteria, scenario.id).toEqual([
          `${scenario.title} completes successfully.`,
        ]);
      }
      expect(scenario.execution.channel, scenario.id).toBe("matrix");
      expect(scenario.execution.retryCount, scenario.id).toBe(0);
      expect(scenario.execution.flow?.steps.at(-1)?.detailsExpr, scenario.id).toBe(
        "result.details ?? (result.artifacts ? JSON.stringify(result.artifacts, null, 2) : undefined)",
      );
    }
    expect(bindings.size).toBe(84);
  });

  it("prepares the shared canary only for canary-dependent scenarios", () => {
    const canaryScenarioIds = new Set([
      "matrix-reaction-not-a-reply",
      "matrix-reaction-notification",
      "matrix-reaction-redaction-observed",
      "matrix-reaction-threaded",
      "matrix-voice-preflight-mention",
    ]);
    for (const scenario of scenarios) {
      const config = scenario.execution.config ?? {};
      expect(config.matrixRequireCanary === true, scenario.id).toBe(
        canaryScenarioIds.has(scenario.id),
      );
      expect(readModuleBinding(scenario).callAction.args).toEqual([{ expr: "scenarioContext" }]);
    }
  });

  it("leaves whole-flow deadlines unset for provider-budgeted scenarios", () => {
    const providerBudgetedScenarioIds = new Set([
      "matrix-e2ee-thread-follow-up",
      "matrix-inbound-edit-no-duplicate-trigger",
      "matrix-thread-nested-reply-shape",
    ]);
    const providerBudgetedScenarios = scenarios.filter((scenario) =>
      providerBudgetedScenarioIds.has(scenario.id),
    );

    expect(providerBudgetedScenarios.map((scenario) => scenario.id).toSorted()).toEqual(
      [...providerBudgetedScenarioIds].toSorted(),
    );
    for (const scenario of providerBudgetedScenarios) {
      expect(scenario.execution, scenario.id).not.toHaveProperty("timeoutMs");
    }
  });

  it("applies the portable thread override through Matrix flow preparation", () => {
    expect(readQaScenarioById("thread-reply-override").execution).toMatchObject({
      kind: "flow",
      channel: "matrix",
      timeoutMs: 60_000,
      retryCount: 0,
      config: {
        matrixConfigOverrides: {
          threadReplies: "always",
        },
      },
    });
  });

  it("isolates scenarios that assert fresh thread and DM session routing", () => {
    const expectedReasons = {
      "dm-shared-session": "pristine per-user DM session routing",
      "thread-isolation": "fresh session boundary",
      "thread-reply-override": "must not inherit an existing room session",
    } as const;

    for (const [scenarioId, reason] of Object.entries(expectedReasons)) {
      const execution = requireFlowScenario(readQaScenarioById(scenarioId)).execution;
      expect(execution.suiteIsolation, scenarioId).toBe("isolated");
      expect(execution.isolationReason, scenarioId).toContain(reason);
    }
  });

  it("isolates the homeserver restart from the shared Matrix sync streams", () => {
    expect(readQaScenarioById("matrix-homeserver-restart-resume").execution).toMatchObject({
      kind: "flow",
      channel: "matrix",
      suiteIsolation: "isolated",
      isolationReason:
        "Restarts the disposable homeserver process and its active Matrix sync streams.",
    });
  });

  it("isolates the DM thread override from session-scope bindings", () => {
    expect(readQaScenarioById("matrix-dm-thread-reply-override").execution).toMatchObject({
      kind: "flow",
      channel: "matrix",
      suiteIsolation: "isolated",
      isolationReason:
        "Asserts fresh DM native-thread routing after session-scope scenarios and cannot inherit their DM session binding.",
    });
  });

  it("isolates channel and DM approval fan-out from shared routing state", () => {
    expect(readQaScenarioById("matrix-approval-channel-target-both").execution).toMatchObject({
      kind: "flow",
      channel: "matrix",
      suiteIsolation: "isolated",
      isolationReason:
        "Asserts fresh channel and DM approval fan-out and cannot inherit shared Matrix approval routing state.",
    });
  });

  it("isolates only model-driven allowBots admission scenarios", () => {
    const isolatedScenarioIds = MATRIX_MENTION_GATE_PRIMARY_SCENARIOS.filter(
      (scenarioId) =>
        requireFlowScenario(readQaScenarioById(scenarioId)).execution.suiteIsolation === "isolated",
    );

    expect(isolatedScenarioIds).toEqual(MATRIX_ISOLATED_ALLOWBOTS_ADMISSION_SCENARIOS);
    for (const scenarioId of MATRIX_ISOLATED_ALLOWBOTS_ADMISSION_SCENARIOS) {
      expect(
        requireFlowScenario(readQaScenarioById(scenarioId)).execution.isolationReason,
        scenarioId,
      ).toContain("fresh model-driven configured-bot admission");
    }
  });

  it("runs the allowlist scenario through its config-file reload owner", () => {
    const scenario = catalog.scenarios.find((entry) => entry.id === "matrix-allowlist-hot-reload");
    expect(scenario?.execution.kind).toBe("flow");
    if (scenario?.execution.kind !== "flow") {
      return;
    }
    const { importAction, callAction } = readModuleBinding(scenario);
    expect(importAction.value.expr).toContain("scenario-runtime-config.js");
    expect(callAction).toEqual({
      call: "scenarioModule.runMatrixQaAllowlistHotReloadScenario",
      args: [{ expr: "scenarioContext" }],
      saveAs: "result",
    });
  });

  it("attributes Matrix admission and media evidence to behavior the flows execute", () => {
    for (const scenarioId of MATRIX_MENTION_GATE_PRIMARY_SCENARIOS) {
      expect(readQaScenarioById(scenarioId).coverage, scenarioId).toEqual({
        primary: ["matrix.mention-gates"],
      });
    }
    expect(readQaScenarioById("matrix-mxid-prefixed-command-block").coverage).toEqual({
      primary: ["matrix.mention-gates"],
      secondary: ["channels.channel-native-commands"],
    });
    expect(readQaScenarioById("matrix-unsupported-media-safe").coverage).toEqual({
      primary: ["channels.inbound-media-normalization"],
    });
  });

  it("loads the voice preflight provider and media overrides", () => {
    const scenario = readQaScenarioById("matrix-voice-preflight-mention");

    expect(scenario.execution).toMatchObject({
      kind: "flow",
      providerMode: "mock-openai",
      retryCount: 0,
      timeoutMs: 90_000,
    });
    expect(scenario.plugins).toEqual(["openai"]);
    expect(collectQaSuitePluginIds([scenario])).toEqual(["openai"]);
    expect(scenario.gatewayConfigPatch).toMatchObject({
      tools: {
        media: {
          models: [{ capabilities: ["audio"], model: "gpt-4o-transcribe", provider: "openai" }],
          audio: {
            echoTranscript: true,
            enabled: true,
            prompt: "MATRIX_QA_VOICE_PREFLIGHT_TRIGGER",
          },
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["matrix\\W+qa\\W+voice\\W+pre[ -]?flight\\W+ok(?:ay)?"],
        },
      },
    });
    expect(readQaScenarioExecutionConfig("matrix-voice-preflight-mention")).toMatchObject({
      matrixRequireCanary: true,
      matrixConfigOverrides: {
        mediaModels: [{ capabilities: ["audio"], model: "gpt-4o-transcribe", provider: "openai" }],
        audio: {
          echoTranscript: true,
          enabled: true,
          prompt: "MATRIX_QA_VOICE_PREFLIGHT_TRIGGER",
        },
        groupMentionPatterns: ["matrix\\W+qa\\W+voice\\W+pre[ -]?flight\\W+ok(?:ay)?"],
      },
    });
  });

  it("loads the generated-image provider and model selection", () => {
    const scenario = readQaScenarioById("matrix-room-generated-image-delivery");
    expect(scenario.plugins).toEqual(["openai"]);
    expect(scenario.gatewayConfigPatch).toMatchObject({
      agents: {
        defaults: {
          mediaModels: {
            image: {
              primary: "openai/gpt-image-1",
            },
          },
        },
      },
    });
  });

  it("configures image generation before the single generated-image flow call", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("matrix-room-generated-image-delivery"),
    );
    const actions = scenario.execution.flow?.steps[0]?.actions ?? [];

    expect(scenario.execution).toMatchObject({
      channel: "matrix",
      retryCount: 0,
      timeoutMs: 180_000,
      config: {
        requiredChannelDriver: "live",
      },
    });
    expect(actions).toEqual([
      {
        call: "ensureImageGenerationConfigured",
        args: [{ ref: "env" }],
      },
      {
        set: "scenarioModule",
        value: {
          expr: "await qaImport('./live-transports/matrix/scenarios/scenario-runtime-media.js')",
        },
      },
      {
        call: "scenarioModule.runGeneratedImageDeliveryScenario",
        args: [{ expr: "scenarioContext" }],
        saveAs: "result",
      },
    ]);
  });
});
