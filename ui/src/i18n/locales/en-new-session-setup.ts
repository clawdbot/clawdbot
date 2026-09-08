import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Session setup messages load with their consumers instead of every UI startup.
const enNewSessionSetup = {
  newSession: {
    cloudRequiresWorktree: "Cloud needs a Git checkout",
    restoringPreferences: "Restoring your last session setup…",
    checkingPlace: "Checking the selected place…",
    agentsUnavailable: "No agents are available on this Gateway yet.",
    terminalHostUnavailable:
      "Native CLI host unavailable. Check that the CLI is installed and the node is connected with its fresh-start command approved, then retry the catalog.",
    terminalDisabled: "Enable CLI agents and terminals in Gateway settings to start a native CLI.",
    terminalPlacementUnsupported:
      "Native CLI sessions use a specific host, not OpenClaw worker placement. Reset this draft and choose a native host.",
    terminalNeedsFolder: "Pick a folder before starting in a terminal.",
    noSessionHosts: "No session hosts are paired. Connect a machine with session hosting enabled.",
    deviceUnavailable: "Device unavailable. Reconnect it and try again.",
    sessionHostingDisabled:
      "Session hosting is disabled. Run openclaw connect --service --session-host on the device.",
    deviceCapacityUnavailable:
      "Worker capacity is unavailable. Restart the device session host and try again.",
    deviceNoSlots: "No worker slots are available. Wait for a slot or pick another device.",
    connectMachineTitle: "Connect a machine",
    connectMachineDescription: "Run this command on the machine you want to connect.",
    connectMachineGenerating: "Creating a secure connection link…",
    connectMachineFailed: "Couldn't create a connection link.",
    connectMachineMissingUrl: "The Gateway did not return a join URL. Update it and try again.",
    connectMachineUnavailable: "Reconnect to the Gateway and try again.",
    connectMachineTeamHint: "Running it pairs that machine as a device for your team.",
    connectMachineSingleUse: "This link is single-use and expires soon.",
    connectMachineSingleUseExpires: "This link is single-use and expires at {time}.",
    connectMachineFreshCode: "Mint fresh code",
    connectMachineRefreshing: "Minting…",
    connectMachineManageDevices: "Manage devices",
  },
} satisfies TranslationMap;

export const registerNewSessionSetupEnglish = Object.assign(
  () => {
    // SAFETY: The canonical catalog defines newSession as an object; this only extends it.
    Object.assign(en.newSession as TranslationMap, enNewSessionSetup.newSession);
  },
  { catalog: enNewSessionSetup },
);
