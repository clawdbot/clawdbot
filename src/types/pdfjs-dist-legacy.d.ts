declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  import type {
    DocumentInitParameters,
    PDFDocumentLoadingTask,
    TypedArray,
  } from "pdfjs-dist/types/src/display/api.js";

  export type LegacyDocumentInitParameters = DocumentInitParameters & {
    disableWorker?: boolean;
  };

  export function getDocument(
    src?: string | URL | TypedArray | ArrayBuffer | LegacyDocumentInitParameters,
  ): PDFDocumentLoadingTask;

  export type {
    DocumentInitParameters,
    PDFDocumentLoadingTask,
    PDFDocumentProxy,
    PDFPageProxy,
    TextContent,
    TextItem,
    TypedArray,
  } from "pdfjs-dist/types/src/display/api.js";
  export type { PageViewport } from "pdfjs-dist/types/src/display/display_utils.js";
}
