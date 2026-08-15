// Document Extract tests cover document extractor plugin behavior.
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { createEngineMock, openPdfMock, pdfDocument } = vi.hoisted(() => ({
  createEngineMock: vi.fn(),
  openPdfMock: vi.fn(),
  pdfDocument: {
    pageCount: 2,
    extract: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("clawpdf", () => ({
  createEngine: createEngineMock,
}));

import { createPdfDocumentExtractor, testOnlyDocumentExtractor } from "./document-extractor.js";

function request(overrides = {}) {
  return {
    buffer: Buffer.from("%PDF-1.4"),
    mimeType: "application/pdf",
    maxPages: 2,
    maxPixels: 100,
    minTextChars: 10,
    ...overrides,
  };
}

function createWorkerDouble(...messages: unknown[]) {
  const worker = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(() => {
      const message = messages.shift();
      queueMicrotask(() => worker.emit("message", message));
    }),
    terminate: vi.fn(async () => 0),
    ref: vi.fn(),
    unref: vi.fn(),
  });
  return worker;
}

function createControlledWorkerDouble() {
  return Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    terminate: vi.fn(async () => 0),
    ref: vi.fn(),
    unref: vi.fn(),
  });
}

describe("PDF document extractor", () => {
  afterAll(() => {
    vi.doUnmock("clawpdf");
    vi.resetModules();
  });

  beforeEach(() => {
    createEngineMock.mockResolvedValue({ open: openPdfMock });
    openPdfMock.mockReset();
    openPdfMock.mockResolvedValue(pdfDocument);
    pdfDocument.pageCount = 2;
    pdfDocument.extract.mockReset();
    pdfDocument.destroy.mockReset();
  });

  it("declares PDF support", () => {
    const extractor = createPdfDocumentExtractor();
    const { extract, ...descriptor } = extractor;
    expect(extract).toBeInstanceOf(Function);
    expect(descriptor).toEqual({
      id: "pdf",
      label: "PDF",
      mimeTypes: ["application/pdf"],
      autoDetectOrder: 10,
    });
  });

  it("extracts text first and renders each fallback page with its own pixel budget", async () => {
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "", images: [] })
      .mockResolvedValueOnce({
        text: "",
        images: [
          {
            type: "image",
            bytes: Uint8Array.from(Buffer.from("png1")),
            mimeType: "image/png",
            page: 1,
            width: 5,
            height: 10,
          },
        ],
      })
      .mockResolvedValueOnce({
        text: "",
        images: [
          {
            type: "image",
            bytes: Uint8Array.from(Buffer.from("png2")),
            mimeType: "image/png",
            page: 2,
            width: 5,
            height: 10,
          },
        ],
      });
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request());

    if (!result) {
      throw new Error("Expected PDF extraction result");
    }
    expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(1, {
      mode: "text",
      maxPages: 2,
      maxTextChars: 200_000,
    });
    // Each page renders in its own extract() call, with the aggregate pixel cap
    // allocated across selected pages so later pages are not starved.
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(2, {
      mode: "images",
      pages: [1],
      image: { maxDimension: 10_000, maxPixels: 50, forms: true },
    });
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(3, {
      mode: "images",
      pages: [2],
      image: { maxDimension: 10_000, maxPixels: 50, forms: true },
    });
    expect(result).toEqual({
      text: "",
      images: [
        { type: "image", data: "cG5nMQ==", mimeType: "image/png" },
        { type: "image", data: "cG5nMg==", mimeType: "image/png" },
      ],
    });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("skips image fallback when enough text is extracted", async () => {
    pdfDocument.extract.mockResolvedValueOnce({ text: "enough text", images: [] });
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ minTextChars: 5 }));

    expect(result).toEqual({ text: "enough text", images: [] });
    expect(pdfDocument.extract).toHaveBeenCalledTimes(1);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("opens encrypted PDFs with the request password", async () => {
    pdfDocument.extract.mockResolvedValueOnce({ text: "enough text", images: [] });
    const extractor = createPdfDocumentExtractor();

    await extractor.extract(request({ password: "secret" }));

    expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array), { password: "secret" });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("normalizes clawpdf password errors", async () => {
    openPdfMock.mockRejectedValueOnce(
      Object.assign(new Error("bad password"), { code: "password" }),
    );
    const extractor = createPdfDocumentExtractor();

    await expect(extractor.extract(request({ password: "wrong" }))).rejects.toThrow(
      "PDF requires a password or password is incorrect.",
    );
    expect(pdfDocument.destroy).not.toHaveBeenCalled();
  });

  it("filters selected pages and renders them one page per image call", async () => {
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "", images: [] })
      .mockResolvedValueOnce({ text: "", images: [] })
      .mockResolvedValueOnce({ text: "", images: [] });
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ pageNumbers: [3, 2, 0, 1], maxPages: 2 }));

    expect(result).toEqual({ text: "", images: [] });
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mode: "text", pages: [2, 1] }),
    );
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: "images", pages: [2] }),
    );
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ mode: "images", pages: [1] }),
    );
  });

  it("rejects selected pages outside the PDF page count before extraction", async () => {
    pdfDocument.pageCount = 1;
    pdfDocument.extract.mockResolvedValueOnce({ text: "", images: [] });
    const extractor = createPdfDocumentExtractor();

    await expect(extractor.extract(request({ pageNumbers: [2] }))).rejects.toThrow(
      "No requested PDF pages exist in this 1-page document.",
    );
    expect(pdfDocument.extract).not.toHaveBeenCalled();
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);

    await expect(extractor.extract(request({ pageNumbers: [] }))).resolves.toEqual({
      text: "",
      images: [],
    });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(2);
  });

  it("reports image fallback failures and returns extracted text", async () => {
    const onImageExtractionError = vi.fn();
    const failure = new Error("render failed");
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "short", images: [] })
      .mockRejectedValueOnce(failure);
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ onImageExtractionError }));

    expect(result).toEqual({ text: "short", images: [] });
    expect(onImageExtractionError).toHaveBeenCalledWith(failure);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("runs signal-aware PDF extraction in an isolated worker", async () => {
    const buffer = Buffer.from(
      [
        "%PDF-1.4",
        "1 0 obj",
        "<< /Type /Catalog /Pages 2 0 R >>",
        "endobj",
        "2 0 obj",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "endobj",
        "3 0 obj",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
        "endobj",
        "trailer",
        "<< /Root 1 0 R >>",
        "%%EOF",
        "",
      ].join("\n"),
    );
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(
      request({
        buffer,
        maxPages: 1,
        maxPixels: 100,
        minTextChars: 1,
        signal: new AbortController().signal,
      }),
    );

    expect(result?.text).toBe("");
    expect(result?.images).toHaveLength(1);
    expect(result?.images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(pdfDocument.extract).not.toHaveBeenCalled();
  });

  it("reuses a warm worker for sequential signal-aware PDF extractions", async () => {
    const worker = createWorkerDouble(
      { status: "ok", result: { text: "first", images: [] }, imageExtractionErrors: [] },
      { status: "ok", result: { text: "second", images: [] }, imageExtractionErrors: [] },
    );
    const createWorker = vi.fn(() => worker);
    const extractor = createPdfDocumentExtractor({
      createWorker,
      workerPool: testOnlyDocumentExtractor.createPdfWorkerPool(2),
    });

    await expect(
      extractor.extract(request({ signal: new AbortController().signal })),
    ).resolves.toEqual({ text: "first", images: [] });
    await expect(
      extractor.extract(request({ signal: new AbortController().signal })),
    ).resolves.toEqual({ text: "second", images: [] });

    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(worker.ref).toHaveBeenCalledTimes(2);
    expect(worker.unref).toHaveBeenCalledTimes(2);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("keeps leased PDF workers referenced and unreferences them only while idle", async () => {
    const worker = createControlledWorkerDouble();
    const extractor = createPdfDocumentExtractor({
      createWorker: () => worker,
      workerPool: testOnlyDocumentExtractor.createPdfWorkerPool(1),
    });

    const first = extractor.extract(request({ signal: new AbortController().signal }));
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1));
    expect(worker.ref).toHaveBeenCalledTimes(1);
    expect(worker.unref).not.toHaveBeenCalled();
    worker.emit("message", {
      status: "ok",
      result: { text: "first", images: [] },
      imageExtractionErrors: [],
    });
    await expect(first).resolves.toEqual({ text: "first", images: [] });
    expect(worker.unref).toHaveBeenCalledTimes(1);

    const second = extractor.extract(request({ signal: new AbortController().signal }));
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    expect(worker.ref).toHaveBeenCalledTimes(2);
    expect(worker.unref).toHaveBeenCalledTimes(1);
    worker.emit("message", {
      status: "ok",
      result: { text: "second", images: [] },
      imageExtractionErrors: [],
    });
    await expect(second).resolves.toEqual({ text: "second", images: [] });
    expect(worker.unref).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "source checkout beneath a dist directory",
      moduleUrl:
        "file:///srv/dist/openclaw/extensions/document-extract/document-extractor.ts",
      workerUrl:
        "file:///srv/dist/openclaw/extensions/document-extract/document-extractor.worker.ts",
    },
    {
      label: "built plugin output",
      moduleUrl:
        "file:///opt/openclaw/dist/extensions/document-extract/document-extractor.js",
      workerUrl:
        "file:///opt/openclaw/dist/extensions/document-extract/document-extractor.worker.js",
    },
  ])("resolves the PDF worker beside the $label module", ({ moduleUrl, workerUrl }) => {
    expect(testOnlyDocumentExtractor.resolvePdfExtractionWorkerUrl(moduleUrl).href).toBe(workerUrl);
  });

  it("bounds concurrent PDF workers and admits queued work after a slot is released", async () => {
    const started = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const startedView = new Int32Array(started);
    const blockingWorkerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { workerData } from "node:worker_threads";
        const started = new Int32Array(workerData.started);
        Atomics.store(started, workerData.index, 1);
        Atomics.notify(started, workerData.index);
        Atomics.wait(started, workerData.index, 1);
      `)}`,
    );
    const workers: Worker[] = [];
    const createWorker = vi.fn(() => {
      const worker = new Worker(blockingWorkerUrl, {
        workerData: { started, index: workers.length },
      });
      workers.push(worker);
      return worker;
    });
    const extractor = createPdfDocumentExtractor({
      createWorker,
      workerPool: testOnlyDocumentExtractor.createPdfWorkerPool(
        testOnlyDocumentExtractor.maxConcurrentPdfWorkers,
      ),
    });
    const controllers = [
      new AbortController(),
      new AbortController(),
      new AbortController(),
    ] as const;
    const pending = controllers.map((controller) =>
      extractor.extract(request({ signal: controller.signal })),
    );

    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(Atomics.load(startedView, 0)).toBe(1);
      expect(Atomics.load(startedView, 1)).toBe(1);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(createWorker).toHaveBeenCalledTimes(2);

    controllers[0].abort(new Error("release first PDF worker"));
    await expect(pending[0]).rejects.toThrow("release first PDF worker");
    expect(workers[0]?.threadId).toBe(-1);
    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(Atomics.load(startedView, 2)).toBe(1));

    const secondAssertion = expect(pending[1]).rejects.toThrow("release second PDF worker");
    const thirdAssertion = expect(pending[2]).rejects.toThrow("release queued PDF worker");
    controllers[1].abort(new Error("release second PDF worker"));
    controllers[2].abort(new Error("release queued PDF worker"));
    await secondAssertion;
    await thirdAssertion;
    expect(workers[1]?.threadId).toBe(-1);
    expect(workers[2]?.threadId).toBe(-1);
    expect(pdfDocument.extract).not.toHaveBeenCalled();
  });

  it("completes queued connected work on a warm worker", async () => {
    const workers = [createControlledWorkerDouble(), createControlledWorkerDouble()] as const;
    const createWorker = vi
      .fn()
      .mockImplementationOnce(() => workers[0])
      .mockImplementationOnce(() => workers[1]);
    const extractor = createPdfDocumentExtractor({
      createWorker,
      workerPool: testOnlyDocumentExtractor.createPdfWorkerPool(
        testOnlyDocumentExtractor.maxConcurrentPdfWorkers,
      ),
    });
    const pending = [
      extractor.extract(request({ signal: new AbortController().signal })),
      extractor.extract(request({ signal: new AbortController().signal })),
      extractor.extract(request({ signal: new AbortController().signal })),
    ] as const;

    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(2));
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
    expect(workers[1].postMessage).toHaveBeenCalledTimes(1);
    workers[0].emit("message", {
      status: "ok",
      result: { text: "first", images: [] },
      imageExtractionErrors: [],
    });
    await expect(pending[0]).resolves.toEqual({ text: "first", images: [] });
    await vi.waitFor(() => expect(workers[0].postMessage).toHaveBeenCalledTimes(2));
    workers[0].emit("message", {
      status: "ok",
      result: { text: "third", images: [] },
      imageExtractionErrors: [],
    });
    workers[1].emit("message", {
      status: "ok",
      result: { text: "second", images: [] },
      imageExtractionErrors: [],
    });

    await expect(pending[1]).resolves.toEqual({ text: "second", images: [] });
    await expect(pending[2]).resolves.toEqual({ text: "third", images: [] });
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    expect(workers[1].terminate).not.toHaveBeenCalled();
  });

  it("bounds pending PDF requests and rejects overflow without creating a worker", async () => {
    const workers = [createControlledWorkerDouble(), createControlledWorkerDouble()] as const;
    const createWorker = vi
      .fn()
      .mockImplementationOnce(() => workers[0])
      .mockImplementationOnce(() => workers[1]);
    const extractor = createPdfDocumentExtractor({
      createWorker,
      workerPool: testOnlyDocumentExtractor.createPdfWorkerPool(
        testOnlyDocumentExtractor.maxConcurrentPdfWorkers,
        testOnlyDocumentExtractor.maxPendingPdfRequests,
      ),
    });
    const admittedCount =
      testOnlyDocumentExtractor.maxConcurrentPdfWorkers +
      testOnlyDocumentExtractor.maxPendingPdfRequests;
    const controllers = Array.from({ length: admittedCount + 1 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      extractor.extract(request({ signal: controller.signal })),
    );

    await expect(pending.at(-1)).rejects.toThrow(
      `PDF extraction worker queue is full (${testOnlyDocumentExtractor.maxPendingPdfRequests} pending requests); retry later`,
    );
    const admittedAssertions = pending
      .slice(0, admittedCount)
      .map((request) => expect(request).rejects.toThrow("test cleanup"));
    for (const controller of controllers.slice(0, admittedCount)) {
      controller.abort(new Error("test cleanup"));
    }
    await Promise.all(admittedAssertions);

    expect(createWorker).toHaveBeenCalledTimes(testOnlyDocumentExtractor.maxConcurrentPdfWorkers);
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    expect(workers[1].terminate).toHaveBeenCalledTimes(1);
    expect(workers[0].ref).toHaveBeenCalledTimes(1);
    expect(workers[1].ref).toHaveBeenCalledTimes(1);
    expect(workers[0].unref).not.toHaveBeenCalled();
    expect(workers[1].unref).not.toHaveBeenCalled();
  });

  it.each([
    { event: "error" as const, value: new Error("idle worker failed"), terminates: true },
    { event: "exit" as const, value: 1, terminates: false },
  ])("evicts an idle worker after $event", async ({ event, value, terminates }) => {
    const firstWorker = createWorkerDouble({
      status: "ok",
      result: { text: "first", images: [] },
      imageExtractionErrors: [],
    });
    const secondWorker = createWorkerDouble({
      status: "ok",
      result: { text: "second", images: [] },
      imageExtractionErrors: [],
    });
    const createWorker = vi
      .fn()
      .mockImplementationOnce(() => firstWorker)
      .mockImplementationOnce(() => secondWorker);
    const extractor = createPdfDocumentExtractor({
      createWorker,
      workerPool: testOnlyDocumentExtractor.createPdfWorkerPool(1),
    });

    await expect(
      extractor.extract(request({ signal: new AbortController().signal })),
    ).resolves.toEqual({ text: "first", images: [] });
    firstWorker.emit(event, value);
    await expect(
      extractor.extract(request({ signal: new AbortController().signal })),
    ).resolves.toEqual({ text: "second", images: [] });

    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(firstWorker.terminate).toHaveBeenCalledTimes(terminates ? 1 : 0);
    expect(firstWorker.ref).toHaveBeenCalledTimes(terminates ? 2 : 1);
    expect(firstWorker.unref).toHaveBeenCalledTimes(1);
  });

  it("removes aborted PDF requests from the worker admission queue", async () => {
    const started = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const startedView = new Int32Array(started);
    const blockingWorkerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { workerData } from "node:worker_threads";
        const started = new Int32Array(workerData.started);
        Atomics.store(started, 0, 1);
        Atomics.notify(started, 0);
        Atomics.wait(started, 0, 1);
      `)}`,
    );
    let worker: Worker | undefined;
    const createWorker = vi.fn(() => {
      worker = new Worker(blockingWorkerUrl, { workerData: { started } });
      return worker;
    });
    const extractor = createPdfDocumentExtractor({
      createWorker,
      workerPool: testOnlyDocumentExtractor.createPdfWorkerPool(1),
    });
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = extractor.extract(request({ signal: activeController.signal }));
    const queued = extractor.extract(request({ signal: queuedController.signal }));

    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(Atomics.load(startedView, 0)).toBe(1));
    queuedController.abort(new Error("queued PDF request disconnected"));
    await expect(queued).rejects.toThrow("queued PDF request disconnected");
    expect(createWorker).toHaveBeenCalledTimes(1);

    activeController.abort(new Error("active PDF request disconnected"));
    await expect(active).rejects.toThrow("active PDF request disconnected");
    expect(worker?.threadId).toBe(-1);
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it("terminates in-flight PDF work when the caller aborts", async () => {
    const controller = new AbortController();
    const started = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const startedView = new Int32Array(started);
    const blockingWorkerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { workerData } from "node:worker_threads";
        const started = new Int32Array(workerData.started);
        Atomics.store(started, 0, 1);
        Atomics.notify(started, 0);
        Atomics.wait(started, 0, 1);
      `)}`,
    );
    let worker: Worker | undefined;
    const createWorker = vi.fn(() => {
      worker = new Worker(blockingWorkerUrl, { workerData: { started } });
      return worker;
    });
    const extractor = createPdfDocumentExtractor({ createWorker });
    const pending = extractor.extract(request({ signal: controller.signal }));

    await vi.waitFor(() => expect(createWorker).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(Atomics.load(startedView, 0)).toBe(1));
    controller.abort(new Error("client disconnected"));

    await expect(pending).rejects.toThrow("client disconnected");
    expect(worker?.threadId).toBe(-1);
    expect(pdfDocument.extract).not.toHaveBeenCalled();
  });

  it("releases worker admission when an image-error callback throws", async () => {
    const worker = createWorkerDouble(
      {
        status: "ok",
        result: { text: "partial", images: [] },
        imageExtractionErrors: ["render failed"],
      },
      {
        status: "ok",
        result: { text: "next", images: [] },
        imageExtractionErrors: [],
      },
    );
    const createWorker = vi.fn(() => worker);
    const extractor = createPdfDocumentExtractor({
      createWorker,
      workerPool: testOnlyDocumentExtractor.createPdfWorkerPool(1),
    });

    await expect(
      extractor.extract(
        request({
          signal: new AbortController().signal,
          onImageExtractionError: () => {
            throw new Error("callback failed");
          },
        }),
      ),
    ).rejects.toThrow("callback failed");
    await expect(
      extractor.extract(request({ signal: new AbortController().signal })),
    ).resolves.toEqual({ text: "next", images: [] });
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("replays image errors before rejecting a worker extraction failure", async () => {
    const onImageExtractionError = vi.fn();
    const extractor = createPdfDocumentExtractor({
      createWorker: () =>
        createWorkerDouble({
          status: "error",
          error: "PDF image extraction failed with no extractable text.",
          imageExtractionErrors: ["render budget exceeded"],
        }),
    });

    await expect(
      extractor.extract(
        request({
          signal: new AbortController().signal,
          onImageExtractionError,
        }),
      ),
    ).rejects.toThrow("PDF image extraction failed with no extractable text.");
    expect(onImageExtractionError).toHaveBeenCalledTimes(1);
    expect(onImageExtractionError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "render budget exceeded" }),
    );
  });

  it.each([
    { label: "empty", text: "", reportError: true },
    { label: "whitespace-only", text: " \t\n", reportError: false },
  ])("surfaces image fallback failures for $label PDF text", async ({ text, reportError }) => {
    const { PdfBudgetError } = await vi.importActual<typeof import("clawpdf")>("clawpdf");
    const onImageExtractionError = vi.fn();
    const failure = new PdfBudgetError("renderPixels", 100);
    pdfDocument.extract.mockResolvedValueOnce({ text, images: [] }).mockRejectedValueOnce(failure);
    const overrides = reportError ? { onImageExtractionError } : {};

    await expect(createPdfDocumentExtractor().extract(request(overrides))).rejects.toMatchObject({
      message: "PDF image extraction failed with no extractable text.",
      cause: failure,
    });
    expect(onImageExtractionError).toHaveBeenCalledTimes(reportError ? 1 : 0);
    if (reportError) {
      expect(onImageExtractionError).toHaveBeenCalledWith(failure);
    }
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });
});
