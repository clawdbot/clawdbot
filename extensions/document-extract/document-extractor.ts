import type { PdfDocument, PdfEngine, PdfImage } from "clawpdf";
import type {
  DocumentExtractedImage,
  DocumentExtractionRequest,
  DocumentExtractionResult,
  DocumentExtractorPlugin,
} from "openclaw/plugin-sdk/document-extractor";

const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const MAX_RENDER_DIMENSION = 10_000;

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

async function extractPdfContent(
  request: DocumentExtractionRequest,
): Promise<DocumentExtractionResult> {
  const engine = await loadPdfEngine();
  const pdf = await openPdfDocument({
    engine,
    input: new Uint8Array(request.buffer),
    ...(request.password ? { password: request.password } : {}),
  });
  try {
    const pages = request.pageNumbers
      ? request.pageNumbers
          .filter((p) => Number.isInteger(p) && p >= 1 && p <= pdf.pageCount)
          .slice(0, request.maxPages)
      : undefined;
    const pageSelection = pages ? { pages } : { maxPages: request.maxPages };

    const textResult = await pdf.extract({
      mode: "text",
      ...pageSelection,
      maxTextChars: MAX_EXTRACTED_TEXT_CHARS,
    });
    const text = textResult.text;

    if (text.trim().length >= request.minTextChars) {
      return { text, images: [] };
    }

    try {
      const imageResult = await pdf.extract({
        mode: "images",
        ...pageSelection,
        image: {
          maxDimension: MAX_RENDER_DIMENSION,
          maxPixels: request.maxPixels,
          forms: true,
        },
      });
      return { text, images: imageResult.images.map(toDocumentImage) };
    } catch (err) {
      request.onImageExtractionError?.(err);
      return { text, images: [] };
    }
  } finally {
    pdf.destroy();
  }
}

export function createPdfDocumentExtractor(): DocumentExtractorPlugin {
  return {
    id: "pdf",
    label: "PDF",
    mimeTypes: ["application/pdf"],
    autoDetectOrder: 10,
    extract: extractPdfContent,
  };
}
