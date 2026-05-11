import { describe, expect, it } from "vitest";
import { getChatChannelMeta } from "../channels/chat-meta.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { normalizeRegisteredChannelPlugin } from "./channel-validation.js";
import type { PluginDiagnostic } from "./types.js";

function collectDiagnostics() {
  const diagnostics: PluginDiagnostic[] = [];
  return {
    diagnostics,
    pushDiagnostic: (diag: PluginDiagnostic) => {
      diagnostics.push(diag);
    },
  };
}

function createChannelPlugin(overrides?: Partial<ChannelPlugin>): ChannelPlugin {
  return {
    id: "demo",
    meta: {
      id: "demo",
      label: "Demo",
      selectionLabel: "Demo",
      docsPath: "/channels/demo",
      blurb: "demo channel",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({ accountId: "default" }),
    },
    ...overrides,
  };
}

describe("normalizeRegisteredChannelPlugin", () => {
  it("fills bundled channel metadata from the canonical core baseline", () => {
    const { diagnostics, pushDiagnostic } = collectDiagnostics();

    const normalized = normalizeRegisteredChannelPlugin({
      pluginId: "demo-plugin",
      source: "/tmp/demo/index.ts",
      plugin: createChannelPlugin({
        id: "telegram",
        meta: {
          id: "telegram",
        } as never,
      }),
      pushDiagnostic,
    });

    const telegram = getChatChannelMeta("telegram");
    expect({
      label: normalized?.meta.label,
      selectionLabel: normalized?.meta.selectionLabel,
      docsPath: normalized?.meta.docsPath,
      blurb: normalized?.meta.blurb,
    }).toEqual({
      label: telegram.label,
      selectionLabel: telegram.selectionLabel,
      docsPath: telegram.docsPath,
      blurb: telegram.blurb,
    });
    expect(diagnostics).toEqual([
      {
        level: "warn",
        pluginId: "demo-plugin",
        source: "/tmp/demo/index.ts",
        message:
          'channel "telegram" registered incomplete metadata; filled missing label, selectionLabel, docsPath, blurb',
      },
    ]);
  });

  it("falls back to the channel id for external channels with incomplete metadata", () => {
    const { diagnostics, pushDiagnostic } = collectDiagnostics();

    const normalized = normalizeRegisteredChannelPlugin({
      pluginId: "demo-plugin",
      source: "/tmp/demo/index.ts",
      plugin: createChannelPlugin({
        id: "external-chat",
        meta: {
          id: "external-chat",
        } as never,
      }),
      pushDiagnostic,
    });

    expect(normalized?.id).toBe("external-chat");
    expect(normalized?.meta).toEqual({
      id: "external-chat",
      label: "external-chat",
      selectionLabel: "external-chat",
      docsPath: "/channels/external-chat",
      blurb: "",
    });
    expect(diagnostics).toEqual([
      {
        level: "warn",
        pluginId: "demo-plugin",
        source: "/tmp/demo/index.ts",
        message:
          'channel "external-chat" registered incomplete metadata; filled missing label, selectionLabel, docsPath, blurb',
      },
    ]);
  });

  it("warns and repairs mismatched meta ids", () => {
    const { diagnostics, pushDiagnostic } = collectDiagnostics();

    const normalized = normalizeRegisteredChannelPlugin({
      pluginId: "demo-plugin",
      source: "/tmp/demo/index.ts",
      plugin: createChannelPlugin({
        id: "demo",
        meta: {
          id: "other-demo",
          label: "Demo",
          selectionLabel: "Demo",
          docsPath: "/channels/demo",
          blurb: "demo channel",
        },
      }),
      pushDiagnostic,
    });

    expect(normalized?.id).toBe("demo");
    expect(normalized?.meta.id).toBe("demo");
    expect(diagnostics).toEqual([
      {
        level: "warn",
        pluginId: "demo-plugin",
        source: "/tmp/demo/index.ts",
        message: 'channel "demo" meta.id mismatch ("other-demo"); using registered channel id',
      },
    ]);
  });

  it("rejects runtime channel registrations without required config helpers", () => {
    const { diagnostics, pushDiagnostic } = collectDiagnostics();

    const normalized = normalizeRegisteredChannelPlugin({
      pluginId: "demo-plugin",
      source: "/tmp/demo/index.ts",
      plugin: createChannelPlugin({
        id: "broken-channel",
        config: undefined as never,
      }),
      pushDiagnostic,
    });

    expect(normalized).toBeNull();
    expect(diagnostics).toEqual([
      {
        level: "error",
        pluginId: "demo-plugin",
        source: "/tmp/demo/index.ts",
        message: 'channel "broken-channel" registration missing required config helpers',
      },
    ]);
  });
});
