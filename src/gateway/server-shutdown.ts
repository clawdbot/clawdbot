import { formatErrorMessage } from "../infra/errors.js";
import { markGatewayRestartTrace, measureGatewayRestartTrace } from "./restart-trace.js";

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
      // Trace consumers parse one phase token; keep the human label for errors.
      const phase = `shutdown.${step.name.replace(/\s+/gu, "-")}`;
      markGatewayRestartTrace(`${phase}.begin`);
      await measureGatewayRestartTrace(phase, () => step.run());
    } catch (error) {
      params.onError(`shutdown step failed (${step.name}): ${formatErrorMessage(error)}`);
    }
  }
}
