import {
  DiscordVoiceManager as DiscordVoiceManagerImpl,
  DiscordVoiceReadyListener as DiscordVoiceReadyListenerImpl,
  DiscordVoiceResumedListener as DiscordVoiceResumedListenerImpl,
} from "./manager.js";

export class DiscordVoiceManager extends DiscordVoiceManagerImpl {}

export class DiscordVoiceReadyListener extends DiscordVoiceReadyListenerImpl {}

export class DiscordVoiceResumedListener extends DiscordVoiceResumedListenerImpl {}
