import type { createMattermostDraftStream } from "./draft-stream.js";
import {
  formatMattermostTerminalProgressText,
  pinMattermostProgressLabel,
} from "./monitor-context.js";

type SeparateProgressDraft = Pick<
  ReturnType<typeof createMattermostDraftStream>,
  "retainTerminalText"
>;

export function createMattermostSeparateProgressController(params: {
  enabled: boolean;
  pinnedLabel?: string;
  draftStream: SeparateProgressDraft;
  logVerboseMessage: (message: string) => void;
}) {
  let terminalProgressPromise: Promise<void> | undefined;

  const markFailed = async () => {
    if (!params.enabled) {
      return;
    }
    if (!terminalProgressPromise) {
      terminalProgressPromise = params.draftStream
        .retainTerminalText(formatMattermostTerminalProgressText(params.pinnedLabel))
        .then(() => {});
    }
    const attempt = terminalProgressPromise;
    try {
      await attempt;
    } catch (error) {
      if (terminalProgressPromise === attempt) {
        terminalProgressPromise = undefined;
      }
      throw error;
    }
  };

  const prepareFinal = async (isError: boolean) => {
    if (!params.enabled || !isError) {
      return;
    }
    try {
      await markFailed();
    } catch (error) {
      params.logVerboseMessage(`mattermost terminal progress update failed: ${String(error)}`);
    }
  };

  const settleFinal = async (result: { visibleReplySent: boolean }, isError: boolean) => {
    if (!params.enabled || (result.visibleReplySent && !isError)) {
      return;
    }
    try {
      await markFailed();
    } catch (error) {
      if (!result.visibleReplySent) {
        throw error;
      }
      params.logVerboseMessage(
        `mattermost terminal progress retry failed after visible final: ${String(error)}`,
      );
    }
  };

  const settleTurnError = async () => {
    if (!params.enabled) {
      return;
    }
    try {
      await markFailed();
    } catch (error) {
      params.logVerboseMessage(`mattermost terminal progress update failed: ${String(error)}`);
    }
  };

  return {
    formatDraft: (text: string) =>
      params.enabled ? pinMattermostProgressLabel(text, params.pinnedLabel) : text,
    startReasoningImmediately: params.enabled,
    prepareFinal,
    settleFinal,
    settleTurnError,
  };
}
