import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeFaceTimeCallEvent } from "./call-events.js";
import { FaceTimeCallRegistry } from "./call-lifecycle.js";
import { resolveFaceTimeConfig, validateFaceTimeConfig, type FaceTimeConfig } from "./config.js";
import { installFaceTimeDriver } from "./driver-setup.js";
import { resolveFaceTimeHelperEndpoint } from "./helper-endpoint.js";
import {
  FaceTimeHelperActionError,
  FaceTimeHelperAmbiguousError,
  FaceTimeHelperSocketServer,
  FaceTimeHelperUnavailableError,
  readHelperResults,
  type FaceTimeHelperPeer,
  type HelperActionResult,
} from "./helper-rpc.js";
import { FaceTimeHelperSupervisor } from "./helper-supervisor.js";
import {
  doesPendingFaceTimeDialHaveCallUUID,
  normalizeFaceTimeOutboundIdentityEvent,
  resolveFaceTimeDialRequest,
  resolveFaceTimeDialResult,
  retainFaceTimeDialCallUUID,
  type FaceTimeDialMode,
  type FaceTimeDialResult,
  type PendingFaceTimeDial,
} from "./outbound-call.js";
import { PendingFaceTimeDialStore } from "./pending-dial-store.js";
import { ensureCaptureBinary, ensureHelperArtifacts } from "./plugin-paths.js";
import { runFaceTimePreflight, type FaceTimePreflightResult } from "./preflight.js";
import { createFaceTimeCallControl } from "./runtime-call-control.js";
import { createFaceTimeCallEventHandler } from "./runtime-call-events.js";
import { terminateExactCarrierProcesses } from "./runtime-carrier-process.js";
import {
  hasDefinitiveDialHelperAbsence,
  hasDialHelperConfirmation,
  OUTBOUND_DIAL_HELPER_BUNDLES,
  readHelperPeers,
  readOutboundCallUUID,
  readOutboundProxyIdentifier,
  retainHelperResultPeers,
} from "./runtime-helper-results.js";
import type {
  ActiveFaceTimeCall,
  FaceTimeRuntime,
  FaceTimeRuntimeStatus,
} from "./runtime-state.js";
import { buildFaceTimeRuntimeStatus } from "./runtime-status.js";
import { runFaceTimeSetup } from "./setup.js";

export type { FaceTimeRuntime, FaceTimeRuntimeStatus } from "./runtime-state.js";

const OUTBOUND_RECONCILE_ATTEMPTS = 12;
const OUTBOUND_RECONCILE_INTERVAL_MS = 250;
const OUTBOUND_RECONCILE_DELAY_MS = 1_000;

