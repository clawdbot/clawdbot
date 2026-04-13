import { vi } from "vitest";

export type StubTool = {
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
  copyPluginToolMeta: (_from: unknown, to: unknown) => to,
  getPluginToolMeta: () => undefined,
  resolvePluginTools: () => [],
}));
