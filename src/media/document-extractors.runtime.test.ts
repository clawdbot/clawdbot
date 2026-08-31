// Document extractor runtime tests cover lazy document extraction adapters.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";

const { resolvePluginDocumentExtractorsMock } = vi.hoisted(() => ({
  resolvePluginDocumentExtractorsMock: vi.fn(),
}));

vi.mock("../plugins/document-extractors.runtime.js", () => ({
  resolvePluginDocumentExtractors: resolvePluginDocumentExtractorsMock,
}));

import { extractDocumentContent } from "./document-extractors.runtime.js";

function processWorkerCount(): number {
  const workers = (process.report.getReport() as { workers?: unknown[] }).workers;
  return Array.isArray(workers) ? workers.length : 0;
}

async function createDocumentExtractorFixture(params?: { extractBody?: string }): Promise<{
  fixtureRoot: string;
  pluginId: string;
}> {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-document-worker-"));
  const pluginId = "delayed-document-extract";
  const pluginDir = path.join(fixtureRoot, pluginId);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(
    path.join(pluginDir, "document-extractor.js"),
    `
      export function createDelayedDocumentExtractor() {
        return {
          id: "delayed",
          label: "Delayed",
          mimeTypes: ["application/pdf"],
          async extract() {
            ${params?.extractBody ?? "await new Promise(() => {});"}
          },
        };
      }
    `,
  );
  return { fixtureRoot, pluginId };
}

