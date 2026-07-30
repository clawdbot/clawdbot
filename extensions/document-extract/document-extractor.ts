// Document Extract plugin module implements document extractor behavior.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type { PdfDocument, PdfEngine, PdfImage } from "clawpdf";
import type {
  DocumentExtractedImage,
  DocumentExtractionRequest,
  DocumentExtractionResult,
  DocumentExtractorPlugin,
} from "openclaw/plugin-sdk/document-extractor";

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
    };

type PdfExtractionWorker = {
  once(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  removeAllListeners(): unknown;
  terminate(): Promise<number>;
  unref(): unknown;
};

type PdfDocumentExtractorOptions = {
  createWorker?: (url: URL, options: WorkerOptions) => PdfExtractionWorker;
  workerUrl?: URL;
};

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
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(
      path.join(distRoot, "extensions", "document-extract", "document-extractor.worker.js"),
    );
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./document-extractor.worker${extension}`, currentModuleUrl);
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(value === undefined ? fallback : String(value));
}

function parseWorkerResult(message: unknown): PdfExtractionWorkerResult | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const candidate = message as Record<string, unknown>;
  if (candidate.status === "error" && typeof candidate.error === "string") {
    return { status: "error", error: candidate.error };
  }
  if (
    candidate.status !== "ok" ||
    !candidate.result ||
    typeof candidate.result !== "object" ||
    typeof (candidate.result as { text?: unknown }).text !== "string" ||
    !Array.isArray((candidate.result as { images?: unknown }).images) ||
    !Array.isArray(candidate.imageExtractionErrors) ||
    !candidate.imageExtractionErrors.every((entry) => typeof entry === "string")
  ) {
    return undefined;
  }
  return candidate as PdfExtractionWorkerResult;
}

async function extractPdfContentInWorker(
  request: DocumentExtractionRequest,
  options: PdfDocumentExtractorOptions,
): Promise<DocumentExtractionResult> {
  request.signal?.throwIfAborted();
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
  let worker: PdfExtractionWorker;
  try {
    worker = createWorker(workerUrl, {
      workerData: workerInput,
      ...(execArgv ? { execArgv } : {}),
    });
  } catch (error) {
    throw toError(error, "PDF extraction worker failed to start");
  }
  worker.unref();

  return await new Promise<DocumentExtractionResult>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      request.signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
    };
    const settle = (finish: () => void, terminate: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (!terminate) {
        finish();
        return;
      }
      void worker.terminate().then(finish, finish);
    };
    const abort = () => {
      settle(
        () => reject(toError(request.signal?.reason, "PDF extraction aborted before completion")),
        true,
      );
    };

    worker.once("message", (message) => {
      const result = parseWorkerResult(message);
      settle(() => {
        if (!result) {
          reject(new Error("PDF extraction worker returned an invalid result"));
          return;
        }
        if (result.status === "error") {
          reject(new Error(result.error));
          return;
        }
        for (const error of result.imageExtractionErrors) {
          request.onImageExtractionError?.(new Error(error));
        }
        resolve(result.result);
      }, false);
    });
    worker.once("error", (error) => {
      settle(() => reject(toError(error, "PDF extraction worker failed")), true);
    });
    worker.once("exit", (code) => {
      if (code === 0) {
        settle(() => reject(new Error("PDF extraction worker exited without a result")), false);
        return;
      }
      settle(() => reject(new Error(`PDF extraction worker exited with code ${code}`)), false);
    });
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) {
      abort();
    }
  });
}

export function createPdfDocumentExtractor(
  options: PdfDocumentExtractorOptions = {},
): DocumentExtractorPlugin {
  return {
    id: "pdf",
    label: "PDF",
    mimeTypes: ["application/pdf"],
    autoDetectOrder: 10,
    extract: (request) =>
      request.signal
        ? extractPdfContentInWorker(request, options)
        : extractPdfContentInProcess(request),
  };
}
