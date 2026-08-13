import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { resolveReadOnlyChannelPluginsForConfig } from "./read-only.js";

const mocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshot: vi.fn((_params: { workspaceDir?: string }) => {
    const plugins: PluginManifestRecord[] = [];
    return { plugins, manifestRegistry: { plugins, diagnostics: [] } };
  }),
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

afterEach(() => {
  mocks.resolvePluginMetadataSnapshot.mockClear();
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
});

describe("read-only channel plugin legacy workspace discovery", () => {
  it("scans the retained compatibility owner's explicit workspace", () => {
    const cfg = retainLegacyDefaultAgentId(
      {
        agents: {
          ownership: "explicit",
          entries: {
            research: {},
            ops: { workspace: "/srv/ops" },
          },
        },
      },
      "ops",
    );

    resolveReadOnlyChannelPluginsForConfig(cfg, {
      env: { ...process.env },
      includePersistedAuthState: false,
    });

    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        workspaceDir: path.resolve("/srv/ops"),
      }),
    );
  });

  it("discovers plugins from every explicit agent workspace", () => {
    const researchPlugin = {
      id: "research-chat-plugin",
      name: "Research Chat",
      description: "Research workspace channel",
      version: "1.0.0",
      source: "/srv/research/.openclaw/extensions/research-chat-plugin",
      origin: "workspace",
      channels: ["research-chat"],
    } as PluginManifestRecord;
    mocks.resolvePluginMetadataSnapshot.mockImplementation(({ workspaceDir }) => {
      const plugins = workspaceDir === path.resolve("/srv/research") ? [researchPlugin] : [];
      return { plugins, manifestRegistry: { plugins, diagnostics: [] } };
    });
    const cfg = {
      agents: {
        ownership: "explicit" as const,
        entries: {
          ops: { workspace: "/srv/ops" },
          research: { workspace: "/srv/research" },
        },
      },
      channels: { "research-chat": { enabled: true } },
      plugins: {
        allow: ["research-chat-plugin"],
        entries: { "research-chat-plugin": { enabled: true } },
      },
    };

    const resolution = resolveReadOnlyChannelPluginsForConfig(cfg, {
      env: { ...process.env },
      includePersistedAuthState: false,
    });

    expect(resolution.plugins.map((plugin) => plugin.id)).toContain("research-chat");
    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: path.resolve("/srv/ops") }),
    );
    expect(mocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: path.resolve("/srv/research") }),
    );
  });
});