export async function createFaceTimeRuntime(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  pluginRoot: string;
}): Promise<FaceTimeRuntime> {
  const config = resolveFaceTimeConfig(params.config);
  if (!config.enabled) {
    throw new Error("facetime disabled in plugin config");
  }
  const validation = validateFaceTimeConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid facetime config: ${validation.errors.join("; ")}`);
  }

  const calls = new FaceTimeCallRegistry<ActiveFaceTimeCall>();
  const pendingDialStore = new PendingFaceTimeDialStore(
    params.runtime.state.openSyncKeyedStore({
      namespace: "pending-dial",
      maxEntries: 1,
      overflowPolicy: "reject-new",
    }),
  );
  let outboundDialInFlight: Promise<FaceTimeDialResult> | undefined;
  let outboundCallPending: PendingFaceTimeDial | undefined = pendingDialStore.load();
  const outboundCarrierPeers = new Map<number, FaceTimeHelperPeer>();
  if (outboundCallPending) {
    outboundCallPending.ownerEpoch += 1;
    pendingDialStore.save(outboundCallPending);
  }
  let outboundReconcileTimer: NodeJS.Timeout | undefined;
  let driverInstall: FaceTimeRuntimeStatus["driverInstall"] = { phase: "idle" };
  let driverInstallAbortController: AbortController | undefined;
  let driverInstallTask: Promise<void> | undefined;
  const isDriverInstallPending = () => driverInstall.phase === "installing";
  const captureBinary = await ensureCaptureBinary();
  const { buildId: helperBuildId, ipcKey: helperIpcKey } = await ensureHelperArtifacts({
    pluginRoot: params.pluginRoot,
    runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
  });
  let stopping = false;
  const helperRef: { current?: FaceTimeHelperSocketServer } = {};
  const helperSupervisor = new FaceTimeHelperSupervisor({
    pluginRoot: params.pluginRoot,
    logger: params.logger,
    runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
    connectedBundles: () => helperRef.current?.connectedHelperBundles ?? [],
  });
  const clearOutboundCallPending = (expectedDialID = outboundCallPending?.dialID) => {
    if (outboundReconcileTimer) {
      clearTimeout(outboundReconcileTimer);
      outboundReconcileTimer = undefined;
    }
    if (expectedDialID) {
      pendingDialStore.clear(expectedDialID);
    }
    outboundCallPending = undefined;
    outboundCarrierPeers.clear();
  };
  const persistOutboundCallPending = () => {
    if (outboundCallPending) {
      pendingDialStore.save(outboundCallPending);
    }
  };
  const retainOutboundCarrierPeers = (result: HelperActionResult) => {
    for (const peer of readHelperPeers(result)) {
      if (OUTBOUND_DIAL_HELPER_BUNDLES.has(peer.bundleIdentifier)) {
        outboundCarrierPeers.set(peer.processId, peer);
      }
    }
  };
  const findOutgoingCallDuringReconciliation = async (
    handle: string,
    callUUID?: string,
    dialID?: string,
    proxyIdentifier?: string,
    requestedAt?: string,
    mode?: FaceTimeDialMode,
  ): Promise<HelperActionResult> => {
    let result: HelperActionResult = { found: false };
    let previousAbsentTopology: number | undefined;
    for (let attempt = 0; attempt < OUTBOUND_RECONCILE_ATTEMPTS; attempt += 1) {
      result = await helper.findOutgoingCall(
        handle,
        callUUID,
        dialID,
        proxyIdentifier,
        requestedAt,
        mode,
      );
      if (
        readOutboundCallUUID(result) ||
        readHelperResults(result).some((entry) => entry.found === true)
      ) {
        return result;
      }
      const results = readHelperResults(result);
      const topologyGeneration =
        typeof result.topologyGeneration === "number" ? result.topologyGeneration : undefined;
      const completeAbsence =
        result.topologyComplete === true &&
        results.every((entry) => entry.found === false) &&
        hasDialHelperConfirmation(results) &&
        hasDefinitiveDialHelperAbsence(results);
      if (
        completeAbsence &&
        topologyGeneration !== undefined &&
        topologyGeneration === previousAbsentTopology
      ) {
        return { ...result, stableAbsence: true };
      }
      previousAbsentTopology = completeAbsence ? topologyGeneration : undefined;
      if (attempt + 1 < OUTBOUND_RECONCILE_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, OUTBOUND_RECONCILE_INTERVAL_MS);
        });
      }
    }
    return result;
  };
  const reconcilePendingOutboundCall = async (): Promise<void> => {
    const pending = outboundCallPending;
    if (!pending) {
      return;
    }
    try {
      const result = await findOutgoingCallDuringReconciliation(
        pending.handle,
        pending.callUUID,
        pending.dialID,
        pending.proxyIdentifier,
        pending.requestedAt,
        pending.mode,
      );
      if (outboundCallPending !== pending) {
        return;
      }
      retainOutboundCarrierPeers(result);
      const reconciledCallUUID = readOutboundCallUUID(result);
      if (reconciledCallUUID) {
        retainFaceTimeDialCallUUID(pending, reconciledCallUUID);
        persistOutboundCallPending();
      }
      const reconciledProxyIdentifier = readOutboundProxyIdentifier(result);
      if (reconciledProxyIdentifier) {
        pending.proxyIdentifier = reconciledProxyIdentifier;
        persistOutboundCallPending();
      }
      if (!reconciledCallUUID && !reconciledProxyIdentifier) {
        const helperResults = readHelperResults(result);
        const helpersContacted =
          typeof result.helpersContacted === "number"
            ? result.helpersContacted
            : helperResults.length;
        if (
          result.stableAbsence === true &&
          result.topologyComplete === true &&
          helperResults.length === helpersContacted &&
          hasDialHelperConfirmation(helperResults) &&
          hasDefinitiveDialHelperAbsence(helperResults) &&
          helperResults.every((entry) => entry.found === false)
        ) {
          clearOutboundCallPending();
        }
      }
    } catch (error) {
      params.logger.debug?.(
        `[facetime] outbound dial reconciliation deferred: ${formatErrorMessage(error)}`,
      );
    }
  };
  const scheduleOutboundReconciliation = () => {
    if (
      stopping ||
      outboundReconcileTimer ||
      !outboundCallPending ||
      helper.connectedSockets === 0
    ) {
      return;
    }
    const pending = outboundCallPending;
    outboundReconcileTimer = setTimeout(() => {
      outboundReconcileTimer = undefined;
      void reconcilePendingOutboundCall().finally(() => {
        if (outboundCallPending === pending) {
          scheduleOutboundReconciliation();
        }
      });
    }, OUTBOUND_RECONCILE_DELAY_MS);
    outboundReconcileTimer.unref?.();
  };
  const cancelPendingOutboundCall = async (): Promise<
    | {
        callUUID?: string;
        dialID: string;
        handle: string;
      }
    | undefined
  > => {
    if (!outboundCallPending && !outboundDialInFlight) {
      return undefined;
    }
    const pending = outboundCallPending;
    if (!pending) {
      return undefined;
    }
    const { handle, dialID } = pending;
    let { callUUID } = pending;
    pending.delivery = "cancelling";
    persistOutboundCallPending();
    const result = await helper.cancelOutgoingCall({
      dialID,
      handle,
      callUUID,
      proxyIdentifier: pending.proxyIdentifier,
      requestedAt: pending.requestedAt,
      mode: pending.mode,
    });
    retainOutboundCarrierPeers(result);
    const helperResults = readHelperResults(result);
    const cancelled = helperResults.some((entry) => entry.cancelled === true);
    const helpersContacted =
      typeof result.helpersContacted === "number" ? result.helpersContacted : helperResults.length;
    const definitivelyAbsent =
      helperResults.length === helpersContacted &&
      hasDialHelperConfirmation(helperResults) &&
      helperResults.every((entry) => entry.found === false && entry.cancelled === false);
    if (!cancelled && !definitivelyAbsent) {
      throw new Error("FaceTime helper could not confirm outbound call cancellation");
    }
    callUUID = helperResults.map(readOutboundCallUUID).find((value) => Boolean(value)) ?? callUUID;
    scheduleOutboundReconciliation();
    return { ...(callUUID ? { callUUID } : {}), dialID, handle };
  };
  let helperTopologyVersion = 0;
  const helperEndpoint = resolveFaceTimeHelperEndpoint();
  const callEventRef: {
    current?: ReturnType<typeof createFaceTimeCallEventHandler>;
  } = {};
  const helper = new FaceTimeHelperSocketServer({
    ...helperEndpoint,
    logger: params.logger,
    ipcKey: helperIpcKey,
    buildId: helperBuildId,
    onMessage(message, peer) {
      const outboundIdentity = normalizeFaceTimeOutboundIdentityEvent(message);
      if (outboundIdentity && outboundCallPending?.dialID === outboundIdentity.data.dial_id) {
        if (OUTBOUND_DIAL_HELPER_BUNDLES.has(peer.bundleIdentifier)) {
          outboundCarrierPeers.set(peer.processId, peer);
        }
        retainFaceTimeDialCallUUID(outboundCallPending, outboundIdentity.data.call_uuid);
        outboundCallPending.proxyIdentifier =
          outboundIdentity.data.proxy_identifier ?? outboundCallPending.proxyIdentifier;
        persistOutboundCallPending();
        return;
      }
      const event = normalizeFaceTimeCallEvent(message);
      if (event) {
        void callEventRef.current?.handleCallEvent(event, peer).catch((error: unknown) => {
          params.logger.warn(`[facetime] call event handling failed: ${formatErrorMessage(error)}`);
        });
      }
    },
    onConnect(bundleIdentifier) {
      helperTopologyVersion += 1;
      helperSupervisor?.connected(bundleIdentifier);
      for (const call of calls.values()) {
        if (call.carrierHangupPending) {
          void attemptCarrierHangup(call, "helper-reconnected");
        }
      }
      void reconcilePendingOutboundCall().finally(scheduleOutboundReconciliation);
    },
    onDisconnect(bundleIdentifier) {
      helperTopologyVersion += 1;
      helperSupervisor?.disconnected(bundleIdentifier);
      if (stopping || calls.size === 0) {
        return;
      }
      // The helper socket is the only carrier control path. Keep the process tap
      // and route monitor alive until the helper reconnects or the call ends.
      params.logger.warn(
        "[facetime] carrier helper disconnected during a call; retaining audio safety bridge",
      );
      // Call events do not identify which helper owns the carrier. Another
      // app's remaining socket cannot prove control of this call is intact.
      for (const call of calls.values()) {
        void attemptCarrierHangup(call, "helper-disconnected");
      }
    },
    onStale(bundleIdentifier, processId) {
      helperSupervisor?.stale(bundleIdentifier, processId);
    },
  });
  helperRef.current = helper;

  const callControl = createFaceTimeCallControl({
    calls,
    helper,
    config,
    fullConfig: params.fullConfig,
    runtime: params.runtime,
    logger: params.logger,
    captureBinary,
    isStopping: () => stopping,
    getHelperTopologyVersion: () => helperTopologyVersion,
    retainHelperResultPeers,
  });
  const { attemptCarrierHangup, closeCall, terminateCarrierProcesses } = callControl;
  callEventRef.current = createFaceTimeCallEventHandler({
    calls,
    helper,
    config,
    logger: params.logger,
    callControl,
    isStopping: () => stopping,
    isDriverInstallPending,
    getPendingDial: () => outboundCallPending,
    clearPendingDial: () => clearOutboundCallPending(),
    persistPendingDial: persistOutboundCallPending,
    outboundCarrierPeers,
    cancelPendingDial: async (pending) => {
      if (outboundCallPending === pending) {
        await cancelPendingOutboundCall();
      }
    },
  });

  await helper.start();
  helperSupervisor.start();
  params.logger.info(
    `[facetime] listening for FaceTime helper events on ${helperEndpoint.host}:${helperEndpoint.port}`,
  );
  const readStatus = async (): Promise<FaceTimeRuntimeStatus> =>
    buildFaceTimeRuntimeStatus({
      calls,
      helperConnected: helper.connectedSockets > 0,
      helperTargets: helperSupervisor.status(),
      driverInstall,
      pendingDial: outboundCallPending,
    });
  const runPreflight = async (): Promise<FaceTimePreflightResult> =>
    await runFaceTimePreflight({
      config,
      fullConfig: params.fullConfig,
      runtime: params.runtime,
      logger: params.logger,
      helperConnected: helper.connectedSockets > 0,
      captureBinary,
    });

  return {
    config,
    async status() {
      return await readStatus();
    },
    async dial(dialParams) {
      if (stopping) {
        throw new Error("cannot start an outbound FaceTime call while the plugin is stopping");
      }
      if (isDriverInstallPending()) {
        throw new Error(
          "cannot start an outbound FaceTime call while audio driver installation is pending",
        );
      }
      if (calls.size > 0) {
        throw new Error("cannot start an outbound FaceTime call while another call is active");
      }
      if (outboundCallPending) {
        throw new Error(
          `outbound FaceTime ${outboundCallPending.mode} call is already pending for ${outboundCallPending.handle}`,
        );
      }
      if (outboundDialInFlight) {
        throw new Error("cannot start an outbound FaceTime call while another dial is in flight");
      }
      const request = resolveFaceTimeDialRequest({
        handle: dialParams.handle,
        mode: dialParams.mode,
        ownerHandles: config.ownerHandles,
      });
      const dialID = randomUUID();
      const requestedAt = new Date().toISOString();
      outboundCallPending = {
        ...request,
        version: 1,
        ownerEpoch: 1,
        dialID,
        delivery: "in-flight",
        requestedAt,
      };
      persistOutboundCallPending();
      const dialPromise = (async (): Promise<FaceTimeDialResult> => {
        const helperResult = await helper.startCall(request, dialID, requestedAt);
        retainOutboundCarrierPeers(helperResult);
        const result = resolveFaceTimeDialResult({ dialID, request, helper: helperResult });
        const callUUID = result.callUUID;
        if (outboundCallPending?.dialID === dialID) {
          outboundCallPending.delivery = "accepted";
          // The helper can emit native identity before its action reply arrives.
          // A reply without identity must not erase that earlier exact match.
          if (callUUID) {
            retainFaceTimeDialCallUUID(outboundCallPending, callUUID);
          }
          if (result.proxyIdentifier) {
            outboundCallPending.proxyIdentifier = result.proxyIdentifier;
          }
          persistOutboundCallPending();
          scheduleOutboundReconciliation();
        }
        // TelephonyUtilities may accept the dial before assigning a UUID. The
        // later outgoing status event owns correlation in that normal state.
        return result;
      })();
      outboundDialInFlight = dialPromise;
      try {
        return await dialPromise;
      } catch (error) {
        // A helper-declared rejection means dialing did not begin. Transport
        // errors are ambiguous, so retain ownership until helper polling
        // correlates an outgoing event or an operator cancels the request.
        if (
          error instanceof FaceTimeHelperActionError ||
          error instanceof FaceTimeHelperUnavailableError
        ) {
          if (outboundCallPending?.dialID === dialID) {
            clearOutboundCallPending();
          }
        } else {
          if (outboundCallPending?.dialID === dialID) {
            outboundCallPending.delivery = "ambiguous";
            if (error instanceof FaceTimeHelperAmbiguousError) {
              const callUUID = readOutboundCallUUID(error.result);
              const proxyIdentifier = readOutboundProxyIdentifier(error.result);
              if (callUUID) {
                retainFaceTimeDialCallUUID(outboundCallPending, callUUID);
              }
              if (proxyIdentifier) {
                outboundCallPending.proxyIdentifier = proxyIdentifier;
              }
            }
            persistOutboundCallPending();
          }
          if (outboundDialInFlight === dialPromise) {
            outboundDialInFlight = undefined;
          }
          await reconcilePendingOutboundCall();
          scheduleOutboundReconciliation();
        }
        throw error;
      } finally {
        if (outboundDialInFlight === dialPromise) {
          outboundDialInFlight = undefined;
        }
      }
    },
    async hangup(hangupParams) {
      const requestedCallUUID =
        typeof hangupParams?.callUUID === "string" && hangupParams.callUUID.trim()
          ? hangupParams.callUUID.trim()
          : undefined;
      const findCall = () =>
        requestedCallUUID
          ? calls.get(requestedCallUUID)
          : ([...calls.values()].find((candidate) => candidate.talk) ?? [...calls.values()][0]);
      let call = findCall();
      if (!call) {
        if (
          !requestedCallUUID ||
          (outboundCallPending &&
            doesPendingFaceTimeDialHaveCallUUID(outboundCallPending, requestedCallUUID))
        ) {
          const canceled = await cancelPendingOutboundCall();
          if (canceled) {
            return {
              ...(canceled.callUUID ? { callUUID: canceled.callUUID } : {}),
              dialID: canceled.dialID,
            };
          }
        }
        // The helper emits active status before acknowledging the dial. Let
        // that async event handler finish registering the call, then re-read.
        for (let attempt = 0; attempt < OUTBOUND_RECONCILE_ATTEMPTS && !call; attempt += 1) {
          call = findCall();
          if (!call && attempt + 1 < OUTBOUND_RECONCILE_ATTEMPTS) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, OUTBOUND_RECONCILE_INTERVAL_MS);
            });
          }
        }
      }
      if (!call) {
        throw new Error("no active FaceTime call to hang up");
      }
      const closed = await attemptCarrierHangup(call, "operator-hangup");
      if (!closed) {
        throw new Error(`carrier hangup pending for ${call.callUUID}; retry scheduled`);
      }
      return { callUUID: call.callUUID };
    },
    async setup() {
      const preflight = runPreflight();
      // Setup overlaps the live loopback with static checks. Observe failures
      // immediately, then let runFaceTimeSetup surface the same rejection.
      void preflight.catch(() => undefined);
      // Refresh after preflight because helper injection can finish while the
      // live loopback runs. A failed preflight is reported by setup itself.
      const runtimeStatus = preflight.then(
        () => readStatus(),
        () => readStatus(),
      );
      return await runFaceTimeSetup({
        config,
        pluginRoot: params.pluginRoot,
        runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
        runtimeStatus,
        preflight,
      });
    },
    async preflight() {
      return await runPreflight();
    },
    async installDriver() {
      if (stopping) {
        throw new Error("cannot install the FaceTime audio driver while the plugin is stopping");
      }
      if (isDriverInstallPending()) {
        throw new Error("FaceTime audio driver installation is already pending");
      }
      if (calls.size > 0 || outboundCallPending || outboundDialInFlight) {
        throw new Error(
          "Cannot install the FaceTime audio driver during an active or pending call",
        );
      }
      // Hold this gate across the build and administrator prompt. Dial and
      // auto-answer consult it before claiming a call, so Core Audio cannot be
      // restarted underneath a newly managed call.
      driverInstall = {
        phase: "installing",
        startedAt: new Date().toISOString(),
      };
      const installAbortController = new AbortController();
      driverInstallAbortController = installAbortController;
      driverInstallTask = installFaceTimeDriver({
        pluginRoot: params.pluginRoot,
        runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
        callActive: false,
        signal: installAbortController.signal,
      })
        .then((result) => {
          driverInstall = {
            phase: "succeeded",
            startedAt: driverInstall.startedAt,
            finishedAt: new Date().toISOString(),
            changed: result.changed,
          };
          params.logger.info(
            `[facetime] audio driver installation ${result.changed ? "completed" : "already current"}`,
          );
        })
        .catch((error: unknown) => {
          const message = formatErrorMessage(error);
          driverInstall = {
            phase: "failed",
            startedAt: driverInstall.startedAt,
            finishedAt: new Date().toISOString(),
            error: message,
          };
          params.logger.warn(`[facetime] audio driver installation failed: ${message}`);
        })
        .finally(() => {
          if (driverInstallAbortController === installAbortController) {
            driverInstallAbortController = undefined;
            driverInstallTask = undefined;
          }
        });
      return { started: true };
    },
    async stop() {
      stopping = true;
      driverInstallAbortController?.abort();
      await driverInstallTask;
      let cleanupError: Error | undefined;
      let pendingCleanupError: Error | undefined;
      const shutdownPending = outboundCallPending;
      if (outboundCallPending || outboundDialInFlight) {
        try {
          await cancelPendingOutboundCall();
        } catch (error) {
          pendingCleanupError = new Error(
            `outbound FaceTime dial cleanup failed: ${formatErrorMessage(error)}`,
          );
        }
        await reconcilePendingOutboundCall();
        if (!outboundCallPending) {
          pendingCleanupError = undefined;
        }
        if (outboundCallPending === shutdownPending && calls.size === 0 && shutdownPending) {
          const pendingEpoch = shutdownPending.ownerEpoch;
          try {
            await terminateExactCarrierProcesses({
              runtime: params.runtime,
              peers: outboundCarrierPeers,
              assertCurrent: () => {
                if (
                  outboundCallPending !== shutdownPending ||
                  shutdownPending.ownerEpoch !== pendingEpoch
                ) {
                  throw new Error("pending FaceTime dial changed during fail-closed shutdown");
                }
              },
            });
            clearOutboundCallPending(shutdownPending.dialID);
            pendingCleanupError = undefined;
          } catch (error) {
            pendingCleanupError ??= new Error(
              `pending FaceTime carrier termination failed: ${formatErrorMessage(error)}`,
            );
          }
        }
        cleanupError ??= pendingCleanupError;
      }
      for (const call of calls.values()) {
        const closed = await attemptCarrierHangup(call, "runtime-stop", {
          scheduleRetry: false,
        });
        if (!closed) {
          try {
            await terminateCarrierProcesses(call);
            await closeCall(call, "runtime-stop-carrier-terminated");
          } catch (error) {
            try {
              if (!call.talk) {
                throw new Error("native carrier watchdog is unavailable", { cause: error });
              }
              await call.talk.failClosed("runtime-stop-native-watchdog");
              await closeCall(call, "runtime-stop-native-watchdog");
            } catch (watchdogError) {
              cleanupError ??= new Error(
                `FaceTime fail-closed carrier termination failed: ${formatErrorMessage(error)}; native watchdog: ${formatErrorMessage(watchdogError)}`,
              );
            }
          }
        }
      }
      await helperSupervisor.stop();
      await helper.stop();
      if (cleanupError) {
        throw cleanupError;
      }
    },
  };
}
