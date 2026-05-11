import { agentCommandFromIngress } from "openclaw/plugin-sdk/agent-runtime";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatMention } from "../mentions.js";
import { normalizeDiscordSlug } from "../monitor/allow-list.js";
import { buildDiscordGroupSystemPrompt } from "../monitor/inbound-context.js";
import { authorizeDiscordVoiceIngress } from "./access.js";
import type { VoiceSessionEntry } from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

export const DISCORD_VOICE_MESSAGE_PROVIDER = "discord-voice";

export type DiscordVoiceIngressContext = {
  extraSystemPrompt?: string;
  senderIsOwner: boolean;
  speakerLabel: string;
};

export type DiscordVoiceAgentTurnResult = {
  context: DiscordVoiceIngressContext;
  text: string;
};

export async function resolveDiscordVoiceIngressContext(params: {
  entry: VoiceSessionEntry;
  userId: string;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  ownerAllowFrom?: string[];
  fetchGuildName: (guildId: string) => Promise<string | undefined>;
  speakerContext: DiscordVoiceSpeakerContextResolver;
}): Promise<DiscordVoiceIngressContext | null> {
  const { entry, userId } = params;
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
    return null;
  }
  return {
    extraSystemPrompt: buildDiscordGroupSystemPrompt(access.channelConfig),
    senderIsOwner: speaker.senderIsOwner,
    speakerLabel: speaker.label,
  };
}

export async function runDiscordVoiceAgentTurn(params: {
  entry: VoiceSessionEntry;
  userId: string;
  message: string;
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  runtime: RuntimeEnv;
  context?: DiscordVoiceIngressContext;
  toolsAllow?: string[];
  ownerAllowFrom?: string[];
  fetchGuildName: (guildId: string) => Promise<string | undefined>;
  speakerContext: DiscordVoiceSpeakerContextResolver;
}): Promise<DiscordVoiceAgentTurnResult | null> {
  const context =
    params.context ??
    (await resolveDiscordVoiceIngressContext({
      entry: params.entry,
      userId: params.userId,
      cfg: params.cfg,
      discordConfig: params.discordConfig,
      ownerAllowFrom: params.ownerAllowFrom,
      fetchGuildName: params.fetchGuildName,
      speakerContext: params.speakerContext,
    }));
  if (!context) {
    return null;
  }
  const voiceModel = normalizeOptionalString(params.discordConfig.voice?.model);
  const result = await agentCommandFromIngress(
    {
      message: params.message,
      sessionKey: params.entry.route.sessionKey,
      agentId: params.entry.route.agentId,
      messageChannel: "discord",
      messageProvider: DISCORD_VOICE_MESSAGE_PROVIDER,
      extraSystemPrompt: context.extraSystemPrompt,
      senderIsOwner: context.senderIsOwner,
      allowModelOverride: Boolean(voiceModel),
      model: voiceModel,
      toolsAllow: params.toolsAllow,
      deliver: false,
    },
    params.runtime,
  );
  return {
    context,
    text: (result.payloads ?? [])
      .map((payload) => payload.text)
      .filter((text) => typeof text === "string" && text.trim())
      .join("\n")
      .trim(),
  };
}
