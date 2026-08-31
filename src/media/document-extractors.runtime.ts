// Document extractor runtime helpers choose lazy extraction adapters by media type.
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toErrorObject } from "../infra/errors.js";
import {
  resolveRuntimeWorkerExecArgv,
  resolveRuntimeWorkerUrl,
} from "../infra/runtime-worker-url.js";
import type {
  DocumentExtractionRequest,
  DocumentExtractionResult,
} from "../plugins/document-extractor-types.js";
import { resolvePluginDocumentExtractors } from "../plugins/document-extractors.runtime.js";
import { createConfigScopedPromiseLoader } from "../plugins/plugin-cache-primitives.js";

type DocumentExtractionRuntimeRequest = DocumentExtractionRequest & {
  config?: OpenClawConfig;
  signal?: AbortSignal;
};

type TaggedDocumentExtractionResult = DocumentExtractionResult & { extractor: string };

export type DocumentExtractionWorkerInput = {
  request: Omit<DocumentExtractionRequest, "buffer" | "onImageExtractionError"> & {
    buffer: Uint8Array;
  };
  config?: OpenClawConfig;
};

export type DocumentExtractionWorkerOutput =
  | {
      status: "ok";
      result: TaggedDocumentExtractionResult | null;
      imageExtractionErrors: string[];
    }
  | {
      status: "error";
      error: string;
      imageExtractionErrors: string[];
    };

type DocumentExtractionAdmissionWaiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
};

export const DOCUMENT_EXTRACTOR_CAPACITY_ERROR_CODE = "document_extractor_capacity" as const;

type DocumentExtractorCapacityError = Error & {
  readonly code: typeof DOCUMENT_EXTRACTOR_CAPACITY_ERROR_CODE;
};

function createDocumentExtractorCapacityError(message: string): DocumentExtractorCapacityError {
  return Object.assign(new Error(message), {
    name: "DocumentExtractorCapacityError",
    code: DOCUMENT_EXTRACTOR_CAPACITY_ERROR_CODE,
  });
}

export function isDocumentExtractorCapacityError(
  value: unknown,
): value is DocumentExtractorCapacityError {
  return isRecord(value) && value.code === DOCUMENT_EXTRACTOR_CAPACITY_ERROR_CODE;
}

// Each isolated extractor can own a WASM engine, copied input, and render buffers.
// Bound both active and waiting work before request dispatch can create unbounded native state.
const MAX_CONCURRENT_DOCUMENT_EXTRACTIONS = 2;
const MAX_PENDING_DOCUMENT_EXTRACTIONS = MAX_CONCURRENT_DOCUMENT_EXTRACTIONS * 2;

const documentExtractorLoader = createConfigScopedPromiseLoader((config?: OpenClawConfig) =>
  resolvePluginDocumentExtractors(config ? { config } : undefined),
);

class DocumentExtractionAdmission {
  private active = 0;
  private readonly waiters = new Set<DocumentExtractionAdmissionWaiter>();

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxPending: number,
  ) {}

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await task();
    } finally {
      release();
    }
  }

  private async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return this.createRelease();
    }
    if (this.waiters.size >= this.maxPending) {
      throw createDocumentExtractorCapacityError(
        `Document extraction worker queue is full (${this.maxPending} pending requests); retry later`,
      );
    }

    // Keep the request deadline active while queued so abandoned inputs never
    // outlive their caller while waiting for bounded native capacity.
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: DocumentExtractionAdmissionWaiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          signal.removeEventListener("abort", waiter.onAbort);
          if (!this.waiters.delete(waiter)) {
            return;
          }
          reject(
            toErrorObject(signal.reason, "Document extraction aborted while waiting for a worker"),
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

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.waiters.size > 0) {
      const waiter = this.waiters.values().next().value;
      if (!waiter) {
        return;
      }
      this.waiters.delete(waiter);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(
          toErrorObject(
            waiter.signal.reason,
            "Document extraction aborted while waiting for a worker",
          ),
        );
        continue;
      }
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }
}

const sharedDocumentExtractionAdmission = new DocumentExtractionAdmission(
  MAX_CONCURRENT_DOCUMENT_EXTRACTIONS,
  MAX_PENDING_DOCUMENT_EXTRACTIONS,
);

