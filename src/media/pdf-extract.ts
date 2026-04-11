type CanvasModule = typeof import("@napi-rs/canvas");
type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let canvasModulePromise: Promise<CanvasModule> | null = null;
let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

async function loadCanvasModule(): Promise<CanvasModule> {
  if (!canvasModulePromise) {
    canvasModulePromise = import("@napi-rs/canvas").catch((err) => {
      canvasModulePromise = null;
      throw new Error(
        `Optional dependency @napi-rs/canvas is required for PDF image extraction: ${String(err)}`,
      );
    });
  }
  return canvasModulePromise;
}

async function loadPdfJsModule(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((err) => {
      pdfJsModulePromise = null;
      throw new Error(
        `Optional dependency pdfjs-dist is required for PDF extraction: ${String(err)}`,
      );
    });
  }
  return pdfJsModulePromise;
}

export type PdfExtractedImage = {
  type: "image";
  data: string;
  mimeType: string;
};

export type PdfExtractedContent = {
  text: string;
  images: PdfExtractedImage[];
};

export async function extractPdfContent(params: {
  buffer: Buffer;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  pageNumbers?: number[];
  onImageExtractionError?: (error: unknown) => void;
}): Promise<PdfExtractedContent> {
  const { buffer, maxPages, maxPixels, minTextChars, pageNumbers, onImageExtractionError } = params;
  const { getDocument } = await loadPdfJsModule();
  const pdf = await getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;

  const effectivePages: number[] = pageNumbers
    ? pageNumbers.filter((p) => p >= 1 && p <= pdf.numPages).slice(0, maxPages)
    : Array.from({ length: Math.min(pdf.numPages, maxPages) }, (_, i) => i + 1);

  const textParts: string[] = [];
  for (const pageNum of effectivePages) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join(" ");
    if (pageText) {
      textParts.push(pageText);
    }
  }

  const text = textParts.join("\n\n");
  if (text.trim().length >= minTextChars) {
    return { text, images: [] };
  }

  let canvasModule: CanvasModule;
  try {
    canvasModule = await loadCanvasModule();
  } catch (err) {
    onImageExtractionError?.(err);
    return { text, images: [] };
  }

  const { createCanvas } = canvasModule;
  const images: PdfExtractedImage[] = [];
  const pixelBudget = Math.max(1, maxPixels);

  for (const pageNum of effectivePages) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const pagePixels = viewport.width * viewport.height;
    const scale = Math.min(1, Math.sqrt(pixelBudget / Math.max(1, pagePixels)));
    const scaled = page.getViewport({ scale: Math.max(0.1, scale) });
    const canvas = createCanvas(Math.ceil(scaled.width), Math.ceil(scaled.height));
    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport: scaled,
    }).promise;
    const png = canvas.toBuffer("image/png");
    images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  }

  return { text, images };
}
