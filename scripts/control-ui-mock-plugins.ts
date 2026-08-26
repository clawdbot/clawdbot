// Plugin-catalog fixtures for the Control UI mock dev harness.

export function buildPluginCatalogMock() {
  const entry = (params: {
    id: string;
    name: string;
    description: string;
    category: string;
    origin: string;
    installed: boolean;
    enabled?: boolean;
    featured?: boolean;
    install?: { source: "official"; pluginId: string };
  }) => ({
    id: params.id,
    name: params.name,
    description: params.description,
    version: "1.4.0",
    origin: params.origin,
    installed: params.installed,
    enabled: params.installed && (params.enabled ?? true),
    state: params.installed ? ((params.enabled ?? true) ? "enabled" : "disabled") : "not-installed",
    category: params.category,
    featured: params.featured ?? false,
    removable: params.installed && params.origin !== "bundled",
    ...(params.install ? { install: params.install } : {}),
  });
  return {
    plugins: [
      entry({
        id: "telegram",
        name: "Telegram",
        description: "Chat with your agent from Telegram DMs and groups.",
        category: "channel",
        origin: "bundled",
        installed: true,
      }),
      entry({
        id: "discord",
        name: "Discord",
        description: "Bridge agents into Discord servers and DMs.",
        category: "channel",
        origin: "global",
        installed: true,
        enabled: false,
      }),
      entry({
        id: "memory-wiki",
        name: "Memory Wiki",
        description: "Long-term wiki-style memory for people and projects.",
        category: "memory",
        origin: "bundled",
        installed: true,
      }),
      entry({
        id: "browser",
        name: "Browser",
        description: "Drive a managed browser profile for research and automation.",
        category: "tool",
        origin: "official",
        installed: false,
        featured: true,
        install: { source: "official", pluginId: "browser" },
      }),
      entry({
        id: "canvas",
        name: "Canvas",
        description: "Generate and preview visual artifacts from sessions.",
        category: "tool",
        origin: "official",
        installed: false,
        install: { source: "official", pluginId: "canvas" },
      }),
    ],
    diagnostics: [],
    mutationAllowed: true,
  };
}

/** Parameterized plugins.inspect fixtures for the consent dialog and detail overlay. */
export function buildPluginInspectMock() {
  const emptyDeclared = {
    channels: [],
    providers: [],
    tools: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  };
  const grants = (params: { bundled: boolean; conversationConfigured?: boolean }) => ({
    hooks: {
      allowPromptInjection: { effective: true },
      allowConversationAccess: {
        effective: params.bundled || params.conversationConfigured === true,
        ...(params.conversationConfigured !== undefined
          ? { configured: params.conversationConfigured }
          : {}),
      },
    },
  });
  return {
    cases: [
      {
        match: { pluginId: "telegram" },
        response: {
          ok: true,
          plugin: {
            id: "telegram",
            name: "Telegram",
            version: "1.4.0",
            description: "Chat with your agent from Telegram DMs and groups.",
            origin: "bundled",
            installed: true,
            enabled: true,
          },
          source: { kind: "bundled" },
          declared: {
            ...emptyDeclared,
            channels: ["telegram"],
            cliCommands: ["telegram"],
          },
          grants: grants({ bundled: true }),
        },
      },
      {
        match: { pluginId: "discord" },
        response: {
          ok: true,
          plugin: {
            id: "discord",
            name: "Discord",
            version: "1.4.0",
            description: "Bridge agents into Discord servers and DMs.",
            origin: "global",
            installed: true,
            enabled: false,
          },
          source: {
            kind: "npm",
            spec: "@openclaw/discord@1.4.0",
            packageName: "@openclaw/discord",
            integrity: "sha512-Zt8FjB1uT0mMyF5b0z0aH4dKq7wVn0m8rW3o5cQx1JYb1sB4kQ2u5w9c1p6nEo3q",
            integrityKind: "ssri",
          },
          declared: {
            ...emptyDeclared,
            channels: ["discord"],
            tools: ["discord_actions"],
            skills: ["discord"],
          },
          grants: grants({ bundled: false }),
          trust: {
            disposition: "clean",
            checkedAt: "2026-08-20T14:03:00Z",
          },
        },
      },
      {
        match: { pluginId: "memory-wiki" },
        response: {
          ok: true,
          plugin: {
            id: "memory-wiki",
            name: "Memory Wiki",
            version: "1.4.0",
            origin: "bundled",
            installed: true,
            enabled: true,
          },
          source: { kind: "bundled" },
          declared: {
            ...emptyDeclared,
            tools: ["memory_search", "memory_write"],
          },
          grants: grants({ bundled: true }),
        },
      },
      {
        match: { pluginId: "browser" },
        response: {
          ok: true,
          plugin: {
            id: "browser",
            name: "Browser",
            version: "1.4.0",
            description: "Drive a managed browser profile for research and automation.",
            origin: "official",
            installed: false,
            enabled: false,
          },
          source: {
            kind: "official-catalog",
            spec: "clawhub:openclaw/browser@1.4.0",
            packageName: "openclaw/browser",
            integrity: "2f7c1a9be03d5c44a8a14a4e9d0d5375f4f3f0f5f7f1b9f2c3d4e5f60718293a",
            integrityKind: "sha256",
          },
          declared: {
            ...emptyDeclared,
            tools: ["browser_navigate", "browser_screenshot", "browser_click"],
            cliCommands: ["browser"],
            dangerousConfigFlags: ["allowHostControl"],
          },
          grants: grants({ bundled: false }),
          trust: {
            disposition: "clean",
            checkedAt: "2026-08-22T09:41:00Z",
          },
        },
      },
      {
        match: { pluginId: "canvas" },
        response: {
          ok: true,
          plugin: {
            id: "canvas",
            name: "Canvas",
            version: "1.4.0",
            origin: "official",
            installed: false,
            enabled: false,
          },
          source: { kind: "official-catalog", packageName: "openclaw/canvas" },
          declared: { ...emptyDeclared, tools: ["canvas_render"] },
          grants: grants({ bundled: false }),
        },
      },
    ],
  };
}

export function buildPluginSetEnabledMock() {
  const plugin = buildPluginCatalogMock().plugins.find((entry) => entry.id === "discord");
  const inspection = buildPluginInspectMock().cases.find(
    (entry) => entry.match.pluginId === "discord",
  )?.response;
  if (!plugin || !inspection) {
    throw new Error("Discord mock plugin fixtures are missing");
  }

  const declared = {
    ...inspection.declared,
    providers: ["discord-intelligence"],
    tools: [...inspection.declared.tools, "discord_moderate"],
  };
  return {
    cases: [
      {
        match: { pluginId: plugin.id, enabled: true, acknowledgeCapabilities: true },
        response: {
          ok: true,
          plugin: { ...plugin, enabled: true, state: "enabled" },
          restartRequired: true,
        },
      },
      {
        match: { pluginId: plugin.id, enabled: true },
        response: {
          __mockError: {
            code: "INVALID_REQUEST",
            message: 'Plugin "discord" requires capability consent',
            details: {
              capabilityConsentCode: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
              pluginId: plugin.id,
              name: plugin.name,
              version: plugin.version,
              declared,
              grants: inspection.grants,
              source: inspection.source,
              ...(inspection.trust ? { trust: inspection.trust } : {}),
              widened: {
                providers: ["discord-intelligence"],
                tools: ["discord_moderate"],
              },
              acceptedAt: "2026-08-20T14:03:00Z",
            },
          },
        },
      },
    ],
  };
}
