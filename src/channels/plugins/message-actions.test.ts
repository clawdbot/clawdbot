// Message action tests cover channel message action schema and invocation behavior.
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { defaultRuntime } from "../../runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  channelSupportsMessageCapability,
  channelSupportsMessageCapabilityForChannel,
  listCrossChannelSchemaSupportedMessageActions,
  resolveChannelMessageToolMediaSourceParamKeys,
  resolveChannelMessageToolSchemaProperties,
} from "./message-action-discovery.js";
import type { ChannelMessageCapability } from "./message-capabilities.js";
import type { ChannelPlugin } from "./types.public.js";

const emptyRegistry = createTestRegistry([]);

function createMessageActionsPlugin(params: {
  id: "demo-buttons" | "demo-cards";
  capabilities: readonly ChannelMessageCapability[];
  aliases?: string[];
}): ChannelPlugin {
  const base = createChannelTestPluginBase({
    id: params.id,
    label: params.id === "demo-buttons" ? "Demo Buttons" : "Demo Cards",
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => ["default"],
    },
  });
  return {
    ...base,
    meta: {
      ...base.meta,
      ...(params.aliases ? { aliases: params.aliases } : {}),
    },
    actions: {
      describeMessageTool: () => ({
        actions: ["send"],
        capabilities: params.capabilities,
      }),
    },
  };
}

const buttonsPlugin = createMessageActionsPlugin({
  id: "demo-buttons",
  capabilities: ["presentation"],
});

const cardsPlugin = createMessageActionsPlugin({
  id: "demo-cards",
  capabilities: ["delivery-pin"],
});

function activateMessageActionTestRegistry() {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "demo-buttons", source: "test", plugin: buttonsPlugin },
      { pluginId: "demo-cards", source: "test", plugin: cardsPlugin },
    ]),
  );
}

