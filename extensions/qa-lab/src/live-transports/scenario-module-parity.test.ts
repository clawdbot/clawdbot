import { describe, expect, it } from "vitest";
import { readQaScenarioPack, type QaSeedScenarioWithSource } from "../scenario-catalog.js";
import * as discordScenarioRuntime from "./discord/scenario-runtime.js";
import * as slackScenarioRuntime from "./slack/scenario-runtime.js";
import * as whatsappScenarioRuntime from "./whatsapp/scenario-runtime.js";

const LANES = [
  {
    channel: "discord",
    modulePath: "./live-transports/discord/scenario-runtime.js",
    runtime: discordScenarioRuntime,
  },
  {
    channel: "slack",
    modulePath: "./live-transports/slack/scenario-runtime.js",
    runtime: slackScenarioRuntime,
  },
  {
    channel: "whatsapp",
    modulePath: "./live-transports/whatsapp/scenario-runtime.js",
    runtime: whatsappScenarioRuntime,
  },
] as const;

function readScenarioModuleCallName(
  scenario: QaSeedScenarioWithSource,
  modulePath: string,
): string | undefined {
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
    (action): action is { call: string } =>
      typeof action === "object" &&
      action !== null &&
      "call" in action &&
      typeof action.call === "string" &&
      action.call.startsWith(callPrefix),
  );
  if (!callAction) {
    throw new Error(`scenario module flow has no call: ${scenario.id}`);
  }
  return callAction.call.slice(callPrefix.length);
}

describe("live transport scenario module parity", () => {
  it.each(LANES)(
    "keeps $channel scenario definitions and runtime exports in one-to-one parity",
    ({ channel, modulePath, runtime }) => {
      const bindings = readQaScenarioPack().scenarios.flatMap((scenario) => {
        if (scenario.execution.kind !== "flow" || scenario.execution.channel !== channel) {
          return [];
        }
        const callName = readScenarioModuleCallName(scenario, modulePath);
        return callName ? [{ callName, scenarioId: scenario.id }] : [];
      });
      const callNames = bindings.map(({ callName, scenarioId }) => {
        expect(Reflect.get(runtime, callName), scenarioId).toBeTypeOf("function");
        return callName;
      });

      expect(new Set(callNames).size).toBe(callNames.length);
      expect(callNames.toSorted()).toEqual(Object.keys(runtime).toSorted());
    },
  );
});
