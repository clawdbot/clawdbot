// Document Extract worker isolates killable PDF parsing from request-handling threads.
import { parentPort, workerData } from "node:worker_threads";
import {
  extractPdfContentInProcess,
  type PdfExtractionWorkerInput,
  type PdfExtractionWorkerResult,
} from "./document-extractor.js";

if (!parentPort) {
  throw new Error("PDF extraction worker requires a parent port");
}

const port = parentPort;
const input = workerData as PdfExtractionWorkerInput;
const imageExtractionErrors: string[] = [];

try {
  const result = await extractPdfContentInProcess({
    ...input,
    buffer: Buffer.from(input.buffer),
    onImageExtractionError: (error) => {
      imageExtractionErrors.push(error instanceof Error ? error.message : String(error));
    },
  });
  port.postMessage({
    status: "ok",
    result,
    imageExtractionErrors,
  } satisfies PdfExtractionWorkerResult);
} catch (error) {
  port.postMessage({
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  } satisfies PdfExtractionWorkerResult);
} finally {
  port.close();
}
