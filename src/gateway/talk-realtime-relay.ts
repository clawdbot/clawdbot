// Gateway Talk realtime relay.
// Bridges browser Talk audio sessions with realtime voice provider plugins.
import {
  PluginRegistryResourceScope,
  createPluginRegistryResourceLease,
  getPluginRegistryResourceScope,
  withPluginRegistryResourceScope,
} from "../plugins/registry-resources.js";
import { createTalkRealtimeRelaySessionWithResources } from "./talk-realtime-relay-session-create.js";
import type {
  CreateTalkRealtimeRelaySessionParams,
  TalkRealtimeRelaySessionResult,
} from "./talk-realtime-relay-state.js";
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

/** Creates a realtime voice relay session and returns the browser audio contract. */
export function createTalkRealtimeRelaySession(
  params: CreateTalkRealtimeRelaySessionParams,
): TalkRealtimeRelaySessionResult {
  const resources = getPluginRegistryResourceScope()?.fork() ?? new PluginRegistryResourceScope();
  const ownership = {
    resources,
    lease: createPluginRegistryResourceLease(resources),
    adopted: false,
  };
  try {
    return withPluginRegistryResourceScope(resources, () =>
      createTalkRealtimeRelaySessionWithResources(params, ownership),
    );
  } catch (error) {
    if (!ownership.adopted) {
      ownership.lease.release();
    }
    throw error;
  }
}
