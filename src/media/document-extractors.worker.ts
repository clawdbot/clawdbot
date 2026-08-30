// Document extraction worker isolates plugins whose dependency has no cancellation contract.
import { parentPort, workerData } from "node:worker_threads";
import { formatErrorMessage } from "../infra/errors.js";
import {
  extractDocumentContentDirect,
  type DocumentExtractionWorkerInput,
  type DocumentExtractionWorkerOutput,
} from "./document-extractors.runtime.js";

if (!parentPort) {
  throw new Error("Document extraction worker requires a parent port");
}

const port = parentPort;

async function run(input: DocumentExtractionWorkerInput): Promise<void> {
  const imageExtractionErrors: string[] = [];
  try {
    const result = await extractDocumentContentDirect({
      ...input.request,
      buffer: Buffer.from(input.request.buffer),
      ...(input.config ? { config: input.config } : {}),
      onImageExtractionError: (error) => {
        imageExtractionErrors.push(formatErrorMessage(error));
      },
    });
    port.postMessage({
      status: "ok",
      result,
      imageExtractionErrors,
    } satisfies DocumentExtractionWorkerOutput);
  } catch (error) {
    port.postMessage({
      status: "error",
      error: formatErrorMessage(error),
      imageExtractionErrors,
    } satisfies DocumentExtractionWorkerOutput);
  }
}

// SAFETY: This private worker is started only by extractDocumentContentInWorker with this payload.
void run(workerData as DocumentExtractionWorkerInput);
