// Compose LINE's public plugin contract with the canonical runtime prompt.
import { expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { loadBundledPluginPublicSurface } from "../plugin-sdk/test-helpers/public-surface-loader.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveChannelMessageToolHints } from "./channel-tools.js";
import { collectRuntimeChannelCapabilities } from "./runtime-capabilities.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

it("offers LINE buttons without prescribing an unsupported config setting", async () => {
  const { linePlugin } = await loadBundledPluginPublicSurface<{ linePlugin: ChannelPlugin }>({
    pluginId: "line",
    artifactBasename: "api.js",
  });
  const snapshot = captureActivePluginRegistrySnapshot();
  try {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "line", source: "test", plugin: linePlugin }]),
    );
    const channel = { cfg: {}, channel: "line" };
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw-line-prompt",
      toolNames: ["message"],
      runtimeInfo: {
        channel: "line",
        capabilities: collectRuntimeChannelCapabilities(channel),
      },
      messageToolHints: resolveChannelMessageToolHints(channel),
    });

    expect(prompt).toContain("Inline buttons: `send` with `presentation=");
    expect(prompt).toContain("LINE maps them to Flex controls or quick replies");
    expect(prompt).not.toContain("Inline buttons OFF for line");
    expect(prompt).not.toContain("line.capabilities.inlineButtons");
  } finally {
    restoreActivePluginRegistrySnapshot(snapshot);
  }
});
