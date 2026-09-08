import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { cleanDeferredFinalText } from "../../tts/captioned-final.js";
import type { PrepareDispatchExecutionReadyState } from "./dispatch-from-config.prepare-execution.js";

/** Sends the deferred block text when execution exits before normal finalization. */
export async function flushDispatchDeferredFinalText(params: {
  deferFinalTtsText: boolean;
  isHeartbeat: boolean;
  state: PrepareDispatchExecutionReadyState;
}): Promise<boolean> {
  try {
    if (!params.deferFinalTtsText || params.isHeartbeat) {
      return false;
    }
    const deferredVisibleText = params.state.cleanBlockTtsDirectiveText
      ? cleanDeferredFinalText(params.state.progressState.accumulatedBlockTtsText)
      : params.state.progressState.accumulatedBlockText;
    if (!deferredVisibleText.trim()) {
      return false;
    }
    const fallback = await params.state.sendFinalPayload(
      { text: deferredVisibleText },
      { abortSignal: params.state.isDispatchOperationAborted() ? false : undefined, skipTts: true },
    );
    if (!fallback.queuedFinal && fallback.routedFinalCount === 0) {
      return false;
    }
    params.state.progressState.accumulatedBlockText = "";
    params.state.progressState.accumulatedBlockTtsText = "";
    return true;
  } catch (error) {
    // Recovery must not replace the original resolver or cancellation outcome.
    logVerbose(
      `dispatch-from-config: deferred final text fallback failed: ${formatErrorMessage(error)}`,
    );
    return false;
  }
}
