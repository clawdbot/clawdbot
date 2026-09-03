import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Connection instructions load with their dialog instead of every UI startup.
const enNewSessionConnect = {
  newSession: {
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

export const registerNewSessionConnectEnglish = Object.assign(
  () => {
    // SAFETY: The canonical catalog defines newSession as an object; this only extends it.
    Object.assign(en.newSession as TranslationMap, enNewSessionConnect.newSession);
  },
  { catalog: enNewSessionConnect },
);
