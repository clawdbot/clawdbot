import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";

export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "google",
    label: "Google",
    providerIds: ["google", "google-antigravity", "google-gemini-cli", "google-vertex"],
    runtimeIds: ["google-gemini-cli"],
    cliSessionKeys: ["google-gemini-cli", "gemini-cli"],
    authProfilePrefixes: [
      "google:",
      "google-antigravity:",
      "google-gemini-cli:",
      "google-vertex:",
      "gemini-cli:",
    ],
  },
];
