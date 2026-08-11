// Discord test API exposes the gateway lifecycle fixture.
export { testing as discordGatewayLifecycleTesting } from "./src/monitor/provider.lifecycle.js";
export {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "./src/voice/transcripts-source.js";
