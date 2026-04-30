import path from "node:path";
import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { formatMention } from "../mentions.js";
import { normalizeDiscordSlug } from "../monitor/allow-list.js";
import { authorizeDiscordVoiceIngress } from "./access.js";
import { formatVoiceIngressPrompt } from "./prompt.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import {
  logVoiceVerbose,
  PLAYBACK_READY_TIMEOUT_MS,
  SPEAKING_READY_TIMEOUT_MS,
  type VoiceSessionEntry,
} from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";
import { synthesizeVoiceReplyAudio, transcribeVoiceAudio } from "./tts.js";

const logger = createSubsystemLogger("discord/voice");

export async function processDiscordVoiceSegment(params: {
  entry: VoiceSessionEntry;
  wavPath: string;
  userId: string;
  durationSeconds: number;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv;
  ownerAllowFrom?: string[];
  fetchGuildName: (guildId: string) => Promise<string | undefined>;
  speakerContext: DiscordVoiceSpeakerContextResolver;
  enqueuePlayback: (entry: VoiceSessionEntry, task: () => Promise<void>) => void;
}) {
  const { entry, wavPath, userId, durationSeconds } = params;
  logVoiceVerbose(
    `segment processing (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId}`,
  );
  if (!entry.guildName) {
    entry.guildName = await params.fetchGuildName(entry.guildId);
  }
  const speaker = await params.speakerContext.resolveContext(entry.guildId, userId);
  const speakerIdentity = await params.speakerContext.resolveIdentity(entry.guildId, userId);
  const access = await authorizeDiscordVoiceIngress({
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    guildName: entry.guildName,
    guildId: entry.guildId,
    channelId: entry.channelId,
    channelName: entry.channelName,
    channelSlug: entry.channelName ? normalizeDiscordSlug(entry.channelName) : "",
    channelLabel: formatMention({ channelId: entry.channelId }),
    memberRoleIds: speakerIdentity.memberRoleIds,
    ownerAllowFrom: params.ownerAllowFrom,
    sender: {
      id: speakerIdentity.id,
      name: speakerIdentity.name,
      tag: speakerIdentity.tag,
    },
  });
  if (!access.ok) {
    logVoiceVerbose(
      `segment unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${access.message}`,
    );
    return;
  }
  const transcript = await transcribeVoiceAudio({
    cfg: params.cfg,
    agentId: entry.route.agentId,
    filePath: wavPath,
  });
  if (!transcript) {
    logVoiceVerbose(
      `transcription empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return;
  }
  logVoiceVerbose(
    `transcription ok (${transcript.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
  );

  const prompt = formatVoiceIngressPrompt(transcript, speaker.label);
  const modelOverride = normalizeOptionalString(params.discordConfig.voice?.model);

  const result = await agentCommandFromIngress(
    {
      message: prompt,
      sessionKey: entry.route.sessionKey,
      agentId: entry.route.agentId,
      messageChannel: "discord",
      senderIsOwner: speaker.senderIsOwner,
      allowModelOverride: Boolean(modelOverride),
      model: modelOverride,
      deliver: false,
    },
    params.runtime,
  );

  const replyText = (result.payloads ?? [])
    .map((payload) => payload.text)
    .filter((text) => typeof text === "string" && text.trim())
    .join("\n")
    .trim();

  if (!replyText) {
    logVoiceVerbose(
      `reply empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return;
  }
  logVoiceVerbose(
    `reply ok (${replyText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
  );

  const voiceReplyAudio = await synthesizeVoiceReplyAudio({
    cfg: params.cfg,
    override: params.discordConfig.voice?.tts,
    replyText,
    speakerLabel: speaker.label,
  });
  if (voiceReplyAudio.status === "empty") {
    logVoiceVerbose(
      `tts skipped (empty): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    return;
  }
  if (voiceReplyAudio.status === "failed") {
    logger.warn(`discord voice: TTS failed: ${voiceReplyAudio.error ?? "unknown error"}`);
    return;
  }
  logVoiceVerbose(
    `tts ok (${voiceReplyAudio.speakText.length} chars): guild ${entry.guildId} channel ${entry.channelId}`,
  );

  params.enqueuePlayback(entry, async () => {
    logVoiceVerbose(
      `playback start: guild ${entry.guildId} channel ${entry.channelId} file ${path.basename(voiceReplyAudio.audioPath)}`,
    );
    const voiceSdk = loadDiscordVoiceSdk();
    const resource = voiceSdk.createAudioResource(voiceReplyAudio.audioPath);
    entry.player.play(resource);
    await voiceSdk
      .entersState(entry.player, voiceSdk.AudioPlayerStatus.Playing, PLAYBACK_READY_TIMEOUT_MS)
      .catch(() => undefined);
    await voiceSdk
      .entersState(entry.player, voiceSdk.AudioPlayerStatus.Idle, SPEAKING_READY_TIMEOUT_MS)
      .catch(() => undefined);
    logVoiceVerbose(`playback done: guild ${entry.guildId} channel ${entry.channelId}`);
  });
}
