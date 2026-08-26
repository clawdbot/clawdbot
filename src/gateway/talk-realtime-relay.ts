// Gateway Talk realtime relay.
// Bridges browser Talk audio sessions with realtime voice provider plugins.
export { createTalkRealtimeRelaySession } from "./talk-realtime-relay-session-create.js";
export { commitTalkRealtimeRelayAudio } from "./talk-realtime-relay-manual-input.js";
export {
  acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn,
  ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites,
  registerTalkRealtimeRelayAgentRun,
  sendTalkRealtimeRelayAudio,
  steerTalkRealtimeRelayAgentRun,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "./talk-realtime-relay-operations.js";
