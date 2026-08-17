import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
// Plugin-shape coherence contract for bundled channel plugins.
//
// Catalog routing keys off plugin ids, docs surfaces render `meta.docsPath`,
// and capability flags gate feature discovery, so every bundled channel must
// keep identity metadata aligned with its catalog id and capability flags
// coherent with the adapters that implement them. This suite already loads
// every bundled plugin, so it also owns loaded-plugin parity for lightweight
// artifacts while the artifact shards pin inventory, exports, and invocation.
//
// Capability rules verified against every bundled channel before pinning.
// Dropped for legitimate exceptions rather than special-casing:
// - threads=true does not imply a threading adapter (clickclack/tlon bind
//   threads through conversationBindings only).
// - nativeCommands=true does not imply a commands adapter (mattermost serves
//   slash commands through gateway HTTP routes).
// - blockStreaming=true does not imply a streaming adapter (coalesce tuning
//   is optional).
import { beforeAll, describe, expect, it } from "vitest";
import { listBundledPackageChannelMetadata } from "../../../plugins/bundled-package-channel-metadata.js";
import {
  getBundledChannelGatewayAuthArtifactAsync,
  getBundledChannelMessageToolArtifactAsync,
  getBundledChannelPluginAsync,
  getBundledChannelSessionKeyArtifactAsync,
  getBundledChannelThreadBindingArtifactAsync,
  listBundledChannelPluginIds,
} from "./test-helpers/bundled-channel-plugin-loader.js";

const CHAT_TYPES = new Set(["direct", "group", "channel", "thread"]);
const bundledChannelPluginIds = listBundledChannelPluginIds();
const packageMetadataById = new Map(
  listBundledPackageChannelMetadata().map((channel) => [channel.id, channel]),
);
const SHARED_SANITIZER_CHANNEL_IDS = [
  "nextcloud-talk",
  "zalo",
  "irc",
  "feishu",
  "signal",
  "twitch",
  "matrix",
  "slack",
  "msteams",
] as const;
const MESSAGE_TOOL_ARTIFACT_PLUGIN_IDS = ["imessage", "slack"] as const;
const SESSION_CONVERSATION_ARTIFACT_PLUGIN_IDS = ["feishu", "telegram"] as const;
const THREAD_BINDING_ARTIFACT_PLUGIN_IDS = ["discord", "matrix"] as const;
const PROVIDER_OWNED_READ_GATE_PLUGINS = [
  ["discord", true],
  ["feishu", true],
  ["matrix", true],
  ["msteams", true],
  ["slack", true],
  ["mattermost", ["read"]],
  ["telegram", ["react", "edit", "delete"]],
] as const;

type ExplicitSessionKeyNormalizer = (
  sessionKey: string,
  ctx: { ChatType?: string; From?: string; SenderId?: string },
) => string;

