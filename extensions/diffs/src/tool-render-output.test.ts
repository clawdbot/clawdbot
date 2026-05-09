import fs from "node:fs/promises";
import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import type { DiffScreenshotter } from "./browser.js";
import { DEFAULT_DIFFS_TOOL_DEFAULTS } from "./config.js";
import { createDiffStoreHarness } from "./test-helpers.js";

const { renderDiffDocumentMock } = vi.hoisted(() => ({
  renderDiffDocumentMock: vi.fn(),
}));

vi.mock("./render.js", () => ({
  renderDiffDocument: renderDiffDocumentMock,
}));

afterAll(() => {
  vi.doUnmock("./render.js");
  vi.resetModules();
});

describe("diffs tool rendered output guards", () => {
  let createDiffsTool: typeof import("./tool.js").createDiffsTool;
  let cleanupRootDir: () => Promise<void>;
  let store: Awaited<ReturnType<typeof createDiffStoreHarness>>["store"];

  beforeAll(async () => {
    ({ createDiffsTool } = await import("./tool.js"));
  });

  beforeEach(async () => {
    renderDiffDocumentMock.mockReset();
    ({ store, cleanup: cleanupRootDir } = await createDiffStoreHarness(
      "openclaw-diffs-tool-render-output-",
    ));
  });

  afterEach(async () => {
    await cleanupRootDir();
  });

  it("accepts empty string image html for file output", async () => {
    renderDiffDocumentMock.mockResolvedValue({
      title: "Text diff",
      fileCount: 1,
      inputKind: "before_after",
      imageHtml: "",
    });

    const screenshotter = createPngScreenshotter({
      assertHtml: (html) => {
        expect(html).toBe("");
      },
    });

    const tool = createDiffsTool({
      api: createApi(),
      store,
      defaults: DEFAULT_DIFFS_TOOL_DEFAULTS,
      screenshotter,
    });

    const result = await tool.execute?.("tool-empty-image-html", {
      before: "one\n",
      after: "two\n",
      mode: "file",
    });

    expect(screenshotter.screenshotHtml).toHaveBeenCalledTimes(1);
    expect((result?.details as Record<string, unknown>).filePath).toMatch(/preview\.png$/);
  });
});

function createApi(): OpenClawPluginApi {
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
    runtime: {} as OpenClawPluginApi["runtime"],
  });
}

function createPngScreenshotter(
  params: {
    assertHtml?: (html: string) => void;
  } = {},
): DiffScreenshotter {
  const screenshotHtml: DiffScreenshotter["screenshotHtml"] = vi.fn(
    async ({ html, outputPath }: { html: string; outputPath: string }) => {
      params.assertHtml?.(html);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, Buffer.from("png"));
      return outputPath;
    },
  );
  return {
    screenshotHtml,
  };
}
