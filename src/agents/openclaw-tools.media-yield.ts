import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";

const log = createSubsystemLogger("agents/tools/media-generation-yield");

export function createMediaGenerationAsyncStartCallback(params: {
  sessionKey?: string;
  onYield?: (message: string) => Promise<void> | void;
}): ((message: string) => void) | undefined {
  if (!params.onYield || (params.sessionKey && isCronRunSessionKey(params.sessionKey))) {
    return undefined;
  }
  return (message) => {
    setImmediate(() => {
      void (async () => params.onYield?.(message))().catch((error: unknown) => {
        log.warn("Failed to yield foreground media generation turn", {
          error: formatErrorMessage(error),
        });
      });
    });
  };
}
