import { isIntermediateAssistantTranscriptMessage } from "../agents/embedded-agent-runner/message-visibility.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../agents/harness/transcript-visibility.js";
import type { PrepareAssistantTranscriptMessage } from "../config/sessions/transcript-assistant-delivery.js";

// Spoken transcripts own the final Chat answer. Keep the consult's answer in
// audit/model history without hiding tool work, progress, or interrupted replies.
export const prepareTalkAgentConsultTranscript: PrepareAssistantTranscriptMessage = (message) =>
  projectAgentHarnessTranscriptMessageForDisplay({
    hidden:
      message.stopReason === "stop" &&
      !isIntermediateAssistantTranscriptMessage(message) &&
      !message.content.some((block) => block.type === "toolCall"),
    message,
  });
