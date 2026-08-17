// Document Extract plugin module implements document extractor behavior.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type { PdfDocument, PdfEngine, PdfImage } from "clawpdf";
import {
  createDocumentExtractorCapacityError,
  type DocumentExtractedImage,
  type DocumentExtractionRequest,
  type DocumentExtractionResult,
  type DocumentExtractorPlugin,
} from "openclaw/plugin-sdk/document-extractor";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";

const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const MAX_RENDER_DIMENSION = 10_000;

export type PdfExtractionWorkerInput = {
  buffer: Uint8Array;
  mimeType: string;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  password?: string;
  pageNumbers?: number[];
};

export type PdfExtractionWorkerResult =
  | {
      status: "ok";
      result: DocumentExtractionResult;
      imageExtractionErrors: string[];
    }
  | {
      status: "error";
      error: string;
      imageExtractionErrors: string[];
    };

type PdfExtractionWorker = {
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  once(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: PdfExtractionWorkerInput): void;
  removeListener(event: "message", listener: (message: unknown) => void): unknown;
  removeListener(event: "error", listener: (error: unknown) => void): unknown;
  removeListener(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  ref(): unknown;
  unref(): unknown;
};

type PdfDocumentExtractorOptions = {
  createWorker?: (url: URL, options: WorkerOptions) => PdfExtractionWorker;
  workerPool?: PdfWorkerPool;
  workerUrl?: URL;
};

type PdfWorkerLease = {
  worker: PdfExtractionWorker;
  release: (reusable: boolean) => Promise<void>;
};

type PdfWorkerWaiter = {
  resolve: (lease: PdfWorkerLease) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
  createWorker: () => PdfExtractionWorker;
};

// Each PDFium worker owns a WASM engine, a copied input buffer, and render buffers.
// Match OpenClaw's default bounded media-processing concurrency instead of allowing
// pre-dispatch HTTP requests to create an unbounded number of those workers.
const MAX_CONCURRENT_PDF_WORKERS = 2;
const MAX_PENDING_PDF_REQUESTS = MAX_CONCURRENT_PDF_WORKERS * 2;

let pdfEnginePromise: Promise<PdfEngine> | null = null;

async function loadPdfEngine(): Promise<PdfEngine> {
  if (!pdfEnginePromise) {
    pdfEnginePromise = import("clawpdf")
      .then(({ createEngine }) => createEngine())
      .catch((err: unknown) => {
        pdfEnginePromise = null;
        throw new Error("Dependency clawpdf is required for PDF extraction", {
          cause: err,
        });
      });
  }
  return pdfEnginePromise;
}

function toDocumentImage(image: PdfImage): DocumentExtractedImage {
  return {
    type: "image",
    data: Buffer.from(image.bytes).toString("base64"),
    mimeType: image.mimeType,
  };
}

function isPdfPasswordError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === "password");
}

async function openPdfDocument(params: {
  engine: PdfEngine;
  input: Uint8Array;
  password?: string;
}): Promise<PdfDocument> {
  try {
    return params.password
      ? await params.engine.open(params.input, { password: params.password })
      : await params.engine.open(params.input);
  } catch (err) {
    if (isPdfPasswordError(err)) {
      throw new Error("PDF requires a password or password is incorrect.", { cause: err });
    }
    throw err;
  }
}

