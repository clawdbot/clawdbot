export const PLUGIN_DECLARED_SURFACE_GROUPS = [
  "channels",
  "providers",
  "tools",
  "contracts",
  "hooks",
  "mcpServers",
  "cliCommands",
  "cliBackends",
  "skills",
  "dangerousConfigFlags",
] as const;

export type PluginDeclaredSurfaceGroup = (typeof PLUGIN_DECLARED_SURFACE_GROUPS)[number];
