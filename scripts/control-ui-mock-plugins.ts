// Plugin-catalog fixtures for the Control UI mock dev harness.

export function buildPluginCatalogMock() {
  const entry = (params: {
    id: string;
    name: string;
    description: string;
    category: string;
    installed: boolean;
    enabled?: boolean;
    featured?: boolean;
  }) => ({
    id: params.id,
    name: params.name,
    description: params.description,
    version: "1.4.0",
    installed: params.installed,
    enabled: params.installed && (params.enabled ?? true),
    state: params.installed ? ((params.enabled ?? true) ? "enabled" : "disabled") : "not-installed",
    category: params.category,
    featured: params.featured ?? false,
    removable: params.installed,
  });
  return {
    plugins: [
      entry({
        id: "telegram",
        name: "Telegram",
        description: "Chat with your agent from Telegram DMs and groups.",
        category: "channel",
        installed: true,
      }),
      entry({
        id: "discord",
        name: "Discord",
        description: "Bridge agents into Discord servers and DMs.",
        category: "channel",
        installed: true,
        enabled: false,
      }),
      entry({
        id: "memory-wiki",
        name: "Memory Wiki",
        description: "Long-term wiki-style memory for people and projects.",
        category: "memory",
        installed: true,
      }),
      entry({
        id: "browser",
        name: "Browser",
        description: "Drive a managed browser profile for research and automation.",
        category: "tool",
        installed: false,
        featured: true,
      }),
      entry({
        id: "canvas",
        name: "Canvas",
        description: "Generate and preview visual artifacts from sessions.",
        category: "tool",
        installed: false,
      }),
    ],
    diagnostics: [],
    mutationAllowed: true,
  };
}
