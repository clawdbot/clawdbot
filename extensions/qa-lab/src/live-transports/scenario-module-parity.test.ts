import { describe, expect, it } from "vitest";
import { readQaScenarioPack, type QaSeedScenarioWithSource } from "../scenario-catalog.js";
import * as discordScenarioRuntime from "./discord/scenario-runtime.js";
import * as slackScenarioRuntime from "./slack/scenario-runtime.js";
import * as whatsappScenarioRuntime from "./whatsapp/scenario-runtime.js";

const LANES = [
  {
    channel: "discord",
    contextExpression: "discordScenarioContext",
    modulePath: "./live-transports/discord/scenario-runtime.js",
    runnerName: "runDiscordScenario",
    runtime: discordScenarioRuntime,
  },
  {
    channel: "slack",
    contextExpression: "slackScenarioContext",
    modulePath: "./live-transports/slack/scenario-runtime.js",
    runnerName: "runSlackScenario",
    runtime: slackScenarioRuntime,
  },
  {
    channel: "whatsapp",
    contextExpression: "whatsappScenarioContext",
    modulePath: "./live-transports/whatsapp/scenario-runtime.js",
    runnerName: "runWhatsAppScenario",
    runtime: whatsappScenarioRuntime,
  },
] as const;

type ScenarioModuleCall = {
  args?: unknown[];
  call: string;
};

function readScenarioModuleCall(
  scenario: QaSeedScenarioWithSource,
  modulePath: string,
): ScenarioModuleCall | undefined {
  if (scenario.execution.kind !== "flow" || !scenario.execution.flow) {
    return undefined;
  }
  const actions = scenario.execution.flow.steps.flatMap((step) => step.actions);
  const importExpression = `await qaImport(${JSON.stringify(modulePath)})`;
  const importsModule = actions.some(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      "set" in action &&
      action.set === "scenarioModule" &&
      "value" in action &&
      typeof action.value === "object" &&
      action.value !== null &&
      "expr" in action.value &&
      action.value.expr === importExpression,
  );
  if (!importsModule) {
    return undefined;
  }
  const callPrefix = "scenarioModule.";
  const callAction = actions.find(
    (action): action is ScenarioModuleCall =>
      typeof action === "object" &&
      action !== null &&
      "call" in action &&
      typeof action.call === "string" &&
      action.call.startsWith(callPrefix),
  );
  if (!callAction) {
    throw new Error(`scenario module flow has no call: ${scenario.id}`);
  }
  return { ...callAction, call: callAction.call.slice(callPrefix.length) };
}

function readExpression(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "expr" in value &&
    typeof value.expr === "string"
    ? value.expr
    : undefined;
}

describe("live transport scenario module routing", () => {
  it.each(LANES)(
    "routes every $channel flow through one shared channel runner",
    ({ channel, contextExpression, modulePath, runnerName, runtime }) => {
      expect(Reflect.get(runtime, runnerName)).toBeTypeOf("function");

      const bindings = readQaScenarioPack().scenarios.flatMap((scenario) => {
        if (scenario.execution.kind !== "flow" || scenario.execution.channel !== channel) {
          return [];
        }
        const call = readScenarioModuleCall(scenario, modulePath);
        return call ? [{ call, scenarioId: scenario.id }] : [];
      });

      for (const { call, scenarioId } of bindings) {
        expect(call.call, scenarioId).toBe(runnerName);
        expect(call.args, scenarioId).toHaveLength(2);
        expect(readExpression(call.args?.[0]), scenarioId).toBe(contextExpression);

        const implementationExpression = readExpression(call.args?.[1]);
        const match = implementationExpression?.match(/^scenarioModule\["(\w+)"\]$/);
        expect(match, scenarioId).toBeTruthy();
        expect(Reflect.get(runtime, match?.[1] ?? ""), scenarioId).toBeTypeOf("object");
      }
    },
  );
});