export async function extractPdfContentInProcess(
  request: DocumentExtractionRequest,
): Promise<DocumentExtractionResult> {
  request.signal?.throwIfAborted();
  const engine = await loadPdfEngine();
  request.signal?.throwIfAborted();
  const pdf = await openPdfDocument({
    engine,
    input: new Uint8Array(request.buffer),
    ...(request.password ? { password: request.password } : {}),
  });
  try {
    request.signal?.throwIfAborted();
    const pages = request.pageNumbers
      ? request.pageNumbers
          .filter((p) => Number.isInteger(p) && p >= 1 && p <= pdf.pageCount)
          .slice(0, request.maxPages)
      : undefined;
    if (request.pageNumbers?.length && pages?.length === 0) {
      throw new Error(`No requested PDF pages exist in this ${pdf.pageCount}-page document.`);
    }
    const pageSelection = pages ? { pages } : { maxPages: request.maxPages };

    const textResult = await pdf.extract({
      mode: "text",
      ...pageSelection,
      maxTextChars: MAX_EXTRACTED_TEXT_CHARS,
    });
    request.signal?.throwIfAborted();
    const text = textResult.text;

    if (text.trim().length >= request.minTextChars) {
      return { text, images: [] };
    }

    // clawpdf's image render budget (maxPixels) is shared across every page in one
    // extract() call: the first page consumes it and later pages collapse to 1x1
    // PNGs that vision models reject. Render each page separately, allocating the
    // remaining aggregate budget across pages that still need rendering.
    const imagePages =
      pages ?? Array.from({ length: Math.min(pdf.pageCount, request.maxPages) }, (_, i) => i + 1);

    try {
      const images: DocumentExtractedImage[] = [];
      let remainingPixels = request.maxPixels;
      for (const [index, pageNumber] of imagePages.entries()) {
        request.signal?.throwIfAborted();
        if (remainingPixels <= 0) {
          break;
        }
        const pagesRemaining = imagePages.length - index;
        const maxPixelsPerPage = Math.max(1, Math.ceil(remainingPixels / pagesRemaining));
        const imageResult = await pdf.extract({
          mode: "images",
          pages: [pageNumber],
          image: {
            maxDimension: MAX_RENDER_DIMENSION,
            maxPixels: maxPixelsPerPage,
            forms: true,
          },
        });
        request.signal?.throwIfAborted();
        for (const image of imageResult.images) {
          images.push(toDocumentImage(image));
          remainingPixels -= image.width * image.height;
        }
      }
      return { text, images };
    } catch (err) {
      request.signal?.throwIfAborted();
      request.onImageExtractionError?.(err);
      if (!text.trim()) {
        throw new Error("PDF image extraction failed with no extractable text.", { cause: err });
      }
      return { text, images: [] };
    }
  } finally {
    pdf.destroy();
  }
}

function resolvePdfExtractionWorkerUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  const pathWithinDist =
    distIndex >= 0 ? normalized.slice(distIndex + distMarker.length) : undefined;
  if (
    pathWithinDist &&
    !pathWithinDist.includes("/") &&
    path.extname(currentPath) === ".js"
  ) {
    // Bundling may hoist this implementation into a shared root dist chunk while
    // the worker stays in the plugin artifact directory.
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(
      path.join(distRoot, "extensions", "document-extract", "document-extractor.worker.js"),
    );
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./document-extractor.worker${extension}`, currentModuleUrl);
}

class PdfWorkerPool {
  private total = 0;
  private readonly failed = new WeakSet<PdfExtractionWorker>();
  private readonly idle: PdfExtractionWorker[] = [];
  private readonly leased = new Set<PdfExtractionWorker>();
  private readonly lifecycleListeners = new Map<
    PdfExtractionWorker,
    { onError: (error: unknown) => void; onExit: (code: number) => void }
  >();
  private readonly retiring = new WeakSet<PdfExtractionWorker>();
  private readonly waiters = new Set<PdfWorkerWaiter>();

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxPending: number,
  ) {}

  async run<T>(
    signal: AbortSignal,
    createWorker: () => PdfExtractionWorker,
    task: (worker: PdfExtractionWorker, discard: () => void) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(signal, createWorker);
    let reusable = true;
    try {
      signal.throwIfAborted();
      return await task(lease.worker, () => {
        reusable = false;
      });
    } finally {
      await lease.release(reusable);
    }
  }

  private async acquire(
    signal: AbortSignal,
    createWorker: () => PdfExtractionWorker,
  ): Promise<PdfWorkerLease> {
    signal.throwIfAborted();
    const idleWorker = this.idle.pop();
    if (idleWorker) {
      return this.createLease(idleWorker);
    }
    if (this.total < this.maxConcurrent) {
      return this.createWorkerLease(createWorker);
    }
    if (this.waiters.size >= this.maxPending) {
      throw createDocumentExtractorCapacityError(
        `PDF extraction worker queue is full (${this.maxPending} pending requests); retry later`,
      );
    }
    // Keep the caller's input-file deadline active while queued. Otherwise buffered
    // PDFs could outlive their request budget while waiting for bounded capacity.
    return await new Promise<PdfWorkerLease>((resolve, reject) => {
      const waiter: PdfWorkerWaiter = {
        resolve,
        reject,
        signal,
        createWorker,
        onAbort: () => {
          signal.removeEventListener("abort", waiter.onAbort);
          if (!this.waiters.delete(waiter)) {
            return;
          }
          reject(
            toErrorObject(signal.reason, "PDF extraction aborted while waiting for a worker"),
          );
        },
      };
      this.waiters.add(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) {
        waiter.onAbort();
      }
    });
  }

  private createWorkerLease(createWorker: () => PdfExtractionWorker): PdfWorkerLease {
    const worker = createWorker();
    this.attachLifecycleListeners(worker);
    this.total += 1;
    return this.createLease(worker);
  }

  private createLease(worker: PdfExtractionWorker): PdfWorkerLease {
    let released = false;
    worker.ref();
    this.leased.add(worker);
    return {
      worker,
      release: async (reusable) => {
        if (released) {
          return;
        }
        released = true;
        this.leased.delete(worker);
        if (reusable && !this.failed.has(worker)) {
          this.idle.push(worker);
          worker.unref();
        } else {
          // Keep the slot occupied until termination so a replacement cannot
          // overlap the cancelled worker's PDFium and render allocations.
          try {
            await worker.terminate();
          } catch {
            // Worker termination is best-effort after the result is already settled.
          }
          this.detachLifecycleListeners(worker);
          this.total = Math.max(0, this.total - 1);
        }
        this.drain();
      },
    };
  }

  private attachLifecycleListeners(worker: PdfExtractionWorker): void {
    const onError = () => {
      this.failed.add(worker);
      if (!this.leased.has(worker)) {
        void this.retireIdleWorker(worker, true);
      }
    };
    const onExit = () => {
      this.failed.add(worker);
      if (!this.leased.has(worker)) {
        void this.retireIdleWorker(worker, false);
      }
    };
    this.lifecycleListeners.set(worker, { onError, onExit });
    worker.on("error", onError);
    worker.on("exit", onExit);
  }

  private detachLifecycleListeners(worker: PdfExtractionWorker): void {
    const listeners = this.lifecycleListeners.get(worker);
    if (!listeners) {
      return;
    }
    worker.removeListener("error", listeners.onError);
    worker.removeListener("exit", listeners.onExit);
    this.lifecycleListeners.delete(worker);
  }

  private async retireIdleWorker(worker: PdfExtractionWorker, terminate: boolean): Promise<void> {
    if (this.retiring.has(worker)) {
      return;
    }
    const index = this.idle.indexOf(worker);
    if (index < 0) {
      return;
    }
    this.retiring.add(worker);
    this.idle.splice(index, 1);
    if (terminate) {
      // Idle workers are unreferenced; keep a failed worker alive until its
      // termination releases the pool slot and its native allocations.
      worker.ref();
      try {
        await worker.terminate();
      } catch {
        // The worker already failed; eviction still has to release its pool slot.
      }
    }
    this.detachLifecycleListeners(worker);
    this.total = Math.max(0, this.total - 1);
    this.drain();
  }

  private drain(): void {
    while (this.waiters.size > 0) {
      if (this.idle.length === 0 && this.total >= this.maxConcurrent) {
        return;
      }
      const waiter = this.waiters.values().next().value;
      if (!waiter) {
        return;
      }
      this.waiters.delete(waiter);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(
          toErrorObject(waiter.signal.reason, "PDF extraction aborted while waiting for a worker"),
        );
        continue;
      }
      try {
        const idleWorker = this.idle.pop();
        waiter.resolve(
          idleWorker
            ? this.createLease(idleWorker)
            : this.createWorkerLease(waiter.createWorker),
        );
      } catch (error) {
        waiter.reject(toErrorObject(error, "PDF extraction worker failed to start"));
      }
    }
  }
}

// The public artifact module is process-cached, so this pool owns warm PDFium
// workers for the same lifecycle while still replacing any cancelled worker.
const sharedPdfWorkerPool = new PdfWorkerPool(
  MAX_CONCURRENT_PDF_WORKERS,
  MAX_PENDING_PDF_REQUESTS,
);

function parseWorkerResult(message: unknown): PdfExtractionWorkerResult | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const candidate = message as Record<string, unknown>;
  if (
    !Array.isArray(candidate.imageExtractionErrors) ||
    !candidate.imageExtractionErrors.every((entry) => typeof entry === "string")
  ) {
    return undefined;
  }
  if (candidate.status === "error" && typeof candidate.error === "string") {
    return {
      status: "error",
      error: candidate.error,
      imageExtractionErrors: candidate.imageExtractionErrors,
    };
  }
  if (
    candidate.status !== "ok" ||
    !candidate.result ||
    typeof candidate.result !== "object" ||
    typeof (candidate.result as { text?: unknown }).text !== "string" ||
    !Array.isArray((candidate.result as { images?: unknown }).images)
  ) {
    return undefined;
  }
  return candidate as PdfExtractionWorkerResult;
}

async function extractPdfContentInWorker(
  request: DocumentExtractionRequest,
  options: PdfDocumentExtractorOptions,
  workerPool: PdfWorkerPool,
): Promise<DocumentExtractionResult> {
  const signal = request.signal;
  if (!signal) {
    return await extractPdfContentInProcess(request);
  }
  signal.throwIfAborted();
  const workerUrl = options.workerUrl ?? resolvePdfExtractionWorkerUrl();
  const execArgv = workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined;
  const workerInput: PdfExtractionWorkerInput = {
    buffer: request.buffer,
    mimeType: request.mimeType,
    maxPages: request.maxPages,
    maxPixels: request.maxPixels,
    minTextChars: request.minTextChars,
    ...(request.password ? { password: request.password } : {}),
    ...(request.pageNumbers ? { pageNumbers: request.pageNumbers } : {}),
  };
  const createWorker =
    options.createWorker ??
    ((url: URL, workerOptions: WorkerOptions) => new Worker(url, workerOptions));
  return await workerPool.run(
    signal,
    () => {
      let worker: PdfExtractionWorker;
      try {
        worker = createWorker(workerUrl, execArgv ? { execArgv } : {});
      } catch (error) {
        throw toErrorObject(error, "PDF extraction worker failed to start");
      }
      return worker;
    },
    async (worker, discard) =>
      await new Promise<DocumentExtractionResult>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          signal.removeEventListener("abort", onAbort);
          worker.removeListener("message", onMessage);
          worker.removeListener("error", onError);
          worker.removeListener("exit", onExit);
        };
        const settle = (finish: () => void, reusable: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          if (!reusable) {
            discard();
          }
          finish();
        };
        const onAbort = () => {
          settle(
            () => reject(toErrorObject(signal.reason, "PDF extraction aborted before completion")),
            false,
          );
        };
        const onMessage = (message: unknown) => {
          const result = parseWorkerResult(message);
          settle(
            () => {
              if (!result) {
                reject(new Error("PDF extraction worker returned an invalid result"));
                return;
              }
              try {
                for (const error of result.imageExtractionErrors) {
                  request.onImageExtractionError?.(new Error(error));
                }
              } catch (error) {
                reject(toErrorObject(error, "PDF image extraction error callback failed"));
                return;
              }
              if (result.status === "error") {
                reject(new Error(result.error));
                return;
              }
              resolve(result.result);
            },
            Boolean(result),
          );
        };
        const onError = (error: unknown) => {
          settle(() => reject(toErrorObject(error, "PDF extraction worker failed")), false);
        };
        const onExit = (code: number) => {
          const message =
            code === 0
              ? "PDF extraction worker exited without a result"
              : `PDF extraction worker exited with code ${code}`;
          settle(() => reject(new Error(message)), false);
        };

        worker.once("message", onMessage);
        worker.once("error", onError);
        worker.once("exit", onExit);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
        try {
          worker.postMessage(workerInput);
        } catch (error) {
          settle(
            () => reject(toErrorObject(error, "PDF extraction worker request failed")),
            false,
          );
        }
      }),
  );
}

export function createPdfDocumentExtractor(
  options: PdfDocumentExtractorOptions = {},
): DocumentExtractorPlugin {
  const workerPool =
    options.workerPool ??
    (options.createWorker || options.workerUrl
      ? new PdfWorkerPool(MAX_CONCURRENT_PDF_WORKERS, MAX_PENDING_PDF_REQUESTS)
      : sharedPdfWorkerPool);
  return {
    id: "pdf",
    label: "PDF",
    mimeTypes: ["application/pdf"],
    autoDetectOrder: 10,
    extract: (request) =>
      request.signal
        ? extractPdfContentInWorker(request, options, workerPool)
        : extractPdfContentInProcess(request),
  };
}

export const testOnlyDocumentExtractor = {
  createPdfWorkerPool: (maxConcurrent: number, maxPending = maxConcurrent * 2) =>
    new PdfWorkerPool(
      Math.max(1, Math.floor(maxConcurrent)),
      Math.max(0, Math.floor(maxPending)),
    ),
  maxConcurrentPdfWorkers: MAX_CONCURRENT_PDF_WORKERS,
  maxPendingPdfRequests: MAX_PENDING_PDF_REQUESTS,
  resolvePdfExtractionWorkerUrl,
};
