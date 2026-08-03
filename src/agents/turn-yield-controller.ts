import {
  normalizeTurnYieldMessage,
  runWithTurnYieldUnavailable,
  type PluginTurnYieldCommitter,
} from "../plugins/runtime/tool-yield-context.js";

type TurnYieldHandler = (message: string) => Promise<void> | void;

export type TurnYieldController = PluginTurnYieldCommitter;

/** Creates one durable, first-request-wins yield operation for an agent turn. */
export function createTurnYieldController(params: {
  sessionId?: string;
  requesterSessionKey?: string;
  requesterTurnRunId?: string;
  onYield?: TurnYieldHandler;
}): TurnYieldController {
  const sessionId = params.sessionId?.trim();
  const requesterSessionKey = params.requesterSessionKey?.trim();
  const requesterTurnRunId = params.requesterTurnRunId?.trim();
  const onYield = params.onYield;
  const supported = Boolean(sessionId && onYield);
  let commitPromise: Promise<void> | undefined;

  return {
    supported,
    commit(requestedMessage) {
      if (commitPromise) {
        return commitPromise;
      }
      if (!supported || !onYield) {
        return Promise.reject(new Error("Turn yield is not supported by this runtime."));
      }
      const message = normalizeTurnYieldMessage(requestedMessage);
      commitPromise = (async () => {
        if (requesterSessionKey && requesterTurnRunId) {
          const { markRequesterTurnYielded } = await import("./subagent-registry.js");
          markRequesterTurnYielded({ requesterSessionKey, requesterTurnRunId });
        }
        await runWithTurnYieldUnavailable(async () => await onYield(message));
      })();
      return commitPromise;
    },
  };
}
