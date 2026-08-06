import type { MockFixture, MockFixturePlan } from "./mock-fixtures.js";

function fixture(
  id: string,
  match: MockFixture["match"],
  respond: MockFixture["respond"],
): MockFixture {
  return { id, match, respond };
}
// Ordered scenario fixtures for the QA Lab mock Responses provider.
import * as contract from "./mock-openai-contracts.js";
import {
  buildQaA2aMessageToolMirrorSessionsSendArgs,
  extractBlockStreamingMarkerDirectives,
  extractExactMarkerDirective,
  extractExactReplyDirective,
  extractSessionStatusSessionKey,
  extractWhatsAppContactMarkerDirective,
  extractWhatsAppLocationMarkerDirective,
  extractWhatsAppStickerMarkerDirective,
  hasToolErrorOutput,
  shouldUseWhatsAppContactMarker,
  shouldUseWhatsAppLocationMarker,
  shouldUseWhatsAppStickerMarker,
} from "./mock-openai-directives.js";
import { splitMockStreamingText } from "./mock-openai-events.js";
import { extractSlackMpimRetainedBotNonce } from "./mock-openai-input.js";
import { execCommandFromToolProgressPrompt, readTargetFromPrompt } from "./mock-openai-tooling.js";

const reply = (text: string): MockFixturePlan => ({ kind: "reply", text });
const tool = (name: string, args: Record<string, unknown>, raw = false): MockFixturePlan => ({
  kind: "tool",
  name,
  args,
  ...(raw ? { raw: true } : {}),
});
const stream = (
  id: string,
  text: string,
  streamText = text,
  phase: "commentary" | "final_answer" = "final_answer",
): MockFixturePlan => ({
  kind: "stream",
  message: { id, phase, streamDeltas: splitMockStreamingText(streamText), text },
});

