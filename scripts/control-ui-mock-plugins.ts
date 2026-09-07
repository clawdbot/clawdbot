// Plugin-catalog fixtures for the Control UI mock dev harness.
import { createHash } from "node:crypto";
import type {
  PluginDeclaredSurface,
  PluginsInspectResult,
} from "../packages/gateway-protocol/src/schema/plugins.js";

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
    hasIcon?: boolean;
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
    ...(params.hasIcon ? { hasIcon: true } : {}),
    ...(params.install ? { install: params.install } : {}),
  });
  return {
    plugins: [
      entry({
        id: "whatsapp",
        name: "WhatsApp",
        description: "OpenClaw WhatsApp channel plugin for WhatsApp Web chats.",
        category: "channel",
        origin: "bundled",
        installed: true,
        hasIcon: true,
      }),
      entry({
        id: "telegram",
        name: "Telegram",
        description: "OpenClaw Telegram channel plugin.",
        category: "channel",
        origin: "bundled",
        installed: true,
        hasIcon: true,
      }),
      entry({
        id: "discord",
        name: "Discord",
        description: "Bridge agents into Discord servers and DMs.",
        category: "channel",
        origin: "global",
        installed: true,
        enabled: false,
        hasIcon: true,
      }),
      entry({
        id: "googlechat",
        name: "Google Chat",
        description: "OpenClaw Google Chat channel plugin for spaces and direct messages.",
        category: "channel",
        origin: "bundled",
        installed: true,
        hasIcon: true,
      }),
      entry({
        id: "slack",
        name: "Slack",
        description: "OpenClaw Slack channel plugin for channels, DMs, commands, and app events.",
        category: "channel",
        origin: "bundled",
        installed: true,
        hasIcon: true,
      }),
      entry({
        id: "signal",
        name: "Signal",
        description: "OpenClaw Signal channel plugin.",
        category: "channel",
        origin: "bundled",
        installed: true,
        hasIcon: true,
      }),
      entry({
        id: "imessage",
        name: "iMessage",
        description: "OpenClaw iMessage channel plugin using imsg on a signed-in Mac.",
        category: "channel",
        origin: "bundled",
        installed: true,
        hasIcon: true,
      }),
      entry({
        id: "nostr",
        name: "Nostr",
        description: "OpenClaw Nostr channel plugin for NIP-04 encrypted direct messages.",
        category: "channel",
        origin: "bundled",
        installed: true,
        hasIcon: true,
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
  const emptyDeclared: PluginDeclaredSurface = {
    channels: [],
    providers: [],
    tools: [],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  };
  const fixtures = new Map<
    string,
    {
      source: NonNullable<PluginsInspectResult["source"]>;
      declared: Partial<PluginDeclaredSurface>;
      trust?: PluginsInspectResult["trust"];
    }
  >([
    ["whatsapp", { source: { kind: "bundled" }, declared: { channels: ["whatsapp"] } }],
    [
      "telegram",
      {
        source: { kind: "bundled" },
        declared: { channels: ["telegram"], cliCommands: ["telegram"] },
      },
    ],
    ["googlechat", { source: { kind: "bundled" }, declared: { channels: ["googlechat"] } }],
    ["slack", { source: { kind: "bundled" }, declared: { channels: ["slack"] } }],
    ["signal", { source: { kind: "bundled" }, declared: { channels: ["signal"] } }],
    ["imessage", { source: { kind: "bundled" }, declared: { channels: ["imessage"] } }],
    ["nostr", { source: { kind: "bundled" }, declared: { channels: ["nostr"] } }],
    [
      "discord",
      {
        source: {
          kind: "npm",
          spec: "@openclaw/discord@1.4.0",
          packageName: "@openclaw/discord",
          integrity: "sha512-Zt8FjB1uT0mMyF5b0z0aH4dKq7wVn0m8rW3o5cQx1JYb1sB4kQ2u5w9c1p6nEo3q",
          integrityKind: "ssri",
        },
        declared: {
          channels: ["discord"],
          providers: ["discord-intelligence"],
          tools: ["discord_actions", "discord_moderate"],
          contracts: ["tools: discord_actions", "tools: discord_moderate"],
          skills: ["discord"],
        },
        trust: { disposition: "clean", checkedAt: "2026-08-20T14:03:00Z" },
      },
    ],
    [
      "memory-wiki",
      { source: { kind: "bundled" }, declared: { tools: ["memory_search", "memory_write"] } },
    ],
    [
      "browser",
      {
        source: {
          kind: "official-catalog",
          spec: "clawhub:openclaw/browser@1.4.0",
          packageName: "openclaw/browser",
          integrity: "2f7c1a9be03d5c44a8a14a4e9d0d5375f4f3f0f5f7f1b9f2c3d4e5f60718293a",
          integrityKind: "sha256",
        },
        declared: {
          tools: ["browser_click", "browser_navigate", "browser_screenshot"],
          cliCommands: ["browser"],
          dangerousConfigFlags: ["allowHostControl"],
        },
        trust: { disposition: "clean", checkedAt: "2026-08-22T09:41:00Z" },
      },
    ],
    [
      "canvas",
      {
        source: { kind: "official-catalog", packageName: "openclaw/canvas" },
        declared: { tools: ["canvas_render"] },
      },
    ],
  ]);
  const cases = buildPluginCatalogMock().plugins.map((plugin) => {
    const fixture = fixtures.get(plugin.id);
    if (!fixture) {
      throw new Error(`Mock inspection is missing for plugin "${plugin.id}".`);
    }
    const declared = { ...emptyDeclared, ...fixture.declared };
    const response = {
      ok: true,
      plugin: {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        origin: plugin.origin,
        installed: plugin.installed,
        enabled: plugin.enabled,
      },
      source: fixture.source,
      declared,
      reviewToken: createHash("sha256").update(JSON.stringify(declared)).digest("hex"),
      grants: {
        hooks: {
          allowPromptInjection: { effective: true },
          allowConversationAccess: { effective: plugin.origin === "bundled" },
        },
      },
      ...(fixture.trust ? { trust: fixture.trust } : {}),
    } satisfies PluginsInspectResult;
    return { match: { pluginId: plugin.id }, response };
  });
  return { cases };
}

export function buildPluginSetEnabledMock() {
  const plugin = buildPluginCatalogMock().plugins.find((entry) => entry.id === "discord");
  const inspection = buildPluginInspectMock().cases.find(
    (entry) => entry.match.pluginId === "discord",
  )?.response;
  if (!plugin || !inspection) {
    throw new Error("Discord mock plugin fixtures are missing");
  }

  return {
    cases: [
      {
        match: {
          pluginId: plugin.id,
          enabled: true,
          acknowledgeCapabilities: { reviewToken: inspection.reviewToken },
        },
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
              reviewToken: inspection.reviewToken,
              widened: {
                providers: ["discord-intelligence"],
                tools: ["discord_moderate"],
                contracts: ["tools: discord_moderate"],
              },
              acceptedAt: "2026-08-20T14:03:00Z",
            },
          },
        },
      },
    ],
  };
}
