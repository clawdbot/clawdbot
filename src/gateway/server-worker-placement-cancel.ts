import { SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS } from "../sessions/session-lifecycle-admission.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  createChatAbortOps,
} from "./server-methods/chat-abort-runtime.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

export type WorkerPlacementSessionWorkCancellation = (request: {
  sessionId: string;
  sessionKeys: readonly string[];
  agentId: string;
  assertCurrent: () => void;
  onCancellationStarted?: () => void;
}) => Promise<void>;

export async function cancelGatewayWorkerSessionWork(
  context: GatewayRequestContext,
  request: Parameters<WorkerPlacementSessionWorkCancellation>[0],
): Promise<void> {
  request.assertCurrent();
  let controllerDrain = Promise.resolve(true);
  const aborted = await abortChatRunsForSessionKeyWithPartials({
    context,
    ops: createChatAbortOps(context),
    sessionId: request.sessionId,
    sessionKey: request.sessionKeys[0]!,
    sessionKeyAliases: request.sessionKeys.slice(1),
    agentId: request.agentId,
    // The revalidated session lifecycle owns every run on this resource, just as
    // archive/delete do; these internal flags do not elevate the RPC caller.
    requester: { isAdmin: true },
    includeProtectedRuns: true,
    abortOrigin: "rpc",
    stopReason: "rpc",
    onCancellationStarted: request.onCancellationStarted,
    onControllerTargets: (targets) => {
      controllerDrain = waitForChatAbortControllerRemoval({
        entries: context.chatAbortControllers,
        targets,
        timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
      });
    },
  });
  if (aborted.unauthorized || !(await controllerDrain)) {
    throw new Error("Session cancellation did not persist before cloud worker stop");
  }
}
