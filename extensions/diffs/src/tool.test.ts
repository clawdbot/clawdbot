import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../api.js";
import type { DiffScreenshotter } from "./browser.js";
import { DEFAULT_DIFFS_TOOL_DEFAULTS } from "./config.js";
import { DiffArtifactStore } from "./store.js";
import { createDiffStoreHarness } from "./test-helpers.js";
import { createDiffsTool } from "./tool.js";
import type { DiffRenderOptions } from "./types.js";

describe("diffs tool", () => {
  let store: DiffArtifactStore;
  let cleanupRootDir: () => Promise<void>;

  beforeEach(async () => {
    ({ store, cleanup: cleanupRootDir } = await createDiffStoreHarness("openclaw-diffs-tool-"));
  });

  afterEach(async () => {
    await cleanupRootDir();
  });

  it("returns a viewer URL in view mode", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
    });

    const result = await tool.execute?.("tool-1", {
      before: "one\n",
      after: "two\n",
      path: "README.md",
      mode: "view",
    });

    const text = readTextContent(result, 0);
    expect(text).toContain("http://127.0.0.1:18789/plugins/diffs/view/");
    expect((result?.details as Record<string, unknown>).viewerUrl).toBeDefined();
  });

  it("uses configured viewerBaseUrl when tool input omits baseUrl", async () => {
    const tool = createDiffsTool({
      api: createApi({
        viewerBaseUrl: "https://example.com/openclaw/",
      }),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      viewerBaseUrl: "https://example.com/openclaw",
    });

    const result = await tool.execute?.("tool-viewer-config", {
      before: "one\n",
      after: "two\n",
      path: "README.md",
      mode: "view",
    });

    expect(readTextContent(result, 0)).toContain(
      "https://example.com/openclaw/plugins/diffs/view/",
    );
    expect((result?.details as Record<string, unknown>).viewerUrl).toEqual(
      expect.stringContaining("https://example.com/openclaw/plugins/diffs/view/"),
    );
  });

  it("prefers per-call baseUrl over configured viewerBaseUrl", async () => {
    const tool = createDiffsTool({
      api: createApi({
        viewerBaseUrl: "https://example.com/openclaw",
      }),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      viewerBaseUrl: "https://example.com/openclaw",
    });

    const result = await tool.execute?.("tool-viewer-override", {
      before: "one\n",
      after: "two\n",
      path: "README.md",
      mode: "view",
      baseUrl: "https://preview.example.com/review",
    });

    expect(readTextContent(result, 0)).toContain(
      "https://preview.example.com/review/plugins/diffs/view/",
    );
    expect((result?.details as Record<string, unknown>).viewerUrl).toEqual(
      expect.stringContaining("https://preview.example.com/review/plugins/diffs/view/"),
    );
  });

  it("does not expose reserved format in the tool schema", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
    });

    const parameters = tool.parameters as { properties?: Record<string, unknown> };
    expect(parameters.properties).toBeDefined();
    expect(parameters.properties).not.toHaveProperty("format");
  });

  it("returns an image artifact in image mode", async () => {
    const cleanupSpy = vi.spyOn(store, "scheduleCleanup");
    const screenshotter = createPngScreenshotter({
      assertHtml: (html) => {
        expect(html).toContain("../../assets/viewer.js");
      },
      assertImage: (image) => {
        expect(image).toMatchObject({
          format: "png",
          qualityPreset: "standard",
          scale: 2,
          maxWidth: 960,
        });
      },
    });

    const tool = createToolWithScreenshotter(store, screenshotter);

    const result = await tool.execute?.("tool-2", {
      before: "one\n",
      after: "two\n",
      mode: "image",
    });

    expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
    expect(readTextContent(result, 0)).toContain("Diff PNG generated at:");
    expect(readTextContent(result, 0)).toContain("Use the `message` tool");
    expect(result?.content).toHaveLength(1);
    expect((result?.details as Record<string, unknown>).filePath).toBeDefined();
    expect((result?.details as Record<string, unknown>).imagePath).toBeDefined();
    expect((result?.details as Record<string, unknown>).format).toBe("png");
    expect((result?.details as Record<string, unknown>).fileQuality).toBe("standard");
    expect((result?.details as Record<string, unknown>).imageQuality).toBe("standard");
    expect((result?.details as Record<string, unknown>).fileScale).toBe(2);
    expect((result?.details as Record<string, unknown>).imageScale).toBe(2);
    expect((result?.details as Record<string, unknown>).fileMaxWidth).toBe(960);
    expect((result?.details as Record<string, unknown>).imageMaxWidth).toBe(960);
    expect((result?.details as Record<string, unknown>).viewerUrl).toBeUndefined();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("renders PDF output when fileFormat is pdf", async () => {
    const screenshotter = createPdfScreenshotter({
      assertOutputPath: (outputPath) => {
        expect(outputPath).toMatch(/preview\.pdf$/);
      },
    });

    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      screenshotter,
    });

    const result = await tool.execute?.("tool-2b", {
      before: "one\n",
      after: "two\n",
      mode: "image",
      fileFormat: "pdf",
    });

    expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
    expect(readTextContent(result, 0)).toContain("Diff PDF generated at:");
    expect((result?.details as Record<string, unknown>).format).toBe("pdf");
    expect((result?.details as Record<string, unknown>).filePath).toMatch(/preview\.pdf$/);
  });

  it("accepts mode=file as an alias for file artifact rendering", async () => {
    const screenshotter = createPngScreenshotter({
      assertOutputPath: (outputPath) => {
        expect(outputPath).toMatch(/preview\.png$/);
      },
    });

    const tool = createToolWithScreenshotter(store, screenshotter);

    const result = await tool.execute?.("tool-2c", {
      before: "one\n",
      after: "two\n",
      mode: "file",
    });

    expectArtifactOnlyFileResult(screenshotter, result);
    expect((result?.details as Record<string, unknown>).artifactId).toEqual(expect.any(String));
    expect((result?.details as Record<string, unknown>).expiresAt).toEqual(expect.any(String));
  });

  it("honors ttlSeconds for artifact-only file output", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-27T16:00:00Z");
    vi.setSystemTime(now);
    try {
      const screenshotter = createPngScreenshotter();
      const tool = createToolWithScreenshotter(store, screenshotter);

      const result = await tool.execute?.("tool-2c-ttl", {
        before: "one\n",
        after: "two\n",
        mode: "file",
        ttlSeconds: 1,
      });
      const filePath = (result?.details as Record<string, unknown>).filePath as string;
      await expect(fs.stat(filePath)).resolves.toBeDefined();

      vi.setSystemTime(new Date(now.getTime() + 2_000));
      await store.cleanupExpired();
      await expect(fs.stat(filePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts image* tool options for backward compatibility", async () => {
    const screenshotter = createPngScreenshotter({
      assertImage: (image) => {
        expect(image).toMatchObject({
          qualityPreset: "hq",
          scale: 2.4,
          maxWidth: 1100,
        });
      },
    });

    const tool = createToolWithScreenshotter(store, screenshotter);

    const result = await tool.execute?.("tool-2legacy", {
      before: "one\n",
      after: "two\n",
      mode: "file",
      imageQuality: "hq",
      imageScale: 2.4,
      imageMaxWidth: 1100,
    });

    expect((result?.details as Record<string, unknown>).fileQuality).toBe("hq");
    expect((result?.details as Record<string, unknown>).fileScale).toBe(2.4);
    expect((result?.details as Record<string, unknown>).fileMaxWidth).toBe(1100);
  });

  it("accepts deprecated format alias for fileFormat", async () => {
    const screenshotter = createPdfScreenshotter();

    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      screenshotter,
    });

    const result = await tool.execute?.("tool-2format", {
      before: "one\n",
      after: "two\n",
      mode: "file",
      format: "pdf",
    });

    expect((result?.details as Record<string, unknown>).fileFormat).toBe("pdf");
    expect((result?.details as Record<string, unknown>).filePath).toMatch(/preview\.pdf$/);
  });

  it("honors defaults.mode=file when mode is omitted", async () => {
    const screenshotter = createPngScreenshotter();
    const tool = createToolWithScreenshotter(store, screenshotter, {
      ...DEFAULT_DIFFS_TOOL_DEFAULTS,
      mode: "file",
    });

    const result = await tool.execute?.("tool-2d", {
      before: "one\n",
      after: "two\n",
    });

    expectArtifactOnlyFileResult(screenshotter, result);
  });

  it("falls back to view output when both mode cannot render an image", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      screenshotter: {
        screenshotHtml: vi.fn(async () => {
          throw new Error("browser missing");
        }),
      },
    });

    const result = await tool.execute?.("tool-3", {
      before: "one\n",
      after: "two\n",
      mode: "both",
    });

    expect(result?.content).toHaveLength(1);
    expect(readTextContent(result, 0)).toContain("File rendering failed");
    expect((result?.details as Record<string, unknown>).fileError).toBe("browser missing");
    expect((result?.details as Record<string, unknown>).imageError).toBe("browser missing");
  });

  it("rejects invalid base URLs as tool input errors", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
    });

    await expect(
      tool.execute?.("tool-4", {
        before: "one\n",
        after: "two\n",
        mode: "view",
        baseUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow("Invalid baseUrl");
  });

  it("rejects oversized patch payloads", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
    });

    await expect(
      tool.execute?.("tool-oversize-patch", {
        patch: "x".repeat(2_100_000),
        mode: "view",
      }),
    ).rejects.toThrow("patch exceeds maximum size");
  });

  it("rejects oversized before/after payloads", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
    });

    const large = "x".repeat(600_000);
    await expect(
      tool.execute?.("tool-oversize-before", {
        before: large,
        after: "ok",
        mode: "view",
      }),
    ).rejects.toThrow("before exceeds maximum size");
  });

  it("uses configured defaults when tool params omit them", async () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: {
        ...DEFAULT_DIFFS_TOOL_DEFAULTS,
        mode: "view",
        theme: "light",
        layout: "split",
        wordWrap: false,
        background: false,
        fontFamily: "JetBrains Mono",
        fontSize: 17,
      },
      context: {
        agentId: "main",
        sessionId: "session-123",
        messageChannel: "discord",
        agentAccountId: "default",
      },
    });

    const result = await tool.execute?.("tool-5", {
      before: "one\n",
      after: "two\n",
      path: "README.md",
    });

    expect(readTextContent(result, 0)).toContain("Diff viewer ready.");
    expect((result?.details as Record<string, unknown>).mode).toBe("view");
    expect((result?.details as Record<string, unknown>).context).toEqual({
      agentId: "main",
      sessionId: "session-123",
      messageChannel: "discord",
      agentAccountId: "default",
    });

    const viewerPath = String((result?.details as Record<string, unknown>).viewerPath);
    const [id] = viewerPath.split("/").filter(Boolean).slice(-2);
    const html = await store.readHtml(id);
    expect(html).toContain('body data-theme="light"');
    expect(html).toContain("--diffs-font-size: 17px;");
    expect(html).toContain("JetBrains Mono");
  });

  it("prefers explicit tool params over configured defaults", async () => {
    const screenshotter = createPngScreenshotter({
      assertHtml: (html) => {
        expect(html).toContain("../../assets/viewer.js");
      },
      assertImage: (image) => {
        expect(image).toMatchObject({
          format: "png",
          qualityPreset: "print",
          scale: 2.75,
          maxWidth: 1320,
        });
      },
    });
    const tool = createToolWithScreenshotter(store, screenshotter, {
      ...DEFAULT_DIFFS_TOOL_DEFAULTS,
      mode: "view",
      theme: "light",
      layout: "split",
      fileQuality: "hq",
      fileScale: 2.2,
      fileMaxWidth: 1180,
    });

    const result = await tool.execute?.("tool-6", {
      before: "one\n",
      after: "two\n",
      mode: "both",
      theme: "dark",
      layout: "unified",
      fileQuality: "print",
      fileScale: 2.75,
      fileMaxWidth: 1320,
    });

    expect((result?.details as Record<string, unknown>).mode).toBe("both");
    expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
    expect((result?.details as Record<string, unknown>).format).toBe("png");
    expect((result?.details as Record<string, unknown>).fileQuality).toBe("print");
    expect((result?.details as Record<string, unknown>).fileScale).toBe(2.75);
    expect((result?.details as Record<string, unknown>).fileMaxWidth).toBe(1320);
    const viewerPath = String((result?.details as Record<string, unknown>).viewerPath);
    const [id] = viewerPath.split("/").filter(Boolean).slice(-2);
    const html = await store.readHtml(id);
    expect(html).toContain('body data-theme="dark"');
  });

  it("routes tool context into artifact details for file mode", async () => {
    const screenshotter = createPngScreenshotter();
    const tool = createToolWithScreenshotter(store, screenshotter, DEFAULT_DIFFS_TOOL_DEFAULTS, {
      agentId: "reviewer",
      sessionId: "session-456",
      messageChannel: "telegram",
      agentAccountId: "work",
    });

    const result = await tool.execute?.("tool-context-file", {
      before: "one\n",
      after: "two\n",
      mode: "file",
    });

    expect((result?.details as Record<string, unknown>).context).toEqual({
      agentId: "reviewer",
      sessionId: "session-456",
      messageChannel: "telegram",
      agentAccountId: "work",
    });
  });
});