describe("message action capability checks", () => {
  const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
    errorSpy.mockClear();
  });

  it("aggregates capabilities across plugins", () => {
    activateMessageActionTestRegistry();

    expect(channelSupportsMessageCapability({} as OpenClawConfig, "presentation")).toBe(true);
    expect(channelSupportsMessageCapability({} as OpenClawConfig, "delivery-pin")).toBe(true);
  });

  it("checks per-channel capabilities", () => {
    activateMessageActionTestRegistry();

    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "demo-buttons" },
        "presentation",
      ),
    ).toBe(true);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "demo-cards" },
        "presentation",
      ),
    ).toBe(false);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "demo-buttons" },
        "delivery-pin",
      ),
    ).toBe(false);
    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "demo-cards" },
        "delivery-pin",
      ),
    ).toBe(true);
    expect(
      channelSupportsMessageCapabilityForChannel({ cfg: {} as OpenClawConfig }, "delivery-pin"),
    ).toBe(false);
  });

  it("normalizes channel aliases for per-channel capability checks", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "demo-cards",
          source: "test",
          plugin: createMessageActionsPlugin({
            id: "demo-cards",
            aliases: ["demo-cards-alias"],
            capabilities: ["delivery-pin"],
          }),
        },
      ]),
    );

    expect(
      channelSupportsMessageCapabilityForChannel(
        { cfg: {} as OpenClawConfig, channel: "demo-cards-alias" },
        "delivery-pin",
      ),
    ).toBe(true);
  });

  it("uses unified message tool discovery for actions, capabilities, and schema", () => {
    const unifiedPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-unified",
        label: "Demo Unified",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["react"],
          capabilities: ["presentation"],
          schema: {
            properties: {
              components: Type.Array(Type.String()),
            },
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "demo-unified", source: "test", plugin: unifiedPlugin }]),
    );

    expect(channelSupportsMessageCapability({} as OpenClawConfig, "presentation")).toBe(true);
    expect(
      resolveChannelMessageToolSchemaProperties({
        cfg: {} as OpenClawConfig,
        channel: "demo-unified",
      }),
    ).toHaveProperty("components");
  });

  it("keeps contributed schema properties optional so only action stays required", () => {
    const contributingPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-contrib",
        label: "Demo Contrib",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["send"],
          schema: {
            properties: {
              // Non-optional TypeBox schema: plugin forgot Type.Optional.
              components: Type.Array(Type.String()),
              // Cloning strips typebox's non-enumerable `~optional` marker;
              // mirrors serialized/external plugin contributions.
              chatRef: structuredClone(Type.Optional(Type.String())),
              media: Type.Optional(Type.String()),
            },
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "demo-contrib", source: "test", plugin: contributingPlugin },
      ]),
    );

    const properties = resolveChannelMessageToolSchemaProperties({
      cfg: {} as OpenClawConfig,
      channel: "demo-contrib",
    });
    // Regression: required leakage made every message tool call fail validation
    // with "must have required properties chatRef, media, ...".
    const toolSchema = Type.Object({ action: Type.String(), ...properties });
    expect(toolSchema.required).toEqual(["action"]);
  });

  it("filters only actions that depend on current-channel-only schema", () => {
    const scopedSchemaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-scoped-schema",
        label: "Demo Scoped Schema",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["read", "list-pins", "unpin"],
          schema: {
            actions: ["unpin"],
            properties: {
              pinnedMessageId: Type.Optional(Type.String()),
            },
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "demo-scoped-schema", source: "test", plugin: scopedSchemaPlugin },
      ]),
    );

    expect(
      listCrossChannelSchemaSupportedMessageActions({
        cfg: {} as OpenClawConfig,
        channel: "demo-scoped-schema",
      }),
    ).toEqual(["read", "list-pins"]);
  });

  it("keeps unscoped current-channel schema conservative for cross-channel actions", () => {
    const unscopedSchemaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-unscoped-schema",
        label: "Demo Unscoped Schema",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["read", "unpin"],
          schema: {
            properties: {
              pinnedMessageId: Type.Optional(Type.String()),
            },
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "demo-unscoped-schema", source: "test", plugin: unscopedSchemaPlugin },
      ]),
    );

    expect(
      listCrossChannelSchemaSupportedMessageActions({
        cfg: {} as OpenClawConfig,
        channel: "demo-unscoped-schema",
      }),
    ).toStrictEqual([]);
  });

  it("treats empty current-channel schema action lists as blocking no cross-channel actions", () => {
    const emptyScopedSchemaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-empty-scoped-schema",
        label: "Demo Empty Scoped Schema",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["read", "list-pins"],
          schema: {
            actions: [],
            properties: {
              optionalChannelOnlyValue: Type.Optional(Type.String()),
            },
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "demo-empty-scoped-schema",
          source: "test",
          plugin: emptyScopedSchemaPlugin,
        },
      ]),
    );

    expect(
      listCrossChannelSchemaSupportedMessageActions({
        cfg: {} as OpenClawConfig,
        channel: "demo-empty-scoped-schema",
      }),
    ).toEqual(["read", "list-pins"]);
  });

  it("derives plugin-owned media-source params for the current action", () => {
    const mediaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-media",
        label: "Demo Media",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["send", "set-profile"],
          mediaSourceParams: {
            "set-profile": ["avatarUrl", "avatarPath"],
          },
          schema: {
            properties: {
              avatarUrl: Type.Optional(Type.String({ description: "Remote avatar URL" })),
              avatarPath: Type.Optional(Type.String({ description: "Local avatar path" })),
              displayName: Type.Optional(Type.String()),
            },
          },
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "demo-media", source: "test", plugin: mediaPlugin }]),
    );

    expect(
      resolveChannelMessageToolMediaSourceParamKeys({
        cfg: {} as OpenClawConfig,
        action: "set-profile",
        channel: "demo-media",
      }),
    ).toEqual(["avatarUrl", "avatarPath"]);
    expect(
      resolveChannelMessageToolMediaSourceParamKeys({
        cfg: {} as OpenClawConfig,
        action: "send",
        channel: "demo-media",
      }),
    ).toStrictEqual([]);
  });

  it("keeps flat media-source param discovery for backward compatibility", () => {
    const mediaPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-media-flat",
        label: "Demo Media Flat",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => ({
          actions: ["set-profile"],
          mediaSourceParams: ["avatarUrl", "avatarPath"],
        }),
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "demo-media-flat", source: "test", plugin: mediaPlugin }]),
    );

    expect(
      resolveChannelMessageToolMediaSourceParamKeys({
        cfg: {} as OpenClawConfig,
        action: "set-profile",
        channel: "demo-media-flat",
      }),
    ).toEqual(["avatarUrl", "avatarPath"]);
  });

  it("skips crashing action/capability discovery paths and logs once", () => {
    const crashingPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "demo-crashing",
        label: "Demo Crashing",
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      actions: {
        describeMessageTool: () => {
          throw new Error("boom");
        },
      },
    };
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "demo-crashing", source: "test", plugin: crashingPlugin }]),
    );

    expect(channelSupportsMessageCapability({} as OpenClawConfig, "presentation")).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    expect(channelSupportsMessageCapability({} as OpenClawConfig, "presentation")).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
