// Document Extract worker isolates killable PDF parsing from request-handling threads.
import { parentPort } from "node:worker_threads";
import {
  extractPdfContentInProcess,
  type PdfExtractionWorkerInput,
  type PdfExtractionWorkerResult,
} from "./document-extractor.js";

if (!parentPort) {
  throw new Error("PDF extraction worker requires a parent port");
}

const port = parentPort;

function toWorkerErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : fallback;
}

async function extract(input: PdfExtractionWorkerInput): Promise<void> {
  const imageExtractionErrors: string[] = [];
  try {
    const result = await extractPdfContentInProcess({
      ...input,
      buffer: Buffer.from(input.buffer),
      onImageExtractionError: (error) => {
        imageExtractionErrors.push(toWorkerErrorMessage(error, "PDF image extraction failed"));
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
      error: toWorkerErrorMessage(error, "PDF extraction worker failed"),
      imageExtractionErrors,
    } satisfies PdfExtractionWorkerResult);
  }
}

// The parent leases one job at a time to each worker. Keeping this module alive
// preserves ClawPDF's cached PDFium engine between connected requests.
port.on("message", (input: PdfExtractionWorkerInput) => {
  void extract(input);
});
