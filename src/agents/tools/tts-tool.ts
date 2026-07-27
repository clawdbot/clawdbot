/**
 * tts built-in tool.
 *
 * Converts explicit speech requests into generated audio and safe transcript content.
 */
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { textToSpeech } from "../../tts/tts.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { readPositiveIntegerParam, readStringParam } from "./common.js";

const TtsToolSchema = Type.Object({
  text: Type.String({ description: "Text to speak." }),
  channel: Type.Optional(Type.String({ description: "Channel id; output-format hint." })),
  timeoutMs: Type.Optional(
    Type.Integer({
      description: "Provider timeout ms.",
      minimum: 1,
    }),
  ),
});

function readTtsTimeoutMs(args: Record<string, unknown>): number | undefined {
  return readPositiveIntegerParam(args, "timeoutMs", {
    message: "timeoutMs must be a positive integer in milliseconds.",
  });
}

/**
 * Defuse reply-directive tokens inside spoken transcripts before they flow
 * through tool-result content. Insert a zero-width word joiner so transcript
 * text cannot be mistaken for assistant control tags if it is reused later.
 */
function sanitizeTranscriptForToolContent(text: string): string {
  return text
    .replace(/\[\[/g, "[\u2060[")
    .replace(/^(\s*)(MEDIA:)/gim, "$1\u2060$2")
    .replace(/^([ \t]*)(`{3,})/gm, (_match, indent: string, fence: string) => {
      const [first = "", ...rest] = fence;
      return `${indent}${first}\u2060${rest.join("")}`;
    });
}

export function createTtsTool(opts?: {
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
  agentId?: string;
  agentAccountId?: string;
}): AnyAgentTool {
  return {
    label: "TTS",
    name: "tts",
    displaySummary: "Text to speech audio.",
    description:
      "Only explicit voice/speech/TTS intent or active TTS config; never ordinary text reply. Audio auto-delivered. After success follow reply instructions; no duplicate text/audio.",
    parameters: TtsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const text = readStringParam(params, "text", { required: true });
      const channel = readStringParam(params, "channel");
      const timeoutMs = readTtsTimeoutMs(params);
      const cfg = opts?.config ?? getRuntimeConfig();
      const result = await textToSpeech({
        text,
        cfg,
        channel: channel ?? opts?.agentChannel,
        timeoutMs,
        agentId: opts?.agentId,
        accountId: opts?.agentAccountId,
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
              ...(result.audioAsVoice || result.voiceCompatible ? { audioAsVoice: true } : {}),
            },
          },
        };
      }

      throw new Error(result.error ?? "TTS conversion failed");
    },
  };
}
