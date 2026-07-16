import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, OpenClawPluginApi, OpenClawPluginToolContext } from "../api.js";
import { registerDiffsPlugin } from "./plugin.js";

const { createDiffsToolMock } = vi.hoisted(() => ({
  createDiffsToolMock: vi.fn(() => ({ name: "diffs" })),
}));

vi.mock("./tool.js", () => ({
  createDiffsTool: createDiffsToolMock,
}));

afterAll(() => {
  vi.doUnmock("./tool.js");
  vi.resetModules();
});

describe("diffs plugin language-pack discovery", () => {
  it.each(["assets", "dist/assets"])(
    "requires both the sibling manifest and generated runtime asset in %s",
    (assetDir) => {
      type RegisteredTool = { name?: string };
      const root = fs.mkdtempSync(join(os.tmpdir(), "openclaw-diffs-language-pack-"));
      try {
        const diffsRoot = join(root, "diffs");
        const languagePackRoot = join(root, "diffs-language-pack");
        fs.mkdirSync(diffsRoot, { recursive: true });
        fs.mkdirSync(languagePackRoot, { recursive: true });
        fs.writeFileSync(
          join(languagePackRoot, "openclaw.plugin.json"),
          '{"id":"diffs-language-pack"}\n',
        );
        const config = { plugins: {} } as OpenClawConfig;
        let registeredToolFactory:
          | ((
              ctx: OpenClawPluginToolContext,
            ) => RegisteredTool | RegisteredTool[] | null | undefined)
          | undefined;
        const api = createTestPluginApi({
          rootDir: diffsRoot,
          config,
          runtime: { config: { current: () => config } } as never,
          registerTool(tool: Parameters<OpenClawPluginApi["registerTool"]>[0]) {
            registeredToolFactory = typeof tool === "function" ? tool : () => tool;
          },
        });

        registerDiffsPlugin(api);
        const context = {
          agentId: "main",
          sessionId: "session-1",
          messageChannel: "test",
          agentAccountId: "default",
        } satisfies OpenClawPluginToolContext;

        registeredToolFactory?.(context);
        expect(createDiffsToolMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ languagePackAvailable: false }),
        );

        fs.mkdirSync(join(languagePackRoot, assetDir), { recursive: true });
        fs.writeFileSync(join(languagePackRoot, assetDir, "viewer-runtime.js"), "export {};\n");

        registeredToolFactory?.(context);
        expect(createDiffsToolMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ languagePackAvailable: true }),
        );
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
        createDiffsToolMock.mockClear();
      }
    },
  );
});