describe("bundled channel plugin shape coherence", () => {
  const plugins = new Map<string, Awaited<ReturnType<typeof getBundledChannelPluginAsync>>>();
  const messageToolArtifacts = new Map<
    string,
    Awaited<ReturnType<typeof getBundledChannelMessageToolArtifactAsync>>
  >();
  const sessionKeyArtifacts = new Map<
    string,
    Awaited<ReturnType<typeof getBundledChannelSessionKeyArtifactAsync>>
  >();
  const threadBindingArtifacts = new Map<
    string,
    Awaited<ReturnType<typeof getBundledChannelThreadBindingArtifactAsync>>
  >();
  let gatewayAuthArtifact: Awaited<ReturnType<typeof getBundledChannelGatewayAuthArtifactAsync>> =
    null;

  beforeAll(async () => {
    for (const id of bundledChannelPluginIds) {
      plugins.set(id, await getBundledChannelPluginAsync(id));
    }
    for (const id of MESSAGE_TOOL_ARTIFACT_PLUGIN_IDS) {
      messageToolArtifacts.set(id, await getBundledChannelMessageToolArtifactAsync(id));
    }
    gatewayAuthArtifact = await getBundledChannelGatewayAuthArtifactAsync("mattermost");
    for (const id of ["discord", ...SESSION_CONVERSATION_ARTIFACT_PLUGIN_IDS] as const) {
      sessionKeyArtifacts.set(id, await getBundledChannelSessionKeyArtifactAsync(id));
    }
    for (const id of THREAD_BINDING_ARTIFACT_PLUGIN_IDS) {
      threadBindingArtifacts.set(id, await getBundledChannelThreadBindingArtifactAsync(id));
    }
  });

  it("discovers bundled channel plugins from the catalog", () => {
    expect(bundledChannelPluginIds.length).toBeGreaterThan(0);
  });

  it.each(SHARED_SANITIZER_CHANNEL_IDS)(
    "%s applies shared sanitizer semantics to outbound text",
    (id) => {
      const sanitizeText = plugins.get(id)?.outbound?.sanitizeText;
      if (!sanitizeText) {
        throw new Error(`Missing outbound sanitizeText hook for ${id}`);
      }
      const visible = `Visible answer: ${id}`;
      const text = [
        '<invoke name="read">payload</invoke></minimax:tool_call>',
        '<tool_result>{"output":"hidden"}</tool_result>',
        "[Tool Call: read (ID: toolu_1)]",
        'Arguments: {"path":"/tmp/x"}',
        "<think>secret</think>",
        visible,
      ].join("\n");
      const expected = sanitizeAssistantVisibleText(text);

      expect(expected).toBe(visible);
      expect(sanitizeText({ text, payload: { text } })).toBe(expected);
    },
  );

  it.each(MESSAGE_TOOL_ARTIFACT_PLUGIN_IDS)(
    "keeps the %s message-tool artifact identical to the loaded plugin action surface",
    (id) => {
      const artifactDescribeMessageTool = messageToolArtifacts.get(id)?.describeMessageTool;
      const pluginDescribeMessageTool = plugins.get(id)?.actions?.describeMessageTool;

      expect(typeof artifactDescribeMessageTool).toBe("function");
      expect(typeof pluginDescribeMessageTool).toBe("function");
      expect(artifactDescribeMessageTool).toBe(pluginDescribeMessageTool);
    },
  );

  it("keeps the mattermost gateway-auth artifact identical to the loaded plugin gateway surface", () => {
    const artifactResolveGatewayAuthBypassPaths =
      gatewayAuthArtifact?.resolveGatewayAuthBypassPaths;
    const pluginResolveGatewayAuthBypassPaths =
      plugins.get("mattermost")?.gateway?.resolveGatewayAuthBypassPaths;

    expect(typeof artifactResolveGatewayAuthBypassPaths).toBe("function");
    expect(typeof pluginResolveGatewayAuthBypassPaths).toBe("function");
    expect(artifactResolveGatewayAuthBypassPaths).toBe(pluginResolveGatewayAuthBypassPaths);
  });

  it.each(SESSION_CONVERSATION_ARTIFACT_PLUGIN_IDS)(
    "keeps the %s session-conversation artifact identical to the loaded plugin messaging hook",
    (id) => {
      const artifactResolveSessionConversation =
        sessionKeyArtifacts.get(id)?.resolveSessionConversation;
      const pluginResolveSessionConversation =
        plugins.get(id)?.messaging?.resolveSessionConversation;

      expect(typeof artifactResolveSessionConversation).toBe("function");
      expect(typeof pluginResolveSessionConversation).toBe("function");
      expect(artifactResolveSessionConversation).toBe(pluginResolveSessionConversation);
    },
  );

  it("keeps the discord session-key artifact behavior aligned with the loaded plugin adapter", () => {
    const normalize = sessionKeyArtifacts.get("discord")?.normalizeExplicitDiscordSessionKey as
      | ExplicitSessionKeyNormalizer
      | undefined;
    const pluginNormalize = plugins.get("discord")?.messaging?.normalizeExplicitSessionKey;

    expect(typeof normalize).toBe("function");
    expect(typeof pluginNormalize).toBe("function");
    if (typeof normalize !== "function" || typeof pluginNormalize !== "function") {
      throw new Error("Missing discord session-key normalizer parity surface");
    }

    // The plugin hook adapts core's params-object shape onto the artifact's
    // positional export, so pin behavioral parity over representative keys.
    const cases = [
      { sessionKey: "discord:channel:123", ctx: { ChatType: "direct", SenderId: "123" } },
      { sessionKey: "discord:dm:42", ctx: { ChatType: "dm", From: "discord:42" } },
      { sessionKey: "agent:m:discord:channel:9", ctx: { ChatType: "direct", From: "discord:9" } },
      { sessionKey: "Discord:Channel:77", ctx: { ChatType: "group", SenderId: "77" } },
    ] as const;
    for (const { sessionKey, ctx } of cases) {
      expect(pluginNormalize({ sessionKey, ctx })).toBe(normalize(sessionKey, ctx));
    }
  });

  it.each(THREAD_BINDING_ARTIFACT_PLUGIN_IDS)(
    "keeps the %s thread-binding artifact equal to the loaded plugin default",
    (id) => {
      const artifactPlacement = threadBindingArtifacts.get(id)?.defaultTopLevelPlacement;
      const pluginPlacement = plugins.get(id)?.conversationBindings?.defaultTopLevelPlacement;

      expect(["current", "child"]).toContain(artifactPlacement);
      expect(["current", "child"]).toContain(pluginPlacement);
      expect(artifactPlacement).toBe(pluginPlacement);
    },
  );

  it.each(PROVIDER_OWNED_READ_GATE_PLUGINS)(
    "keeps the %s provider-owned read gate declaration on its registered plugin surface",
    (id, expected) => {
      expect(plugins.get(id)?.actions?.providerOwnedReadGates).toEqual(expected);
    },
  );

  describe.each(bundledChannelPluginIds)("%s", (id) => {
    it("keeps plugin identity aligned with the catalog id", () => {
      const plugin = plugins.get(id);
      if (!plugin) {
        throw new Error(`Missing bundled channel plugin for ${id}`);
      }
      expect(plugin.id).toBe(id);
      expect(plugin.meta.id).toBe(id);
    });

    it("ships non-empty docs metadata", () => {
      const plugin = plugins.get(id);
      expect(plugin?.meta.docsPath.trim()).toBeTruthy();
    });

    it("keeps runtime and lazy setup metadata on the same channel-owned contract", () => {
      const plugin = plugins.get(id);
      const packageSetup = packageMetadataById.get(id)?.setup;
      if (!plugin?.setup && !plugin?.setupContract && !packageSetup) {
        return;
      }
      expect(plugin?.setupContract, `${id} must expose setupContract`).toBeDefined();
      expect(
        plugin?.setup,
        `${id} must not duplicate the released legacy setup adapter`,
      ).toBeUndefined();
      expect(packageSetup, `${id} must expose package setup metadata`).toBeDefined();
      expect(plugin?.setupContract?.metadata).toEqual(packageSetup);
    });

    it("declares known chat types", () => {
      const chatTypes = plugins.get(id)?.capabilities.chatTypes ?? [];
      expect(chatTypes.length).toBeGreaterThan(0);
      expect(chatTypes.filter((chatType) => !CHAT_TYPES.has(chatType))).toEqual([]);
    });

    it("backs declared reactions with a message action surface", () => {
      const plugin = plugins.get(id);
      if (!plugin?.capabilities.reactions) {
        return;
      }
      // Reactions are delivered through the shared `message` tool, so a channel
      // declaring the capability without an actions adapter ships a dead flag.
      expect(plugin.actions).toBeDefined();
      expect(typeof plugin.actions?.describeMessageTool).toBe("function");
    });
  });
});
