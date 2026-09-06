import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Capability chip copy is registered when the lazy Devices page renders, so
// two dozen chip labels do not tax every Control UI startup.
const enDevices = {
  devices: {
    capabilities: {
      browser: { label: "Browser", description: "Browse and interact with web pages." },
      canvas: { label: "Canvas", description: "Present and interact with visual content." },
      screen: { label: "Screen", description: "Capture or record the screen." },
      computer: {
        label: "Computer",
        description: "Control desktop applications with the mouse and keyboard.",
      },
      file: { label: "Files", description: "Read and manage files on this device." },
      system: { label: "System", description: "Run commands and inspect this device." },
      mcp: { label: "MCP", description: "Use tools provided by MCP servers on this device." },
      localInference: {
        label: "Local inference",
        description: "Run models locally on this device.",
      },
      camera: { label: "Camera", description: "Capture photos and video with the device camera." },
      talk: { label: "Talk", description: "Have voice conversations through this device." },
      location: { label: "Location", description: "Read the device location." },
      notifications: {
        label: "Notifications",
        description: "Read and manage device notifications.",
      },
      contacts: { label: "Contacts", description: "Find and manage contacts." },
      calendar: { label: "Calendar", description: "Read and manage calendar events." },
      reminders: { label: "Reminders", description: "Read and manage reminders." },
      device: { label: "Device", description: "Read device information and status." },
      photos: { label: "Photos", description: "Browse the device photo library." },
      sms: { label: "SMS", description: "Read and send text messages." },
      health: { label: "Health", description: "Read health and fitness data." },
      motion: { label: "Motion", description: "Read movement and activity data." },
      runtime: "1 runtime",
      runtimes: "{count} runtimes",
      overflow: "{count} more capabilities",
    },
  },
} satisfies TranslationMap;

export const registerDevicesEnglish = Object.assign(
  () => {
    en.devices.capabilities = enDevices.devices.capabilities;
  },
  { catalog: enDevices },
);
