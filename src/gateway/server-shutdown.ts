import { formatErrorMessage } from "../infra/errors.js";

type GatewayShutdownStep = {
  name: string;
  run: () => Promise<void> | void;
};

/** Run every shutdown step even when one owner fails, with the failed owner named. */
export async function runGatewayShutdownSteps(params: {
  steps: readonly GatewayShutdownStep[];
  onError: (message: string) => void;
}): Promise<void> {
  for (const step of params.steps) {
    try {
      await step.run();
    } catch (error) {
      params.onError(`shutdown step failed (${step.name}): ${formatErrorMessage(error)}`);
    }
  }
}