function createApi(pluginConfig?: Record<string, unknown>): OpenClawPluginApi {
  return createTestPluginApi({
    id: "diffs",
    name: "Diffs",
    description: "Diffs",
    source: "test",
    config: {
      gateway: {
        port: 18789,
        bind: "loopback",
      },
    },
    pluginConfig,
    runtime: {} as OpenClawPluginApi["runtime"],
  });
}

function createToolWithScreenshotter(
  store: DiffArtifactStore,
  screenshotter: DiffScreenshotter,
  defaults = DEFAULT_DIFFS_TOOL_DEFAULTS,
  context: OpenClawPluginToolContext = {
    agentId: "main",
    sessionId: "session-123",
    messageChannel: "discord",
    agentAccountId: "default",
  },
) {
  return createDiffsTool({
    api: createApi(),
    store,
    defaults,
    screenshotter,
    context,
  });
}

function expectArtifactOnlyFileResult(
  screenshotter: DiffScreenshotter,
  result: { details?: unknown } | null | undefined,
) {
  expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
  expect((result?.details as Record<string, unknown>).mode).toBe("file");
  expect((result?.details as Record<string, unknown>).viewerUrl).toBeUndefined();
}

function createPngScreenshotter(
  params: {
    assertHtml?: (html: string) => void;
    assertImage?: (image: DiffRenderOptions["image"]) => void;
    assertOutputPath?: (outputPath: string) => void;
  } = {},
): DiffScreenshotter {
  const screenshotHtml: DiffScreenshotter["screenshotHtml"] = vi.fn(
    async ({
      html,
      outputPath,
      image,
    }: {
      html: string;
      outputPath: string;
      image: DiffRenderOptions["image"];
    }) => {
      params.assertHtml?.(html);
      params.assertImage?.(image);
      params.assertOutputPath?.(outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from("png"));
      return outputPath;
    },
  );
  return {
    screenshotHtml,
  };
}

function createPdfScreenshotter(
  params: {
    assertOutputPath?: (outputPath: string) => void;
  } = {},
): DiffScreenshotter {
  const screenshotHtml: DiffScreenshotter["screenshotHtml"] = vi.fn(
    async ({ outputPath, image }: { outputPath: string; image: DiffRenderOptions["image"] }) => {
      expect(image.format).toBe("pdf");
      params.assertOutputPath?.(outputPath);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from("%PDF-1.7"));
      return outputPath;
    },
  );
  return { screenshotHtml };
}

function readTextContent(result: unknown, index: number): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
  const entry = content?.[index];
  return entry?.type === "text" ? (entry.text ?? "") : "";
}