describe("extractDocumentContent", () => {
  beforeEach(() => {
    resolvePluginDocumentExtractorsMock.mockReset();
  });

  it("passes only public extraction request fields to plugins", async () => {
    const extract = vi.fn().mockResolvedValue({ text: "pdf text", images: [] });
    resolvePluginDocumentExtractorsMock.mockReturnValue([
      {
        id: "pdf",
        pluginId: "document-extract",
        label: "PDF",
        mimeTypes: ["application/pdf"],
        extract,
      },
    ]);

    await expect(
      extractDocumentContent({
        buffer: Buffer.from("pdf"),
        mimeType: "application/pdf",
        maxPages: 1,
        maxPixels: 100,
        minTextChars: 10,
        config: {
          env: {
            vars: {
              SECRET_VALUE: "do-not-pass",
            },
          },
        },
      }),
    ).resolves.toStrictEqual({ text: "pdf text", images: [], extractor: "pdf" });

    expect(extract).toHaveBeenCalledWith({
      buffer: Buffer.from("pdf"),
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 100,
      minTextChars: 10,
    });
  });

  it("surfaces matching extractor failures instead of reporting disablement", async () => {
    const cause = new Error("password required");
    resolvePluginDocumentExtractorsMock.mockReturnValue([
      {
        id: "pdf",
        pluginId: "document-extract",
        label: "PDF",
        mimeTypes: ["application/pdf"],
        extract: vi.fn().mockRejectedValue(cause),
      },
    ]);

    let extractionError: unknown;
    try {
      await extractDocumentContent({
        buffer: Buffer.from("pdf"),
        mimeType: "application/pdf",
        maxPages: 1,
        maxPixels: 100,
        minTextChars: 10,
        config: {},
      });
    } catch (error) {
      extractionError = error;
    }
    expect(extractionError).toBeInstanceOf(Error);
    if (!(extractionError instanceof Error)) {
      throw new Error("expected extraction error");
    }
    expect(extractionError.message).toBe("Document extraction failed for application/pdf");
    expect(extractionError.cause).toBe(cause);
  });

  it("replaces cached document extractor callbacks when plugin metadata changes", async () => {
    const oldExtract = vi.fn().mockResolvedValue({ text: "retired", images: [] });
    const newExtract = vi.fn().mockResolvedValue({ text: "replacement", images: [] });
    const config = {};
    const createExtractor = (extract: typeof oldExtract) => ({
      id: "pdf",
      pluginId: "document-extract",
      label: "PDF",
      mimeTypes: ["application/pdf"],
      extract,
    });
    resolvePluginDocumentExtractorsMock
      .mockReturnValueOnce([createExtractor(oldExtract)])
      .mockReturnValueOnce([createExtractor(newExtract)]);
    const request = {
      buffer: Buffer.from("pdf"),
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 100,
      minTextChars: 10,
      config,
    };

    await expect(extractDocumentContent(request)).resolves.toMatchObject({ text: "retired" });

    clearPluginMetadataLifecycleCaches();

    await expect(extractDocumentContent(request)).resolves.toMatchObject({ text: "replacement" });
    expect(resolvePluginDocumentExtractorsMock).toHaveBeenCalledTimes(2);
    expect(oldExtract).toHaveBeenCalledOnce();
    expect(newExtract).toHaveBeenCalledOnce();
  });

  it("completes extraction through the source TypeScript worker", async () => {
    const { fixtureRoot, pluginId } = await createDocumentExtractorFixture({
      extractBody: 'return { text: "source worker loaded", images: [] };',
    });
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", fixtureRoot);
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");

    try {
      await expect(
        extractDocumentContent({
          buffer: Buffer.from("pdf"),
          mimeType: "application/pdf",
          maxPages: 1,
          maxPixels: 100,
          minTextChars: 10,
          signal: new AbortController().signal,
          config: { plugins: { allow: [pluginId] } },
        }),
      ).resolves.toStrictEqual({
        text: "source worker loaded",
        images: [],
        extractor: "delayed",
      });
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("terminates isolated extraction before rejecting caller cancellation", async () => {
    const { fixtureRoot, pluginId } = await createDocumentExtractorFixture();
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", fixtureRoot);
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    const controller = new AbortController();
    const baselineWorkers = processWorkerCount();
    const pending = extractDocumentContent({
      buffer: Buffer.from("pdf"),
      mimeType: "application/pdf",
      maxPages: 1,
      maxPixels: 100,
      minTextChars: 10,
      signal: controller.signal,
      config: { plugins: { allow: [pluginId] } },
    });

    try {
      const workerState = await Promise.race([
        vi
          .waitFor(() => expect(processWorkerCount()).toBeGreaterThan(baselineWorkers))
          .then(() => ({ status: "running" }) as const),
        pending.then(
          () => ({ status: "resolved" }) as const,
          (error: unknown) => ({ status: "rejected", error }) as const,
        ),
      ]);
      if (workerState.status !== "running") {
        throw new Error(
          workerState.status === "resolved"
            ? "Document extraction resolved before its worker became observable"
            : "Document extraction failed before its worker became observable",
          workerState.status === "rejected" ? { cause: workerState.error } : undefined,
        );
      }

      controller.abort(new Error("client disconnected"));

      await expect(pending).rejects.toThrow("client disconnected");
      await vi.waitFor(() => expect(processWorkerCount()).toBe(baselineWorkers));
    } finally {
      if (!controller.signal.aborted) {
        controller.abort(new Error("document worker test cleanup"));
      }
      await Promise.allSettled([pending]);
      vi.unstubAllEnvs();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("bounds extraction and rejects overflow without starting another worker", async () => {
    const { fixtureRoot, pluginId } = await createDocumentExtractorFixture();
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", fixtureRoot);
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    const baselineWorkers = processWorkerCount();
    const controllers = Array.from({ length: 7 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      extractDocumentContent({
        buffer: Buffer.from("pdf"),
        mimeType: "application/pdf",
        maxPages: 1,
        maxPixels: 100,
        minTextChars: 10,
        signal: controller.signal,
        config: { plugins: { allow: [pluginId] } },
      }),
    );
    const overflow = pending[6];
    if (!overflow) {
      throw new Error("expected document extraction overflow request");
    }
    const overflowAssertion = expect(overflow).rejects.toMatchObject({
      code: "document_extractor_capacity",
    });

    try {
      await vi.waitFor(() => expect(processWorkerCount()).toBe(baselineWorkers + 2));
      await overflowAssertion;

      const admittedAssertions = pending
        .slice(0, 6)
        .map((request, index) => expect(request).rejects.toThrow(`cancel extraction ${index}`));
      for (const [index, controller] of controllers.slice(0, 6).entries()) {
        controller.abort(new Error(`cancel extraction ${index}`));
      }
      await Promise.all(admittedAssertions);
      await vi.waitFor(() => expect(processWorkerCount()).toBe(baselineWorkers));
    } finally {
      for (const controller of controllers) {
        if (!controller.signal.aborted) {
          controller.abort(new Error("document admission test cleanup"));
        }
      }
      await Promise.allSettled(pending);
      vi.unstubAllEnvs();
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
