/**
 * Fast generic tool stubs.
 *
 * Provides lightweight tool records and shared mocks for media/web/plugin tool imports.
 */
import { vi } from "vitest";

const pluginToolMetaState = vi.hoisted(() => ({
  byTool: new WeakMap<object, { pluginId: string; optional: boolean }>(),
}));

type StubTool = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown> };
  // Keep the exported type portable: don't leak Vitest's mock types into .d.ts.
  execute: (...args: unknown[]) => unknown;
};

export const stubTool = (name: string): StubTool => ({
  name,
  description: `${name} stub`,
  parameters: { type: "object", properties: {} },
  execute: vi.fn() as unknown as (...args: unknown[]) => unknown,
});

vi.mock("../tools/image-tool.js", () => ({
  createImageTool: () => stubTool("image"),
}));

vi.mock("../tools/image-generate-tool.js", () => ({
  createImageGenerateTool: () => stubTool("image_generate"),
}));

vi.mock("../tools/video-generate-tool.js", () => ({
  createVideoGenerateTool: () => stubTool("video_generate"),
}));

vi.mock("../tools/web-tools.js", () => ({
  createWebSearchTool: () => null,
  createWebFetchTool: () => null,
}));

vi.mock("../../plugins/tools.js", () => ({
  buildPluginToolMetadataKey: (pluginId: string, toolName: string) =>
    JSON.stringify([pluginId, toolName]),
  copyPluginToolMeta: (from: object, to: object) => {
    const meta = pluginToolMetaState.byTool.get(from);
    if (meta) {
      pluginToolMetaState.byTool.set(to, meta);
    }
  },
  getPluginToolMeta: (tool: object) => pluginToolMetaState.byTool.get(tool),
  resolvePluginTools: () => [],
  setPluginToolMeta: (tool: object, meta: { pluginId: string; optional: boolean }) => {
    pluginToolMetaState.byTool.set(tool, meta);
  },
}));
