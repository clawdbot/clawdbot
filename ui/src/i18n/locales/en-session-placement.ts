import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Session-placement recovery copy is registered with the lazy chat placement
// surfaces so device recovery does not tax every Control UI startup.
const enSessionPlacement = {
  sessionsView: {
    placementFactService: "Service",
    placementFactProfile: "Profile",
    placementFactMachine: "Machine",
    placementFactState: "State",
    placementFactDisk: "Disk",
    placementDiskFree: "{free} free",
    runsOnDevice: "Runs on device",
    runsOnWorker: "Runs on worker",
    stopWorker: "Stop worker…",
    stopWorkerConfirm: 'Stop the worker for "{session}"?',
    stopWorkerConfirmAction: "Stop worker",
    deviceOffline: "Device offline",
    waitingForDevice: "Waiting for device to reconnect; retry after it returns.",
    continueOnGatewayMenu: "Continue on Gateway…",
    continueOnGatewayAction: "Continue on Gateway",
    continueOnGatewayConfirm:
      'Continue "{session}" on the Gateway? Unsynced device files and in-flight work may be lost. OpenClaw will continue from the last Gateway-synced state and will not replay the interrupted turn.',
    stopDeviceWorker: "Stop device worker…",
    offlineDeviceStopUnavailable:
      "Reconnect the device to stop and sync its workspace, or Continue on Gateway.",
    stopDeviceWorkerConfirm: 'Stop the device worker for "{session}"?',
    stopDeviceWorkerConfirmAction: "Stop device worker",
    restartSession: "Restart session…",
    restartingSession: "Restarting session…",
    restartSessionTitle: "Restart session",
    restartSessionDescription: 'Choose where "{session}" should restart.',
    restartSessionWarning:
      "A new worker starts from the last reconciled worktree. Changes that the previous worker did not upload may be lost.",
    restartSessionAction: "Restart session",
    stoppingSession: "Stopping session…",
    finishingSessionMove: "Finishing session move…",
    failedSessionTitle: "Runner failed",
    failedSessionRestartPrompt: "Restart this session to continue.",
    failedSessionStopPrompt: "Stop the failed worker before restarting this session.",
    failedSessionUnavailable: "This session's runner failed and cannot accept messages.",
  },
} satisfies TranslationMap;

export const registerSessionPlacementEnglish = Object.assign(
  () => {
    // SAFETY: The canonical English catalog defines sessionsView as an object; this only extends it.
    Object.assign(en.sessionsView as TranslationMap, enSessionPlacement.sessionsView);
  },
  { catalog: enSessionPlacement },
);
