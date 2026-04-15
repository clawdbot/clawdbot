import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaTransportActionName, QaTransportState } from "./qa-transport.js";

export type QaScenarioStepContext = {
  state: QaTransportState;
  performAction?: (
    action: QaTransportActionName,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
};

export type QaScenarioStep = {
  name: string;
  run: (ctx: QaScenarioStepContext) => Promise<string | void>;
};

export type QaScenarioDefinition = {
  name: string;
  steps: QaScenarioStep[];
};

export type QaScenarioStepResult = {
  name: string;
  status: "pass" | "fail";
  details?: string;
};

export type QaScenarioResult = {
  name: string;
  status: "pass" | "fail";
  steps: QaScenarioStepResult[];
  details?: string;
};

export async function runQaScenario(
  definition: QaScenarioDefinition,
  ctx: QaScenarioStepContext,
): Promise<QaScenarioResult> {
  const steps: QaScenarioStepResult[] = [];

  for (const step of definition.steps) {
    try {
      const details = await step.run(ctx);
      steps.push({
        name: step.name,
        status: "pass",
        ...(details ? { details } : {}),
      });
    } catch (error) {
      const details = formatErrorMessage(error);
      steps.push({
        name: step.name,
        status: "fail",
        details,
      });
      return {
        name: definition.name,
        status: "fail",
        steps,
        details,
      };
    }
  }

  return {
    name: definition.name,
    status: "pass",
    steps,
  };
}
