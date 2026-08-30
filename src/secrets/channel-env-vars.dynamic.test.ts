/** Tests dynamic channel env-var discovery from plugin/channel metadata. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot:
    vi.fn<typeof import("../plugins/plugin-metadata-snapshot.js").loadPluginMetadataSnapshot>(),
  resolvePluginMetadataSnapshot:
    vi.fn<typeof import("../plugins/plugin-metadata-snapshot.js").resolvePluginMetadataSnapshot>(),
  resolveConfigWidePluginManifestRegistry:
    vi.fn<
      typeof import("../config/io.plugin-metadata.js").resolveConfigWidePluginManifestRegistry
    >(),
}));

vi.mock("../config/io.plugin-metadata.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.plugin-metadata.js")>()),
  resolveConfigWidePluginManifestRegistry:
    pluginRegistryMocks.resolveConfigWidePluginManifestRegistry,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: pluginRegistryMocks.resolvePluginMetadataSnapshot,
}));

describe("channel env vars dynamic package metadata", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of cleanup.splice(0).toReversed()) {
      dispose();
    }
  });

  beforeEach(() => {
    vi.resetModules();
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockReset();
    pluginRegistryMocks.resolvePluginMetadataSnapshot.mockReset();
    pluginRegistryMocks.resolveConfigWidePluginManifestRegistry.mockReset();
  });

  it("resolves channel setup env names from a sole-agent metadata owner without a workspace argument", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-env-owner-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspaceDir = path.join(root, "workspace");
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
    };
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { solo: { workspace: workspaceDir } } },
      plugins: { allow: ["workspace-chat"] },
    };
    const manifestRegistry = makeRegistry([
      { id: "workspace-chat", origin: "workspace", channels: ["workspace-chat"] },
    ]);
    manifestRegistry.plugins[0]!.packageChannel = {
      id: "workspace-chat",
      configuredState: { env: { anyOf: ["WORKSPACE_CHAT_TOKEN"] } },
    };
    const snapshot = createPluginMetadataSnapshot({ config, workspaceDir, manifestRegistry });
    snapshot.discovery = { candidates: [], diagnostics: [] };
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockReturnValue(snapshot);
    const actualSnapshot = await vi.importActual<
      typeof import("../plugins/plugin-metadata-snapshot.js")
    >("../plugins/plugin-metadata-snapshot.js");
    pluginRegistryMocks.resolvePluginMetadataSnapshot.mockImplementation(
      actualSnapshot.resolvePluginMetadataSnapshot,
    );
    const actualConfigMetadata = await vi.importActual<
      typeof import("../config/io.plugin-metadata.js")
    >("../config/io.plugin-metadata.js");
    pluginRegistryMocks.resolveConfigWidePluginManifestRegistry.mockImplementation(
      actualConfigMetadata.resolveConfigWidePluginManifestRegistry,
    );
    const { getPluginMetadataSnapshotCache } = await import("../plugins/plugin-cache.js");
    const { createPluginMetadataOwner } = await import("../plugins/plugin-metadata-collection.js");
    const { installPluginMetadataOwner } =
      await import("../plugins/current-plugin-metadata.test-support.js");
    const owner = createPluginMetadataOwner();
    const prepared = owner.prepare({ config, env });
    cleanup.push(installPluginMetadataOwner(owner, getPluginMetadataSnapshotCache(prepared)));
    owner.publish(prepared, { config, env });
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockClear();
    const mod = await import("./channel-env-vars.js");
    expect(mod.getChannelEnvVars("workspace-chat", { config, env })).toEqual([
      "WORKSPACE_CHAT_TOKEN",
    ]);
    expect(mod.listKnownChannelEnvVarNames({ config, env })).toEqual(["WORKSPACE_CHAT_TOKEN"]);
    expect(mod.listKnownChannelEnvVarNames({ env })).toEqual(["WORKSPACE_CHAT_TOKEN"]);
    expect(mod.getChannelEnvVars("workspace-chat", { config, env, workspaceDir })).toEqual([
      "WORKSPACE_CHAT_TOKEN",
    ]);
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("includes later-installed plugin env vars without a bundled generated map", async () => {
    const manifestRegistry = makeRegistry([
      { id: "external-mattermost", channels: ["mattermost"], origin: "global" },
    ]);
    manifestRegistry.plugins[0]!.packageChannel = {
      id: "mattermost",
      configuredState: { env: { anyOf: ["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"] } },
    };
    pluginRegistryMocks.resolveConfigWidePluginManifestRegistry.mockReturnValue(manifestRegistry);

    const mod = await import("./channel-env-vars.js");

    expect(mod.getChannelEnvVars("mattermost")).toEqual(["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"]);
    const knownNames = mod.listKnownChannelEnvVarNames();
    expect(knownNames).toContain("MATTERMOST_BOT_TOKEN");
    expect(knownNames).toContain("MATTERMOST_URL");
  });

  it("keeps an explicit workspace on its exact metadata view", async () => {
    const workspaceDir = "/workspace/exact";
    const manifestRegistry = makeRegistry([
      { id: "workspace-chat", channels: ["chat"], origin: "workspace" },
    ]);
    manifestRegistry.plugins[0]!.packageChannel = {
      id: "chat",
      configuredState: { env: { anyOf: ["EXACT_WORKSPACE_TOKEN"] } },
    };
    pluginRegistryMocks.resolvePluginMetadataSnapshot.mockReturnValue(
      createPluginMetadataSnapshot({ workspaceDir, manifestRegistry }),
    );
    pluginRegistryMocks.resolveConfigWidePluginManifestRegistry.mockReturnValue(makeRegistry([]));
    const mod = await import("./channel-env-vars.js");
    expect(mod.getChannelEnvVars("chat", { workspaceDir })).toEqual(["EXACT_WORKSPACE_TOKEN"]);
    expect(mod.listKnownChannelEnvVarNames({ workspaceDir })).toEqual(["EXACT_WORKSPACE_TOKEN"]);
  });
});
