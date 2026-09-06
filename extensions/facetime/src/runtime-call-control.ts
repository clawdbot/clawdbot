import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { FACETIME_FEED_DEVICE_NAME, FACETIME_MIC_DEVICE_NAME } from "./audio-pump.js";
import { FaceTimeCallRegistry } from "./call-lifecycle.js";
import type { FaceTimeConfig } from "./config.js";
import {
  projectCompleteFaceTimeAbsence,
  projectFaceTimeNativeAction,
  type FaceTimeHelperSocketServer,
  type HelperActionResult,
} from "./helper-rpc.js";
import { terminateExactCarrierProcesses } from "./runtime-carrier-process.js";
import type { ActiveFaceTimeCall } from "./runtime-state.js";
import { startFaceTimeTalkDriver } from "./talk-driver.js";

export function createFaceTimeCallControl(params: {
  calls: FaceTimeCallRegistry<ActiveFaceTimeCall>;
  helper: FaceTimeHelperSocketServer;
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  captureBinary: string;
  isStopping: () => boolean;
  getHelperTopologyVersion: () => number;
  retainHelperResultPeers: (call: ActiveFaceTimeCall, result: HelperActionResult) => void;
}) {
  const routeCallAudio = async (call: ActiveFaceTimeCall) => {
    if (!call.audioReady) {
      const routing =
        call.audioRouting ??
        (async () => {
          const assertCallOpen = () => {
            if (call.lifecycleAbort.signal.aborted || params.calls.get(call.callUUID) !== call) {
              throw new Error("FaceTime call closed during audio routing");
            }
          };
          assertCallOpen();
          await access(params.captureBinary, constants.X_OK);
          assertCallOpen();
          call.audioReady = true;
          call.audioTransport = {
            captureBinary: params.captureBinary,
            feedDevice: FACETIME_FEED_DEVICE_NAME,
            microphoneDevice: FACETIME_MIC_DEVICE_NAME,
            processInputVerified: false,
            processOutputSuppressed: false,
          };
          call.lastRoutingError = undefined;
        })();
      call.audioRouting = routing;
      try {
        await routing;
      } catch (error) {
        call.audioReady = false;
        call.lastRoutingError = formatErrorMessage(error);
        throw error;
      } finally {
        if (call.audioRouting === routing) {
          call.audioRouting = undefined;
        }
      }
    }
    if (call.lifecycleAbort.signal.aborted) {
      throw new Error("FaceTime call closed during audio routing");
    }
  };
  const enableCallAudio = async (call: ActiveFaceTimeCall) => {
    const generation = call.captureGeneration();
    const mutedResult = await call.runCarrierCommand({
      generation,
      action: async () => await params.helper.setMuted(call.carrierCallUUID, false),
    });
    call.lastHelperAction = mutedResult;
    params.retainHelperResultPeers(call, mutedResult);
    projectFaceTimeNativeAction("unmute", mutedResult);
    const transmissionResult = await call.runCarrierCommand({
      generation,
      action: async () => await params.helper.startTransmission(call.carrierCallUUID),
    });
    call.lastHelperAction = transmissionResult;
    params.retainHelperResultPeers(call, transmissionResult);
    projectFaceTimeNativeAction("activate", transmissionResult);
    call.markCarrierActive(generation);
    if (call.audioTransport) {
      call.audioTransport.processInputVerified = true;
      call.audioTransport.processOutputSuppressed = call.talk?.processOutputSuppressed() === true;
    }
  };
  const closeCall = async (call: ActiveFaceTimeCall, reason: string) => {
    if (params.calls.active !== call) {
      return;
    }
    if (call.carrierHangupRetryTimer) {
      clearTimeout(call.carrierHangupRetryTimer);
      call.carrierHangupRetryTimer = undefined;
    }
    call.beginClosing();
    await call.audioRouting?.catch((error: unknown) => {
      params.logger.debug?.(
        `[facetime] audio routing cancellation for active call: ${formatErrorMessage(error)}`,
      );
    });
    await call.talkStarting?.catch((error: unknown) => {
      params.logger.debug?.(
        `[facetime] talk startup cancellation for active call: ${formatErrorMessage(error)}`,
      );
    });
    await call.talk?.close(reason).catch((error: unknown) => {
      params.logger.debug?.(
        `[facetime] talk close ignored for active call: ${formatErrorMessage(error)}`,
      );
    });
    await call.talkActivation?.catch((error: unknown) => {
      params.logger.debug?.(
        `[facetime] talk activation cancellation for active call: ${formatErrorMessage(error)}`,
      );
    });
    call.audioReady = false;
    call.audioTransport = undefined;
    params.calls.close(call);
    params.logger.info(`[facetime] call closed (${reason})`);
  };
  const attemptCarrierHangup = async (
    call: ActiveFaceTimeCall,
    reason: string,
    options: { closeLocal?: boolean; scheduleRetry?: boolean } = {},
  ): Promise<boolean> => {
    const closeLocal = options.closeLocal !== false;
    const scheduleRetry = options.scheduleRetry !== false;
    if (params.calls.active !== call) {
      return true;
    }
    const generation = call.beginClosing();
    call.carrierHangupPending = true;
    void call.talk?.suspendMedia(reason).catch((error: unknown) => {
      params.logger.warn(`[facetime] local media suspension failed: ${formatErrorMessage(error)}`);
    });
    const attempt =
      call.carrierHangupAttempt ??
      (async () => {
        try {
          const muted = await call.runCarrierCommand({
            generation,
            allowClosing: true,
            action: async () => await params.helper.safetyMute(call.carrierCallUUID),
          });
          projectFaceTimeNativeAction("safe-mute", muted);
          params.retainHelperResultPeers(call, muted);
        } catch (error) {
          params.logger.warn(
            `[facetime] failed to confirm carrier safety mute: ${formatErrorMessage(error)}`,
          );
        }
        try {
          const leave = await call.runCarrierCommand({
            generation,
            allowClosing: true,
            action: async () => await params.helper.leaveCall(call.carrierCallUUID),
          });
          projectFaceTimeNativeAction("terminate", leave);
          params.retainHelperResultPeers(call, leave);
        } catch (error) {
          params.logger.warn(
            `[facetime] carrier termination request failed: ${formatErrorMessage(error)}`,
          );
        }
        const topologyVersion = params.getHelperTopologyVersion();
        try {
          const inspect = async () =>
            await call.runCarrierCommand({
              generation,
              allowClosing: true,
              action: async () => await params.helper.inspectCall([...call.carrierCallUUIDs]),
            });
          const first = projectCompleteFaceTimeAbsence(await inspect());
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 100);
            timer.unref?.();
          });
          const second = projectCompleteFaceTimeAbsence(await inspect());
          return (
            first.topologyGeneration === second.topologyGeneration &&
            params.getHelperTopologyVersion() === topologyVersion
          );
        } catch {
          return false;
        }
      })();
    call.carrierHangupAttempt = attempt;
    let carrierClosed: boolean;
    try {
      carrierClosed = await attempt;
    } finally {
      if (call.carrierHangupAttempt === attempt) {
        call.carrierHangupAttempt = undefined;
      }
    }
    if (carrierClosed) {
      call.carrierHangupPending = false;
      if (closeLocal) {
        await closeCall(call, reason);
      }
      return true;
    }
    if (scheduleRetry && !call.carrierHangupRetryTimer) {
      call.carrierHangupRetryTimer = setTimeout(() => {
        call.carrierHangupRetryTimer = undefined;
        void attemptCarrierHangup(call, reason);
      }, 1_000);
      call.carrierHangupRetryTimer.unref?.();
    }
    return false;
  };
  const waitForStartupCarrierHangup = async (
    call: ActiveFaceTimeCall,
    reason: string,
  ): Promise<boolean> => {
    while (params.calls.active === call && call.phase === "closing") {
      if (
        await attemptCarrierHangup(call, reason, {
          closeLocal: false,
          scheduleRetry: false,
        })
      ) {
        return true;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref?.();
      });
    }
    return true;
  };
  const terminateCarrierProcesses = async (call: ActiveFaceTimeCall): Promise<void> => {
    const generation = call.captureGeneration();
    await terminateExactCarrierProcesses({
      runtime: params.runtime,
      peers: call.carrierPeers,
      assertCurrent: () => call.assertCurrent(generation, true),
    });
  };
  const startCallTalk = async (call: ActiveFaceTimeCall) => {
    if (call.talk) {
      return;
    }
    if (!call.talkStarting) {
      const callUUID = call.callUUID;
      call.talkStarting = (async () => {
        await routeCallAudio(call);
        const talk = await startFaceTimeTalkDriver({
          config: params.config,
          fullConfig: params.fullConfig,
          runtime: params.runtime,
          logger: params.logger,
          callUUID,
          senderId: call.senderId,
          senderIsOwner: call.senderIsOwner,
          captureBinary: params.captureBinary,
          signal: call.lifecycleAbort.signal,
          async onHangupRequested() {
            if (!(await attemptCarrierHangup(call, "caller-requested-hangup"))) {
              throw new Error(`carrier hangup pending for ${call.callUUID}; retry scheduled`);
            }
          },
          async onFailure(error) {
            if (call.phase === "ringing") {
              return true;
            }
            const failureReason = `talk-failed: ${formatErrorMessage(error)}`;
            if (!call.talk) {
              return await waitForStartupCarrierHangup(call, failureReason);
            }
            const carrierClosed = await attemptCarrierHangup(call, failureReason, {
              closeLocal: false,
            });
            if (carrierClosed) {
              queueMicrotask(() => {
                void closeCall(call, failureReason);
              });
            }
            return carrierClosed;
          },
        });
        if (params.isStopping() || params.calls.active !== call) {
          await talk.close("call-ended-during-start");
          return;
        }
        call.talk = talk;
        if (call.audioTransport) {
          call.audioTransport.processOutputSuppressed = true;
        }
        params.logger.info("[facetime] realtime talk suppression ready");
      })();
    }
    const starting = call.talkStarting;
    try {
      await starting;
    } finally {
      if (call.talkStarting === starting) {
        call.talkStarting = undefined;
      }
    }
  };
  const activateCallTalk = async (call: ActiveFaceTimeCall, options: { unmute: boolean }) => {
    const generation = call.captureGeneration();
    if (!call.talkActivation) {
      call.talkActivation = (async () => {
        await call.talk?.readyForAudio();
        call.assertCurrent(generation);
        call.markModelReady(generation);
        if (options.unmute) {
          await enableCallAudio(call);
        }
        call.assertCurrent(generation);
        call.markModelActive(generation);
        call.talk?.activate();
      })();
    }
    const activation = call.talkActivation;
    try {
      await activation;
      call.assertCurrent(generation);
      if (options.unmute && call.carrierMode !== "active") {
        await enableCallAudio(call);
      }
    } finally {
      if (call.talkActivation === activation) {
        call.talkActivation = undefined;
      }
    }
  };
  return {
    activateCallTalk,
    attemptCarrierHangup,
    closeCall,
    startCallTalk,
    terminateCarrierProcesses,
  };
}
