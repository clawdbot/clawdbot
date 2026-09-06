// Team Reports plugin entrypoint: GitHub + Discord activity reports served in the Control UI.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "team-reports",
  name: "Team Reports",
  description:
    "Daily, weekly, and monthly team activity reports from GitHub and Discord, with model-written summaries.",
  register() {
    // Skeleton: registration is implemented by the core lane (see src/).
  },
});