export const MOCK_OPENAI_FIXTURES_DELIVERY: readonly MockFixture[] = [
  fixture(
    "slack-chart",
    (context) => contract.QA_SLACK_CHART_PRESENTATION_PROMPT_RE.test(context.allInputText),
    (context) => {
      const match = contract.QA_SLACK_CHART_PRESENTATION_PROMPT_RE.exec(context.allInputText);
      if (!match?.[1] || !match[2]) {
        return undefined;
      }
      if (!context.hasCompletedToolOutput && context.hasDeclaredTool("message")) {
        return tool("message", {
          action: "send",
          message: match[1],
          presentation: {
            blocks: [
              {
                type: "chart",
                chartType: "line",
                title: "QA latency trend",
                categories: ["P50", "P95"],
                series: [{ name: "Latency", values: [120, 240] }],
                xLabel: "Percentile",
                yLabel: "Milliseconds",
              },
            ],
          },
        });
      }
      return context.hasCompletedToolOutput ? reply(match[2]) : undefined;
    },
  ),
  fixture(
    "whatsapp-react",
    (context) =>
      contract.QA_WHATSAPP_AGENT_MESSAGE_ACTION_REACT_PROMPT_RE.test(context.allInputText),
    (context) =>
      !context.hasCompletedToolOutput && context.hasDeclaredTool("message")
        ? tool("message", { action: "react", emoji: "👍" })
        : context.hasCompletedToolOutput
          ? reply("")
          : undefined,
  ),
  fixture(
    "whatsapp-upload",
    (context) =>
      Boolean(
        contract.QA_WHATSAPP_AGENT_MESSAGE_ACTION_UPLOAD_PROMPT_RE.exec(context.allInputText)?.[1],
      ),
    (context) => {
      const caption = contract.QA_WHATSAPP_AGENT_MESSAGE_ACTION_UPLOAD_PROMPT_RE.exec(
        context.allInputText,
      )?.[1];
      if (!caption) {
        return undefined;
      }
      return !context.hasCompletedToolOutput && context.hasDeclaredTool("message")
        ? tool("message", {
            action: "upload-file",
            buffer: contract.TINY_PNG_BASE64,
            caption,
            contentType: "image/png",
            filename: "whatsapp-qa-agent-upload.png",
          })
        : context.hasCompletedToolOutput
          ? reply("")
          : undefined;
    },
  ),
  fixture(
    "telegram-single-marker-stream",
    (context) =>
      contract.QA_STREAMING_PROMPT_RE.test(context.allInputText) &&
      context.allInputText.includes(contract.QA_TELEGRAM_STREAM_SINGLE_MARKER),
    () => stream("msg_mock_telegram_quiet_stream", contract.QA_TELEGRAM_STREAM_SINGLE_MARKER),
  ),
  fixture(
    "final-only-marker-stream",
    (context) =>
      contract.QA_FINAL_ONLY_MARKER_STREAMING_PROMPT_RE.test(context.scenarioFamilyPrompt) &&
      Boolean(context.scenarioFamilyReplyDirective),
    (context) =>
      stream(
        "msg_mock_final_only_marker_stream",
        context.scenarioFamilyReplyDirective ?? "",
        "QA streaming preview in progress",
      ),
  ),
  fixture(
    "quiet-stream",
    (context) =>
      contract.QA_STREAMING_PROMPT_RE.test(context.scenarioFamilyPrompt) &&
      Boolean(context.scenarioFamilyReplyDirective),
    (context) => stream("msg_mock_quiet_stream", context.scenarioFamilyReplyDirective ?? ""),
  ),
  fixture(
    "slack-progress",
    (context) => Boolean(context.slackProgressDirectives),
    (context) => {
      const directives = context.slackProgressDirectives;
      if (!directives) {
        return undefined;
      }
      if (context.hasSlackProgressToolOutput) {
        return stream("msg_mock_slack_progress_final", directives.finalMarker);
      }
      return context.hasDeclaredTool("exec")
        ? {
            kind: "assistant-tool",
            message: {
              id: "msg_mock_slack_progress_commentary",
              phase: "commentary",
              streamDeltas: splitMockStreamingText(directives.commentaryMarker),
              text: directives.commentaryMarker,
            },
            tool: { name: "exec", args: { command: directives.execCommand } },
          }
        : undefined;
    },
  ),
  fixture(
    "tool-progress-error",
    (context) => contract.QA_TOOL_PROGRESS_ERROR_PROMPT_RE.test(context.scenarioFamilyPrompt),
    (context) => {
      if (!context.toolProgressToolOutput) {
        return tool("read", { path: readTargetFromPrompt(context.scenarioFamilyPrompt) });
      }
      const directive =
        extractExactReplyDirective(context.toolProgressToolOutput) ??
        extractExactMarkerDirective(context.toolProgressToolOutput) ??
        context.scenarioFamilyReplyDirective;
      return directive
        ? reply(
            hasToolErrorOutput(context.toolProgressToolJson, context.toolProgressToolOutput)
              ? directive
              : "BUG-TOOL-DID-NOT-FAIL",
          )
        : undefined;
    },
  ),
  fixture(
    "tool-progress",
    (context) => contract.QA_TOOL_PROGRESS_PROMPT_RE.test(context.scenarioFamilyPrompt),
    (context) => {
      if (!context.toolProgressToolOutput) {
        const command = execCommandFromToolProgressPrompt(context.scenarioFamilyPrompt);
        return command
          ? tool("exec", { command })
          : tool("read", { path: readTargetFromPrompt(context.scenarioFamilyPrompt) });
      }
      const directive =
        extractExactReplyDirective(context.toolProgressToolOutput) ??
        extractExactMarkerDirective(context.toolProgressToolOutput) ??
        context.scenarioFamilyReplyDirective;
      return directive ? reply(directive) : undefined;
    },
  ),
  fixture(
    "block-streaming",
    (context) =>
      contract.QA_BLOCK_STREAMING_PROMPT_RE.test(context.scenarioFamilyPrompt) &&
      Boolean(extractBlockStreamingMarkerDirectives(context.blockStreamingPrompt)),
    (context) => {
      const markers = extractBlockStreamingMarkerDirectives(context.blockStreamingPrompt);
      if (!markers) {
        return undefined;
      }
      return !context.hasCompletedToolOutput
        ? {
            kind: "assistant-tool",
            message: {
              id: "msg_mock_block_1",
              phase: "final_answer",
              streamDeltas: splitMockStreamingText(markers.first),
              text: markers.first,
            },
            tool: {
              name: "read",
              args: { path: readTargetFromPrompt(context.blockStreamingPrompt) },
            },
          }
        : stream("msg_mock_block_2", markers.second);
    },
  ),
  fixture(
    "stranded-retry-failure",
    (context) => contract.isStrandedFinalRetryFailureRequest(context.allInputText),
    () => reply(contract.buildStrandedFinalRetryFailureText()),
  ),
  fixture(
    "stranded-final-recovery",
    (context) => contract.QA_STRANDED_FINAL_RECOVERY_PROMPT_RE.test(context.allInputText),
    (context) => {
      if (!contract.QA_STRANDED_FINAL_RETRY_PROMPT_RE.test(context.allInputText)) {
        return reply(contract.buildStrandedFinalRecoveryText());
      }
      return !context.hasCompletedToolOutput && context.hasDeclaredTool("message")
        ? tool("message", { action: "send", message: contract.buildStrandedFinalRecoveryText() })
        : reply("");
    },
  ),
  fixture(
    "a2a-message-mirror",
    (context) => contract.QA_A2A_MESSAGE_TOOL_MIRROR_PROMPT_RE.test(context.prompt),
    (context) => {
      if (context.hasCompletedToolOutput) {
        return reply("");
      }
      const args = buildQaA2aMessageToolMirrorSessionsSendArgs(context.prompt);
      return args && context.hasDeclaredTool("sessions_send")
        ? tool("sessions_send", args)
        : undefined;
    },
  ),
  fixture(
    "group-visible-reply",
    (context) => contract.QA_GROUP_VISIBLE_REPLY_TOOL_PROMPT_RE.test(context.allInputText),
    (context) => {
      const marker =
        context.exactMarkerDirective ?? context.exactReplyDirective ?? "QA-GROUP-TOOL-OK";
      return !context.hasCompletedToolOutput && context.hasDeclaredTool("message")
        ? tool("message", { action: "send", message: marker })
        : reply("");
    },
  ),
  fixture(
    "msteams-thread-dedupe",
    (context) => contract.QA_MSTEAMS_THREAD_DEDUPE_PROMPT_RE.test(context.allInputText),
    (context) => {
      const marker =
        context.exactMarkerDirective ??
        context.exactReplyDirective ??
        "QA-MSTEAMS-THREAD-DEDUPE-OK";
      const target = /msteams message target:\s*`([^`]+)`/iu.exec(context.prompt)?.[1]?.trim();
      return !context.hasCompletedToolOutput && context.hasDeclaredTool("message")
        ? tool("message", { action: "send", message: marker, ...(target ? { target } : {}) })
        : reply(marker);
    },
  ),
  fixture(
    "group-message-unavailable",
    (context) =>
      contract.QA_GROUP_MESSAGE_UNAVAILABLE_FALLBACK_PROMPT_RE.test(context.allInputText),
    (context) =>
      reply(context.exactMarkerDirective ?? context.exactReplyDirective ?? "QA-GROUP-FALLBACK-OK"),
  ),
  fixture(
    "whatsapp-location-marker",
    (context) =>
      shouldUseWhatsAppLocationMarker(context.prompt) &&
      Boolean(extractWhatsAppLocationMarkerDirective(context.allInputText)),
    (context) => reply(extractWhatsAppLocationMarkerDirective(context.allInputText)),
  ),
  fixture(
    "whatsapp-contact-marker",
    (context) =>
      shouldUseWhatsAppContactMarker(context.prompt) &&
      Boolean(extractWhatsAppContactMarkerDirective(context.allInputText)),
    (context) => reply(extractWhatsAppContactMarkerDirective(context.allInputText)),
  ),
  fixture(
    "whatsapp-sticker-marker",
    (context) =>
      shouldUseWhatsAppStickerMarker(context.prompt) &&
      Boolean(extractWhatsAppStickerMarkerDirective(context.allInputText)),
    (context) => reply(extractWhatsAppStickerMarkerDirective(context.allInputText)),
  ),
  fixture(
    "slack-mpim-recall",
    (context) => contract.QA_SLACK_MPIM_HISTORY_RECALL_PROMPT_RE.test(context.prompt),
    (context) => {
      const match = contract.QA_SLACK_MPIM_HISTORY_RECALL_PROMPT_RE.exec(context.prompt);
      if (!match) {
        return undefined;
      }
      const [, botReplyPrefix, recalledMarker, missingMarker] = match;
      const nonce = botReplyPrefix
        ? extractSlackMpimRetainedBotNonce(context.prompt, botReplyPrefix)
        : undefined;
      return reply(nonce && recalledMarker ? `${recalledMarker}_${nonce}` : (missingMarker ?? ""));
    },
  ),
  fixture(
    "slack-mpim-seed",
    (context) => Boolean(contract.QA_SLACK_MPIM_HISTORY_SEED_PROMPT_RE.exec(context.prompt)?.[1]),
    (context) =>
      reply(
        contract.buildSlackMpimHistoryBotReply(
          contract.QA_SLACK_MPIM_HISTORY_SEED_PROMPT_RE.exec(context.prompt)?.[1] ?? "",
        ),
      ),
  ),
  fixture(
    "prompt-exact-marker",
    (context) =>
      contract.QA_EXACT_MARKER_PROMPT_RE.test(context.prompt) &&
      Boolean(context.promptExactMarkerDirective),
    (context) => reply(context.promptExactMarkerDirective ?? ""),
  ),
  fixture(
    "prompt-exact-reply",
    (context) =>
      contract.QA_EXACT_MARKER_PROMPT_RE.test(context.prompt) &&
      Boolean(context.promptExactReplyDirective),
    (context) => reply(context.promptExactReplyDirective ?? ""),
  ),
  fixture(
    "telegram-current-session-status",
    (context) =>
      contract.QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE.test(context.prompt) ||
      (context.hasCompletedToolOutput &&
        contract.QA_TELEGRAM_CURRENT_SESSION_STATUS_PROMPT_RE.test(context.allInputText)),
    (context) => {
      if (!context.hasCompletedToolOutput && context.hasDeclaredTool("session_status")) {
        return tool("session_status", { sessionKey: "current" });
      }
      const sessionKey = extractSessionStatusSessionKey(context.toolJson, context.toolOutput);
      return reply(
        sessionKey.includes(":telegram:group:")
          ? `QA-TELEGRAM-CURRENT-SESSION-OK ${sessionKey}`
          : `QA-TELEGRAM-CURRENT-SESSION-BAD ${sessionKey || "missing-session-key"}`,
      );
    },
  ),
  fixture(
    "history-prompt-exact-reply",
    (context) =>
      contract.QA_EXACT_MARKER_PROMPT_RE.test(context.allInputText) &&
      Boolean(context.promptExactReplyDirective),
    (context) => reply(context.promptExactReplyDirective ?? ""),
  ),
  fixture(
    "history-user-exact-marker",
    (context) =>
      contract.QA_EXACT_MARKER_PROMPT_RE.test(context.allInputText) &&
      Boolean(context.userExactMarkerDirective),
    (context) => reply(context.userExactMarkerDirective ?? ""),
  ),
  fixture(
    "history-user-exact-reply",
    (context) =>
      contract.QA_EXACT_MARKER_PROMPT_RE.test(context.allInputText) &&
      Boolean(context.userExactReplyDirective),
    (context) => reply(context.userExactReplyDirective ?? ""),
  ),
] as const;
