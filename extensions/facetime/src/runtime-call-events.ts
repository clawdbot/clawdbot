import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import {
  isActiveCall,
  isEndedCall,
  isIncomingRingingCall,
  isOutgoingRingingCall,
  isUnknownCallStatus,
  isVerifiedFaceTimeTransport,
  normalizeFaceTimeHandle,
  resolveAuthorizedFaceTimeOwner,
  type AuthenticatedFaceTimeOwner,
  type FaceTimeCallStatusEvent,
} from "./call-events.js";
import type { FaceTimeCallRegistry } from "./call-lifecycle.js";
import type { FaceTimeConfig } from "./config.js";
import {
  projectFaceTimeNativeAction,
  type FaceTimeHelperPeer,
  type FaceTimeHelperSocketServer,
} from "./helper-rpc.js";
import {
  doesFaceTimeCallMatchPendingDial,
  retainFaceTimeDialCallUUID,
  type PendingFaceTimeDial,
} from "./outbound-call.js";
import { retainHelperResultPeers } from "./runtime-helper-results.js";
import {
  createManagedCall,
  readCallUUID,
  updateCallStatus,
  type ActiveFaceTimeCall,
} from "./runtime-state.js";

type CallControl = {
  activateCallTalk(call: ActiveFaceTimeCall, options: { unmute: boolean }): Promise<void>;
  attemptCarrierHangup(call: ActiveFaceTimeCall, reason: string): Promise<boolean>;
  closeCall(call: ActiveFaceTimeCall, reason: string): Promise<void>;
  startCallTalk(call: ActiveFaceTimeCall): Promise<void>;
};

