import { Type } from "typebox";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { textToSpeech } from "../../tts/tts.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, readNumberParam, readStringParam } from "./common.js";

const TtsToolSchema = Type.Object({
  text: Type.String({ description: "Text to convert to speech." }),
  channel: Type.Optional(
    Type.String({ description: "Optional channel id to pick output format." }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Optional provider request timeout in milliseconds.",
      minimum: 1,
    }),
  ),
});

function readTtsTimeoutMs(args: Record<string, unknown>): number | undefined {
  const timeoutMs = readNumberParam(args, "timeoutMs", {
    integer: true,
    strict: true,
  });
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (timeoutMs <= 0) {
    throw new ToolInputError("timeoutMs must be a positive integer in milliseconds.");
  }
  return timeoutMs;
}

/**
 * Defuse reply-directive tokens inside spoken transcripts before they flow
 * through tool-result content. When verbose tool output is enabled,
 * `emitToolOutput` passes the content through `parseReplyDirectives`
 * (`src/media/parse.ts` / `src/utils/directive-tags.ts`), and unfiltered
 * `MEDIA:` or `[[audio_as_voice]]`-shaped tokens in the transcript would be
 * rewritten into actual media URLs and audio-as-voice flags. Insert a
 * zero-width word joiner so the regex patterns stop matching without
 * changing the visible text.
 */
function sanitizeTranscriptForToolContent(text: string): string {
  return text
    .replace(/^([^\S\r\n]*)MEDIA:/gim, "$1\u2060MEDIA:")
    .replace(/\[\[/g, "[\u2060[")
    .replace(/^([ \t]*)(`{3,})/gm, (_match, indent: string, fence: string) => {
      const [first = "", ...rest] = fence;
      return `${indent}${first}\u2060${rest.join("")}`;
    });
}

export function createTtsTool(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
}): AnyAgentTool {
  return {
    label: "TTS",
    name: "tts",
    displaySummary: "Convert text to speech and return audio.",
    description: `Convert text to speech. Audio is delivered automatically from the tool result — reply with ${SILENT_REPLY_TOKEN} after a successful call to avoid duplicate messages.`,
    parameters: TtsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const text = readStringParam(params, "text", { required: true });
      const channel = readStringParam(params, "channel");
      const timeoutMs = readTtsTimeoutMs(params);
      const cfg = opts?.config ?? loadConfig();
      const result = await textToSpeech({
        text,
        cfg,
        channel: channel ?? opts?.agentChannel,
        timeoutMs,
      });

      if (result.success && result.audioPath) {
        // Preserve the spoken text in the tool result content so the session
        // transcript retains what was said across turns. The audio itself is
        // still delivered via details.media. Sanitize first so a crafted
        // utterance cannot inject reply directives when the tool output is
        // rendered in verbose mode.
        return {
          content: [{ type: "text", text: `(spoken) ${sanitizeTranscriptForToolContent(text)}` }],
          details: {
            audioPath: result.audioPath,
            provider: result.provider,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            media: {
              mediaUrl: result.audioPath,
              trustedLocalMedia: true,
              ...(result.voiceCompatible ? { audioAsVoice: true } : {}),
            },
          },
        };
      }

      throw new Error(result.error ?? "TTS conversion failed");
    },
  };
}
