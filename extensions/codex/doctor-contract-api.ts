import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";

export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "codex",
    label: "Codex",
    providerIds: ["codex", "codex-cli", "openai-codex"],
    runtimeIds: ["codex", "codex-cli"],
    cliSessionKeys: ["codex-cli"],
    authProfilePrefixes: ["codex:", "codex-cli:", "openai-codex:"],
  },
];