export function createFaceTimeCallEventHandler(params: {
  calls: FaceTimeCallRegistry<ActiveFaceTimeCall>;
  helper: FaceTimeHelperSocketServer;
  config: FaceTimeConfig;
  logger: RuntimeLogger;
  callControl: CallControl;
  isStopping: () => boolean;
  isDriverInstallPending: () => boolean;
  getPendingDial: () => PendingFaceTimeDial | undefined;
  clearPendingDial: () => void;
  persistPendingDial: () => void;
  outboundCarrierPeers: ReadonlyMap<number, FaceTimeHelperPeer>;
  cancelPendingDial: (pending: PendingFaceTimeDial) => Promise<void>;
}) {
  const authorizePendingDial = async (
    event: FaceTimeCallStatusEvent,
    pending: PendingFaceTimeDial,
  ): Promise<AuthenticatedFaceTimeOwner | undefined> => {
    retainFaceTimeDialCallUUID(pending, readCallUUID(event));
    params.persistPendingDial();
    const owner = resolveAuthorizedFaceTimeOwner({
      event,
      ownerHandles: params.config.ownerHandles,
    });
    if (owner) {
      return owner;
    }
    params.logger.warn(
      "[facetime] cancelling correlated outbound call because its handle is no longer authorized; add it to ownerHandles before dialing again",
    );
    try {
      await params.cancelPendingDial(pending);
    } catch (error) {
      params.logger.warn(
        `[facetime] outbound authorization cancellation remains pending: ${formatErrorMessage(error)}`,
      );
    }
    return undefined;
  };
  const retainAliases = (call: ActiveFaceTimeCall, event: FaceTimeCallStatusEvent) => {
    for (const alias of [
      event.data.call_uuid,
      event.data.dial_id,
      event.data.proxy_identifier,
      event.data.conversation_uuid,
      event.data.conversation_group_uuid,
    ]) {
      if (typeof alias === "string" && alias.trim()) {
        params.calls.retainAlias(call, alias);
      }
    }
    call.carrierCallUUIDs.add(String(event.data.call_uuid));
  };
  const answerIncoming = async (
    event: FaceTimeCallStatusEvent,
    owner: AuthenticatedFaceTimeOwner,
    peer?: FaceTimeHelperPeer,
  ) => {
    const callUUID = readCallUUID(event);
    if (params.isDriverInstallPending()) {
      params.logger.warn("[facetime] ignored incoming call; audio driver installation is pending");
      return;
    }
    if (params.calls.get(callUUID)) {
      return;
    }
    if (params.calls.size > 0) {
      params.logger.warn("[facetime] ignored incoming call; another FaceTime bridge is active");
      return;
    }
    const call = createManagedCall({
      callUUID,
      phase: "ringing",
      owner,
      handle: normalizeFaceTimeHandle(event.data.handle),
      peer,
    });
    updateCallStatus(call, event);
    params.calls.create(call);
    retainAliases(call, event);
    let answerAttempted = false;
    try {
      await params.callControl.startCallTalk(call);
      if (
        call.lifecycleAbort.signal.aborted ||
        params.calls.active !== call ||
        call.carrierHangupPending
      ) {
        throw new Error("FaceTime call closed before answer");
      }
      const generation = call.beginAnswering();
      answerAttempted = true;
      const answerResult = await call.runCarrierCommand({
        generation,
        action: async () => await params.helper.answerCall(callUUID),
      });
      projectFaceTimeNativeAction("answer", answerResult);
      retainHelperResultPeers(call, answerResult);
      await params.callControl.activateCallTalk(call, { unmute: true });
      params.logger.info("[facetime] answered authorized FaceTime call");
    } catch (error) {
      params.logger.warn(`[facetime] failed to answer FaceTime call: ${formatErrorMessage(error)}`);
      if (answerAttempted) {
        await params.callControl.attemptCarrierHangup(call, "answer-failed");
        return;
      }
      await params.callControl.closeCall(call, "answer-failed").catch((closeError: unknown) => {
        params.logger.warn(
          `[facetime] answer failure cleanup failed: ${formatErrorMessage(closeError)}`,
        );
      });
    }
  };
  const activate = async (
    event: FaceTimeCallStatusEvent,
    owner?: AuthenticatedFaceTimeOwner,
    peer?: FaceTimeHelperPeer,
  ) => {
    const callUUID = readCallUUID(event);
    if (params.isDriverInstallPending()) {
      params.logger.warn("[facetime] ignored active call; audio driver installation is pending");
      return;
    }
    let call = params.calls.get(callUUID);
    if (!call) {
      if (!owner) {
        params.logger.warn("[facetime] refused active call without authenticated owner");
        return;
      }
      if (params.calls.size > 0) {
        params.logger.warn("[facetime] ignored active call; another FaceTime bridge is active");
        return;
      }
      call = createManagedCall({
        callUUID,
        phase: "active",
        owner,
        handle: normalizeFaceTimeHandle(event.data.handle),
        peer,
      });
      params.calls.create(call);
      retainAliases(call, event);
    }
    if (peer) {
      call.carrierPeers.set(peer.processId, peer);
    }
    // Apple can replace the ringing call object when it becomes active. Keep
    // lifecycle identity stable, but direct subsequent commands to this owner event's UUID.
    call.promoteCarrierCallUUID(callUUID);
    updateCallStatus(call, event);
    try {
      await params.callControl.startCallTalk(call);
      await params.callControl.activateCallTalk(call, { unmute: true });
      params.logger.info("[facetime] realtime talk session active");
    } catch (error) {
      if (call.lifecycleAbort.signal.aborted || params.calls.active !== call) {
        return;
      }
      params.logger.warn(`[facetime] failed to start realtime talk: ${formatErrorMessage(error)}`);
      await params.callControl.attemptCarrierHangup(call, "talk-start-failed");
    }
  };
  const handleCallEvent = async (event: FaceTimeCallStatusEvent, peer?: FaceTimeHelperPeer) => {
    if (params.isStopping()) {
      return;
    }
    const callUUID = readCallUUID(event);
    const existingCall = params.calls.get(callUUID);
    if (existingCall) {
      if (peer) {
        existingCall.carrierPeers.set(peer.processId, peer);
      }
      updateCallStatus(existingCall, event);
      retainAliases(existingCall, event);
    }
    const verifiedTransport = isVerifiedFaceTimeTransport(event);
    if (existingCall && !verifiedTransport && !isEndedCall(event)) {
      params.logger.warn(
        "[facetime] managed call transport lost FaceTime verification; closing fail-closed",
      );
      await params.callControl.attemptCarrierHangup(existingCall, "transport-verification-lost");
      return;
    }
    if (isIncomingRingingCall(event)) {
      const owner = resolveAuthorizedFaceTimeOwner({
        event,
        ownerHandles: params.config.ownerHandles,
      });
      if (owner) {
        await answerIncoming(event, owner, peer);
      } else {
        params.logger.info("[facetime] ignored unauthorized incoming FaceTime call");
      }
      return;
    }
    const pending = params.getPendingDial();
    if (isOutgoingRingingCall(event)) {
      if (verifiedTransport && pending && doesFaceTimeCallMatchPendingDial({ event, pending })) {
        const owner = await authorizePendingDial(event, pending);
        if (!owner) {
          return;
        }
        let ringingCall = params.calls.get(callUUID);
        if (!ringingCall && params.calls.size === 0) {
          ringingCall = createManagedCall({
            callUUID,
            phase: "ringing",
            owner,
            handle: normalizeFaceTimeHandle(event.data.handle),
            peer,
          });
          updateCallStatus(ringingCall, event);
          params.calls.create(ringingCall);
          retainAliases(ringingCall, event);
          params.calls.retainAlias(ringingCall, pending.dialID);
          if (pending.proxyIdentifier) {
            params.calls.retainAlias(ringingCall, pending.proxyIdentifier);
          }
          for (const carrierPeer of params.outboundCarrierPeers.values()) {
            ringingCall.carrierPeers.set(carrierPeer.processId, carrierPeer);
          }
        }
        if (ringingCall) {
          try {
            const generation = ringingCall.captureGeneration();
            const muteResult = await ringingCall.runCarrierCommand({
              generation,
              action: async () => await params.helper.safetyMute(ringingCall.carrierCallUUID),
            });
            ringingCall.lastHelperAction = muteResult;
            retainHelperResultPeers(ringingCall, muteResult);
            projectFaceTimeNativeAction("safe-mute", muteResult);
          } catch (error) {
            params.logger.warn(
              `[facetime] outbound ringing safety mute failed: ${formatErrorMessage(error)}`,
            );
            await params.callControl.attemptCarrierHangup(
              ringingCall,
              "outbound-ringing-safety-mute-failed",
            );
          }
        }
      }
      return;
    }
    if (isActiveCall(event)) {
      const authorizedPending =
        event.data.is_outgoing === true &&
        verifiedTransport &&
        pending &&
        doesFaceTimeCallMatchPendingDial({ event, pending })
          ? pending
          : undefined;
      const owner = authorizedPending
        ? await authorizePendingDial(event, authorizedPending)
        : event.data.is_outgoing === true
          ? undefined
          : resolveAuthorizedFaceTimeOwner({
              event,
              ownerHandles: params.config.ownerHandles,
            });
      if (authorizedPending && !owner) {
        return;
      }
      if (authorizedPending && params.calls.active) {
        params.calls.retainAlias(params.calls.active, callUUID);
      }
      if (!params.calls.has(callUUID) && !owner) {
        params.logger.info("[facetime] ignored unauthorized active FaceTime call");
        return;
      }
      await activate(event, owner, peer);
      if (
        authorizedPending &&
        params.getPendingDial() === authorizedPending &&
        params.calls.has(callUUID)
      ) {
        const activeCall = params.calls.get(callUUID);
        if (activeCall) {
          params.calls.retainAlias(activeCall, authorizedPending.dialID);
          if (authorizedPending.proxyIdentifier) {
            params.calls.retainAlias(activeCall, authorizedPending.proxyIdentifier);
          }
          for (const alias of authorizedPending.callUUIDAliases ?? []) {
            params.calls.retainAlias(activeCall, alias);
            activeCall.carrierCallUUIDs.add(alias);
          }
        }
        params.clearPendingDial();
      }
      return;
    }
    if (isEndedCall(event)) {
      if (
        event.data.is_outgoing === true &&
        pending &&
        doesFaceTimeCallMatchPendingDial({ event, pending })
      ) {
        params.clearPendingDial();
      }
      const endedCall = params.calls.get(callUUID);
      if (endedCall) {
        await params.callControl.closeCall(endedCall, "native-ended");
      }
      return;
    }
    if (isUnknownCallStatus(event)) {
      const unknownCall = params.calls.get(callUUID);
      if (unknownCall) {
        params.logger.warn("[facetime] unknown native call status; closing carrier fail-closed");
        await params.callControl.attemptCarrierHangup(unknownCall, "unknown-native-status");
      }
    }
  };
  return { handleCallEvent };
}
