export type PluginToolProfileMode = "none" | "required" | "all";

/** Resolves how a built-in core-tool profile treats plugin-owned tools. */
export function resolvePluginToolProfileMode(profile?: string): PluginToolProfileMode {
  switch (profile?.trim()) {
    case "coding":
    case "messaging":
      return "required";
    case "full":
      return "all";
    default:
      return "none";
  }
}
