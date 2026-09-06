import type { FaceTimeCallRegistry } from "./call-lifecycle.js";
import type { FaceTimeHelperSupervisorStatus } from "./helper-supervisor.js";
import type { PendingFaceTimeDial } from "./outbound-call.js";
import type { ActiveFaceTimeCall, FaceTimeRuntimeStatus } from "./runtime-state.js";
import { summarizeRecentTalkEvents } from "./talk-events-summary.js";

export function buildFaceTimeRuntimeStatus(params: {
  calls: FaceTimeCallRegistry<ActiveFaceTimeCall>;
  helperConnected: boolean;
  helperTargets: FaceTimeHelperSupervisorStatus;
  driverInstall: FaceTimeRuntimeStatus["driverInstall"];
  pendingDial?: PendingFaceTimeDial;
}): FaceTimeRuntimeStatus {
  const calls = [...params.calls.values()];
  return {
    enabled: true,
    helperConnected: params.helperConnected,
    helperProtocol: {
      version: 1,
      authentication: "mutual-hmac-sha256-v1",
      eventIntegrity: "epoch-sequence-hmac-v1",
      statusClassifier: "explicit-ended-tu-call-status-v1",
      transportClassifier: "tu-provider-v1",
    },
    helperTargets: params.helperTargets,
    driverInstallPending: params.driverInstall.phase === "installing",
    driverInstall: params.driverInstall,
    processOutputSuppressed: calls.some((call) => call.talk?.processOutputSuppressed() === true),
    outboundCallPending: params.pendingDial
      ? {
          dialID: params.pendingDial.dialID,
          delivery: params.pendingDial.delivery,
          handle: params.pendingDial.handle,
          mode: params.pendingDial.mode,
          requestedAt: params.pendingDial.requestedAt,
          proxyIdentifier: params.pendingDial.proxyIdentifier,
        }
      : undefined,
    calls: calls.map((call) => ({
      callUUID: call.callUUID,
      generation: call.generation,
      phase: call.phase,
      carrierMode: call.carrierMode,
      modelMediaMode: call.modelMediaMode,
      handle: call.handle,
      callStatus: call.callStatus,
      isSendingAudio: call.isSendingAudio,
      isSendingTransmission: call.isSendingTransmission,
      isUplinkMuted: call.isUplinkMuted,
      isSendingVideo: call.isSendingVideo,
      conversationUUID: call.conversationUUID,
      conversationGroupUUID: call.conversationGroupUUID,
      conversationAudioEnabled: call.conversationAudioEnabled,
      conversationVideoEnabled: call.conversationVideoEnabled,
      conversationAVMode: call.conversationAVMode,
      conversationResolvedAudioVideoMode: call.conversationResolvedAudioVideoMode,
      localMeterLevel: call.localMeterLevel,
      remoteMeterLevel: call.remoteMeterLevel,
      maxLocalMeterLevel: call.maxLocalMeterLevel,
      maxRemoteMeterLevel: call.maxRemoteMeterLevel,
      realtimeActive: call.talk?.realtimeActive() === true,
      audioReady: call.audioReady,
      audioTransport: call.audioTransport
        ? {
            ...call.audioTransport,
            processOutputSuppressed: call.talk?.processOutputSuppressed() === true,
          }
        : undefined,
      lastHelperAction: call.lastHelperAction,
      lastRoutingError: call.lastRoutingError,
      carrierHangupPending: call.carrierHangupPending,
      recentTalkEvents: call.talk
        ? summarizeRecentTalkEvents(call.talk.recentTalkEvents)
        : undefined,
    })),
  };
}