export async function extractDocumentContentDirect(
  params: DocumentExtractionRuntimeRequest,
): Promise<TaggedDocumentExtractionResult | null> {
  const mimeType = normalizeLowercaseStringOrEmpty(params.mimeType);
  const extractors = await documentExtractorLoader.load(params.config);
  // Keep config and runtime-only fields out of plugin calls; extractors receive the SDK request shape.
  const request: DocumentExtractionRequest = {
    buffer: params.buffer,
    mimeType: params.mimeType,
    maxPages: params.maxPages,
    maxPixels: params.maxPixels,
    minTextChars: params.minTextChars,
    ...(params.password ? { password: params.password } : {}),
    ...(params.pageNumbers ? { pageNumbers: params.pageNumbers } : {}),
    ...(params.onImageExtractionError
      ? { onImageExtractionError: params.onImageExtractionError }
      : {}),
  };
  const errors: unknown[] = [];

  for (const extractor of extractors) {
    if (
      !extractor.mimeTypes.map((entry) => normalizeLowercaseStringOrEmpty(entry)).includes(mimeType)
    ) {
      continue;
    }
    try {
      const result = await extractor.extract(request);
      if (result) {
        return {
          ...result,
          extractor: extractor.id,
        };
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Document extraction failed for ${mimeType || "unknown MIME type"}`, {
      cause: errors.length === 1 ? errors[0] : new AggregateError(errors),
    });
  }
  return null;
}

function documentExtractionWorkerUrl(): URL {
  return resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "document-extractors.worker",
    distWorkerPath: "media/document-extractors.worker.js",
  });
}

function parseDocumentExtractionWorkerOutput(
  value: unknown,
): DocumentExtractionWorkerOutput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const imageExtractionErrors = value.imageExtractionErrors;
  if (
    !Array.isArray(imageExtractionErrors) ||
    !imageExtractionErrors.every((entry) => typeof entry === "string")
  ) {
    return undefined;
  }
  if (value.status === "error" && typeof value.error === "string") {
    return { status: "error", error: value.error, imageExtractionErrors };
  }
  const result = value.result;
  if (value.status !== "ok") {
    return undefined;
  }
  if (result === null) {
    return { status: "ok", result: null, imageExtractionErrors };
  }
  if (
    !isRecord(result) ||
    typeof result.text !== "string" ||
    !Array.isArray(result.images) ||
    typeof result.extractor !== "string"
  ) {
    return undefined;
  }
  const images: DocumentExtractionResult["images"] = [];
  for (const image of result.images) {
    if (
      !isRecord(image) ||
      image.type !== "image" ||
      typeof image.data !== "string" ||
      typeof image.mimeType !== "string"
    ) {
      return undefined;
    }
    images.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return {
    status: "ok",
    result: { text: result.text, images, extractor: result.extractor },
    imageExtractionErrors,
  };
}

async function extractDocumentContentInWorker(
  params: DocumentExtractionRuntimeRequest & { signal: AbortSignal },
): Promise<TaggedDocumentExtractionResult | null> {
  const signal = params.signal;
  signal.throwIfAborted();
  const workerUrl = documentExtractionWorkerUrl();
  const sourceWorkerExecArgv = resolveRuntimeWorkerExecArgv(workerUrl);
  const workerInput: DocumentExtractionWorkerInput = {
    request: {
      buffer: params.buffer,
      mimeType: params.mimeType,
      maxPages: params.maxPages,
      maxPixels: params.maxPixels,
      minTextChars: params.minTextChars,
      ...(params.password ? { password: params.password } : {}),
      ...(params.pageNumbers ? { pageNumbers: params.pageNumbers } : {}),
    },
    ...(params.config ? { config: params.config } : {}),
  };

  return await sharedDocumentExtractionAdmission.run(signal, async () => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: workerInput,
        execArgv: sourceWorkerExecArgv,
      });
    } catch (error) {
      throw toErrorObject(error, "Document extraction worker failed to start");
    }

    return await new Promise<TaggedDocumentExtractionResult | null>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        worker.removeListener("message", onMessage);
        worker.removeListener("error", onError);
        worker.removeListener("exit", onExit);
      };
      const settleAfterTermination = async (finish: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        // Generic workers can retain plugin callbacks and native state. Terminate
        // every job, and keep admission held until those resources are gone.
        try {
          await worker.terminate();
        } catch (error) {
          reject(new Error("Document extraction worker failed to terminate", { cause: error }));
          return;
        }
        finish();
      };
      const replayImageExtractionErrors = (errors: readonly string[]) => {
        for (const error of errors) {
          params.onImageExtractionError?.(new Error(error));
        }
      };
      const onAbort = () => {
        void settleAfterTermination(() => {
          reject(toErrorObject(signal.reason, "Document extraction aborted before completion"));
        });
      };
      const onMessage = (message: unknown) => {
        const output = parseDocumentExtractionWorkerOutput(message);
        void settleAfterTermination(() => {
          if (!output) {
            reject(new Error("Document extraction worker returned an invalid result"));
            return;
          }
          try {
            replayImageExtractionErrors(output.imageExtractionErrors);
          } catch (error) {
            reject(toErrorObject(error, "Document image extraction error callback failed"));
            return;
          }
          if (output.status === "error") {
            reject(new Error(output.error));
            return;
          }
          resolve(output.result);
        });
      };
      const onError = (error: unknown) => {
        void settleAfterTermination(() => {
          reject(toErrorObject(error, "Document extraction worker failed"));
        });
      };
      const onExit = (code: number) => {
        void settleAfterTermination(() => {
          reject(
            new Error(
              code === 0
                ? "Document extraction worker exited without a result"
                : `Document extraction worker exited with code ${code}`,
            ),
          );
        });
      };

      worker.once("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  });
}

/** Runs the first matching plugin document extractor and tags successful results with its extractor id. */
export async function extractDocumentContent(
  params: DocumentExtractionRuntimeRequest,
): Promise<TaggedDocumentExtractionResult | null> {
  return params.signal
    ? await extractDocumentContentInWorker({ ...params, signal: params.signal })
    : await extractDocumentContentDirect(params);
}
