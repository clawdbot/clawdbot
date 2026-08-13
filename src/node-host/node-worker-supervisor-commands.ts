import {
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
} from "../infra/node-commands.js";
import {
  parseNodeWorkerCancelInput,
  parseNodeWorkerLaunchInput,
  parseNodeWorkerLookupInput,
  projectNodeWorkerSupervisorReceipt,
  type NodeWorkerSupervisorControl,
  type NodeWorkerSupervisorReceipt,
} from "./node-worker-supervisor-contract.js";

type NodeWorkerSupervisorCommandResult =
  | { handled: false }
  | { handled: true; ok: true; payload: NodeWorkerSupervisorReceipt | null }
  | { handled: true; ok: false; code: "INVALID_REQUEST" | "UNAVAILABLE"; message: string };

/** Dispatches the non-advertised worker control contract before public node commands. */
export async function invokeNodeWorkerSupervisorCommand(params: {
  command: string;
  paramsJSON?: string | null;
  supervisor?: NodeWorkerSupervisorControl;
}): Promise<NodeWorkerSupervisorCommandResult> {
  const recognized =
    params.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND ||
    params.command === NODE_WORKER_SUPERVISOR_STATUS_COMMAND ||
    params.command === NODE_WORKER_SUPERVISOR_CANCEL_COMMAND;
  if (!recognized) {
    return { handled: false };
  }
  if (!params.supervisor) {
    return {
      handled: true,
      ok: false,
      code: "UNAVAILABLE",
      message: "node worker supervisor unavailable",
    };
  }
  try {
    const receipt =
      params.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND
        ? await params.supervisor.launch(parseNodeWorkerLaunchInput(params.paramsJSON))
        : params.command === NODE_WORKER_SUPERVISOR_STATUS_COMMAND
          ? await params.supervisor.status(parseNodeWorkerLookupInput(params.paramsJSON).launchId)
          : await params.supervisor.cancel(parseNodeWorkerCancelInput(params.paramsJSON));
    return {
      handled: true,
      ok: true,
      payload: receipt ? projectNodeWorkerSupervisorReceipt(receipt) : null,
    };
  } catch (error) {
    const invalid = error instanceof Error && error.message.startsWith("INVALID_REQUEST:");
    return {
      handled: true,
      ok: false,
      code: invalid ? "INVALID_REQUEST" : "UNAVAILABLE",
      message: invalid ? error.message : "node worker supervisor command failed",
    };
  }
}
