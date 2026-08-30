// Document extractor runtime helpers choose lazy extraction adapters by media type.
import { Worker } from "node:worker_threads";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toErrorObject } from "../infra/errors.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
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

const documentExtractorLoader = createConfigScopedPromiseLoader((config?: OpenClawConfig) =>
  resolvePluginDocumentExtractors(config ? { config } : undefined),
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

async function extractDocumentContentInWorker(
  params: DocumentExtractionRuntimeRequest & { signal: AbortSignal },
): Promise<TaggedDocumentExtractionResult | null> {
  const signal = params.signal;
  signal.throwIfAborted();
  const workerUrl = documentExtractionWorkerUrl();
  const worker = new Worker(workerUrl, {
    ...(workerUrl.pathname.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
    workerData: {
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
    } satisfies DocumentExtractionWorkerInput,
  });

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
      // ClawPDF/PDFium has no cancellation contract. Do not settle the caller
      // until the isolated runtime and its native allocations are gone.
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
    const onMessage = (message: DocumentExtractionWorkerOutput) => {
      void settleAfterTermination(() => {
        try {
          replayImageExtractionErrors(message.imageExtractionErrors);
        } catch (error) {
          reject(toErrorObject(error, "Document image extraction error callback failed"));
          return;
        }
        if (message.status === "error") {
          reject(new Error(message.error));
          return;
        }
        resolve(message.result);
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
}

/** Runs the first matching plugin document extractor and tags successful results with its extractor id. */
export async function extractDocumentContent(
  params: DocumentExtractionRuntimeRequest,
): Promise<TaggedDocumentExtractionResult | null> {
  return params.signal
    ? await extractDocumentContentInWorker({ ...params, signal: params.signal })
    : await extractDocumentContentDirect(params);
}
