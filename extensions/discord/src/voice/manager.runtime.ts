import {
  DiscordVoiceManager as DiscordVoiceManagerImpl,
  DiscordVoiceReadyListener as DiscordVoiceReadyListenerImpl,
  DiscordVoiceResumedListener as DiscordVoiceResumedListenerImpl,
  DiscordVoiceStateUpdateListener as DiscordVoiceStateUpdateListenerImpl,
} from "./manager.js";

export class DiscordVoiceManager extends DiscordVoiceManagerImpl {}

export class DiscordVoiceReadyListener extends DiscordVoiceReadyListenerImpl {}

export class DiscordVoiceResumedListener extends DiscordVoiceResumedListenerImpl {}

export class DiscordVoiceStateUpdateListener extends DiscordVoiceStateUpdateListenerImpl {}
