import type {
  createRuntimeConfigWriteApplication,
  RuntimeConfigWriteApplicationStatus,
} from "../../config/runtime-write-application.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import type {
  ActivateSetupInferenceParams,
  ActivateSetupInferenceResult,
} from "../../system-agent/setup-inference.js";

const SYSTEM_AGENT_GATEWAY_EXECUTION_KEY = "gateway";
const systemAgentGatewayExecutionQueue = new KeyedAsyncQueue();

export async function runSystemAgentGatewayTask<T>(task: () => Promise<T>): Promise<T> {
  // Track every accepted RPC as active, never queued: restart draining snapshots
  // active ids, so a queued OpenClaw request could otherwise outlive its socket.
  setCommandLaneConcurrency(CommandLane.SystemAgent, Number.MAX_SAFE_INTEGER);
  return await enqueueCommandInLane(CommandLane.SystemAgent, () =>
    // Bound expensive detection, activation, and agent turns without hiding
    // accepted work from restart draining. This also makes session eviction and
    // setup writes atomic with respect to other OpenClaw gateway requests.
    systemAgentGatewayExecutionQueue.enqueue(SYSTEM_AGENT_GATEWAY_EXECUTION_KEY, task),
  );
}

export async function activateGatewaySetupInference(
  params: Omit<ActivateSetupInferenceParams, "onRuntimeApplication">,
): Promise<ActivateSetupInferenceResult> {
  let application: ReturnType<typeof createRuntimeConfigWriteApplication> | undefined;
  let applied: RuntimeConfigWriteApplicationStatus | undefined;
  let result: ActivateSetupInferenceResult;
  try {
    result = await runSystemAgentGatewayTask(async () => {
      const { activateSetupInference } = await import("../../system-agent/setup-inference.js");
      return activateSetupInference({
        ...params,
        onRuntimeApplication: (receipt) => {
          application = receipt;
        },
      });
    });
  } finally {
    // Release setup's queue and command lane before waiting: reload drains those lanes.
    // The admitted RPC (or retained wizard) keeps its root alive through publication.
    if (application) {
      applied = application.claimed ? await application.result : "unclaimed";
    }
  }
  if (!result.ok || applied === undefined || applied === "applied") {
    return result;
  }
  if (applied === "applied-restart-required" || applied === "restart-pending") {
    return { ...result, gatewayRestartRequired: true };
  }
  const error =
    applied === "superseded"
      ? "AI access was saved, but newer settings replaced it before activation finished. Review Model Setup and try again."
      : "AI access was saved, but the Gateway could not apply it. Restart the Gateway before chatting.";
  // Structured probe rejections permit automatic setup to try another candidate.
  // A saved choice must stop that fallback when its application is incomplete.
  throw new Error(error);
}
