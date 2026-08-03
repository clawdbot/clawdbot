import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
const MATRIX_DEFAULT_ECHO_TRANSCRIPT_FORMAT = '📝 "{transcript}"';

const loadMatrixPreflightAudioRuntime = createLazyRuntimeModule(
  () => import("./preflight-audio.runtime.js"),
);

export function formatMatrixAudioTranscript(transcript: string): string {
  return `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`;
}

function formatMatrixAudioTranscriptEcho(transcript: string, format: string): string {
  // Function replacer keeps `$` sequences in the transcript literal instead of
  // being parsed as String.prototype.replace substitution patterns.
  return format.replace("{transcript}", () => transcript);
}

function suppressMatrixPreflightAudioEcho(cfg: OpenClawConfig): OpenClawConfig {
  const audio = cfg.tools?.media?.audio;
  if (!audio?.echoTranscript) {
    return cfg;
  }
  return {
    ...cfg,
    tools: {
      ...cfg.tools,
      media: {
        ...cfg.tools?.media,
        audio: {
          ...audio,
          echoTranscript: false,
        },
      },
    },
  };
}

export function isMatrixAudioContent(params: { msgtype?: string; mimetype?: string }): boolean {
  if (params.msgtype === "m.audio") {
    return true;
  }
  if (params.msgtype === "m.file" && typeof params.mimetype === "string") {
    return params.mimetype.toLowerCase().startsWith("audio/");
  }
  return false;
}

export async function resolveMatrixPreflightAudioTranscript(params: {
  mediaPath: string;
  mediaContentType?: string;
  cfg: OpenClawConfig;
  accountId: string;
  chatType: "channel" | "direct";
  originatingTo: string;
  messageThreadId?: string;
  sessionKey: string;
  abortSignal?: AbortSignal;
}): Promise<string | undefined> {
  if (params.abortSignal?.aborted) {
    return undefined;
  }
  try {
    const { transcribeFirstAudio } = await loadMatrixPreflightAudioRuntime();
    if (params.abortSignal?.aborted) {
      return undefined;
    }
    const transcript = await transcribeFirstAudio({
      ctx: {
        media: [{ path: params.mediaPath, contentType: params.mediaContentType }],
        Provider: "matrix",
        Surface: "matrix",
        OriginatingChannel: "matrix",
        OriginatingTo: params.originatingTo,
        AccountId: params.accountId,
        MessageThreadId: params.messageThreadId,
        ChatType: params.chatType,
        SessionKey: params.sessionKey,
      },
      cfg: suppressMatrixPreflightAudioEcho(params.cfg),
    });
    return params.abortSignal?.aborted ? undefined : transcript;
  } catch (err) {
    logVerbose(`matrix: audio preflight transcription failed: ${String(err)}`);
    return undefined;
  }
}

export async function sendMatrixPreflightAudioTranscriptEcho(params: {
  transcript: string;
  cfg: OpenClawConfig;
  accountId: string;
  originatingTo: string;
  messageThreadId?: string;
}): Promise<void> {
  const audio = params.cfg.tools?.media?.audio;
  if (!audio?.echoTranscript) {
    return;
  }
  const text = formatMatrixAudioTranscriptEcho(
    params.transcript,
    audio.echoFormat ?? MATRIX_DEFAULT_ECHO_TRANSCRIPT_FORMAT,
  );
  try {
    const { sendDurableMessageBatch } = await loadMatrixPreflightAudioRuntime();
    const send = await sendDurableMessageBatch({
      cfg: params.cfg,
      channel: "matrix",
      to: params.originatingTo,
      accountId: params.accountId,
      threadId: params.messageThreadId,
      payloads: [{ text }],
      bestEffort: true,
      durability: "best_effort",
    });
    if (send.status === "failed") {
      throw send.error;
    }
  } catch (err) {
    logVerbose(`matrix: audio transcript echo failed: ${String(err)}`);
  }
}
