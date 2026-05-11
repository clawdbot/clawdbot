import fs from "node:fs/promises";
import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    expect(String(readDetails(result).viewerUrl)).toContain(
      "http://127.0.0.1:18789/plugins/diffs/view/",
    );
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
    expect(String((result?.details as Record<string, unknown>).viewerUrl)).toContain(
      "https://example.com/openclaw/plugins/diffs/view/",
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
    expect(String((result?.details as Record<string, unknown>).viewerUrl)).toContain(
      "https://preview.example.com/review/plugins/diffs/view/",
    );
  });

  it("does not expose reserved format in the tool schema", () => {
    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
    });

    const properties = readParametersProperties(tool.parameters);
    expect(properties).not.toHaveProperty("format");
  });

  it("returns an image artifact in image mode", async () => {
    const cleanupSpy = vi.spyOn(store, "scheduleCleanup");
    const screenshotter = createPngScreenshotter({
      assertHtml: (html) => {
        expect(html).toContain("../../assets/viewer.js");
      },
      assertImage: (image) => {
        expect(image.format).toBe("png");
        expect(image.qualityPreset).toBe("standard");
        expect(image.scale).toBe(2);
        expect(image.maxWidth).toBe(960);
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
    const details = readDetails(result);
    expect(requireString(details.filePath, "filePath")).toMatch(/preview\.png$/);
    expect(requireString(details.imagePath, "imagePath")).toMatch(/preview\.png$/);
    expect(details.format).toBe("png");
    expect(details.fileQuality).toBe("standard");
    expect(details.imageQuality).toBe("standard");
    expect(details.fileScale).toBe(2);
    expect(details.imageScale).toBe(2);
    expect(details.fileMaxWidth).toBe(960);
    expect(details.imageMaxWidth).toBe(960);
    expect(details.viewerUrl).toBeUndefined();
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
    expect(requireString(readDetails(result).artifactId, "artifactId")).toMatch(/^[a-f0-9]{20}$/u);
    expect(requireString(readDetails(result).expiresAt, "expiresAt")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    );
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
      const filePath = requireString(readDetails(result).filePath, "filePath");
      await fs.access(filePath);

      vi.setSystemTime(new Date(now.getTime() + 2_000));
      await store.cleanupExpired();
      await expectFsEnoent(fs.stat(filePath));
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses default ttlSeconds when tool input omits ttlSeconds", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-27T16:00:00Z");
    vi.setSystemTime(now);
    try {
      const screenshotter = createPngScreenshotter();
      const tool = createToolWithScreenshotter(store, screenshotter, {
        ...DEFAULT_DIFFS_TOOL_DEFAULTS,
        ttlSeconds: 60,
      });

      const result = await tool.execute?.("tool-2c-default-ttl", {
        before: "one\n",
        after: "two\n",
        mode: "file",
      });
      const filePath = (result?.details as Record<string, unknown>).filePath as string;
      await expect(fs.stat(filePath)).resolves.toBeDefined();

      vi.setSystemTime(new Date(now.getTime() + 61_000));
      await store.cleanupExpired();
      await expectFsEnoent(fs.stat(filePath));
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts image* tool options for backward compatibility", async () => {
    const screenshotter = createPngScreenshotter({
      assertImage: (image) => {
        expect(image.qualityPreset).toBe("hq");
        expect(image.scale).toBe(2.4);
        expect(image.maxWidth).toBe(1100);
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
    const id = extractViewerArtifactId(viewerPath);
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
        expect(image.format).toBe("png");
        expect(image.qualityPreset).toBe("print");
        expect(image.scale).toBe(2.75);
        expect(image.maxWidth).toBe(1320);
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
    const id = extractViewerArtifactId(viewerPath);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readDetails(result: unknown): Record<string, unknown> {
  const details = (result as { details?: unknown } | null | undefined)?.details;
  if (!isRecord(details)) {
    throw new Error("expected diffs tool result details");
  }
  return details;
}

function extractViewerArtifactId(viewerPath: string): string {
  let previousSegment: string | undefined;
  let currentSegment: string | undefined;
  for (const segment of viewerPath.split("/")) {
    if (segment.length === 0) {
      continue;
    }
    previousSegment = currentSegment;
    currentSegment = segment;
  }
  if (!previousSegment) {
    throw new Error(`Missing artifact id in viewer path: ${viewerPath}`);
  }
  return previousSegment;
}

function readParametersProperties(parameters: unknown): Record<string, unknown> {
  if (isRecord(parameters) && isRecord(parameters.properties)) {
    return parameters.properties;
  }
  throw new Error("expected diffs tool parameter properties");
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

async function expectFsEnoent(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe("ENOENT");
    return;
  }
  throw new Error("expected ENOENT");
}

function readTextContent(result: unknown, index: number): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content;
  const entry = content?.[index];
  return entry?.type === "text" ? (entry.text ?? "") : "";
}
