import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Session-placement recovery copy is registered with the lazy chat placement
// surfaces so device recovery does not tax every Control UI startup.
const enSessionPlacement = {
  sessionsView: {
    runsOnDevice: "Runs on device",
    deviceOffline: "Device offline",
    waitingForDevice: "Waiting for device to reconnect; retry after it returns.",
    continueOnGatewayMenu: "Continue on Gateway…",
    continueOnGatewayAction: "Continue on Gateway",
    continueOnGatewayConfirm:
      'Continue "{session}" on the Gateway? Unsynced device files and in-flight work may be lost. OpenClaw will continue from the last Gateway-synced state and will not replay the interrupted turn.',
    stopDeviceWorker: "Stop device worker…",
    offlineDeviceStopUnavailable:
      "Reconnect the device to stop and sync its workspace, or Continue on Gateway.",
    stopDeviceWorkerConfirm: 'Stop the device worker for "{session}" after it reconnects?',
    stopDeviceWorkerConfirmAction: "Stop device worker",
  },
} satisfies TranslationMap;

export const registerSessionPlacementEnglish = Object.assign(
  () => {
    // SAFETY: The canonical English catalog defines sessionsView as an object; this only extends it.
    Object.assign(en.sessionsView as TranslationMap, enSessionPlacement.sessionsView);
  },
  { catalog: enSessionPlacement },
);
