import type { PdfDocument, PdfEngine, PdfImage } from "clawpdf";
// Document Extract plugin module implements document extractor behavior.
import JSZip from "jszip";
import type {
  DocumentExtractedImage,
  DocumentExtractionRequest,
  DocumentExtractionResult,
  DocumentExtractorPlugin,
} from "openclaw/plugin-sdk/document-extractor";

const MAX_EXTRACTED_TEXT_CHARS = 200_000;
const MAX_RENDER_DIMENSION = 10_000;
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const DOCX_TEXT_PARTS = [
  "word/document.xml",
  "word/footnotes.xml",
  "word/endnotes.xml",
  "word/comments.xml",
] as const;

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

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:#(x[0-9a-fA-F]+|\d+)|amp|lt|gt|quot|apos);/gu, (entity, numeric) => {
    if (numeric) {
      const codePoint =
        numeric.startsWith("x") || numeric.startsWith("X")
          ? Number.parseInt(numeric.slice(1), 16)
          : Number.parseInt(numeric, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    switch (entity) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default:
        return entity;
    }
  });
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function clampExtractedText(text: string): string {
  return text.length > MAX_EXTRACTED_TEXT_CHARS ? text.slice(0, MAX_EXTRACTED_TEXT_CHARS) : text;
}

function extractParagraphText(xml: string): string[] {
  const paragraphs: string[] = [];
  const paragraphMatches = xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gu);
  for (const match of paragraphMatches) {
    const paragraphXml = match[1] ?? "";
    const chunks: string[] = [];
    const tokenMatches = paragraphXml.matchAll(
      /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(?:tab|br|cr)\b[^>]*\/?\s*>/gu,
    );
    for (const token of tokenMatches) {
      const full = token[0];
      if (/^<w:t(?:\s|>)/u.test(full)) {
        chunks.push(decodeXmlEntities(token[1] ?? ""));
      } else if (full.startsWith("<w:tab")) {
        chunks.push("\t");
      } else {
        chunks.push("\n");
      }
    }
    const paragraph = chunks.join("").trimEnd();
    if (paragraph.trim()) {
      paragraphs.push(paragraph);
    }
  }
  return paragraphs;
}

function extractDocxTableText(xml: string): string[] {
  const tables: string[] = [];
  for (const tableMatch of xml.matchAll(/<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/gu)) {
    const rows: string[] = [];
    for (const rowMatch of (tableMatch[1] ?? "").matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gu)) {
      const cells = Array.from(
        (rowMatch[1] ?? "").matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gu),
        (cell) =>
          extractParagraphText(cell[1] ?? "")
            .join(" ")
            .trim(),
      );
      if (cells.some((cell) => cell.length > 0)) {
        rows.push(cells.join("\t"));
      }
    }
    if (rows.length > 0) {
      tables.push(["Table", ...rows].join("\n"));
    }
  }
  return tables;
}

function extractDocxPartText(xml: string): string[] {
  const tables = extractDocxTableText(xml);
  const withoutTables = xml.replace(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/gu, "");
  return [...extractParagraphText(withoutTables), ...tables];
}

async function readZipTextFile(zip: JSZip, name: string): Promise<string | undefined> {
  const file = zip.file(name);
  return file ? await file.async("string") : undefined;
}

async function loadOfficeZip(request: DocumentExtractionRequest, label: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(request.buffer);
  } catch (err) {
    throw new Error(
      `${label} extraction failed: file is corrupt, encrypted, or not a supported Office OOXML package.`,
      { cause: err },
    );
  }
}

function numericPathSort(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name, undefined, { numeric: true });
}

function columnIndexFromCellRef(ref: string | undefined, fallback: number): number {
  const letters = ref?.match(/^[A-Z]+/iu)?.[0]?.toUpperCase();
  if (!letters) {
    return fallback;
  }
  let index = 0;
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return Math.max(0, index - 1);
}

function firstXmlAttr(value: string, attr: string): string | undefined {
  const escaped = attr.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return value.match(new RegExp(`${escaped}=(["'])(.*?)\\1`, "u"))?.[2];
}

function stripXmlTags(value: string): string {
  return value.replace(/<[^>]+>/gu, "");
}

function extractPlainXmlText(xml: string): string {
  return normalizeExtractedText(decodeXmlEntities(stripXmlTags(xml)));
}

async function loadSharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await readZipTextFile(zip, "xl/sharedStrings.xml");
  if (!xml) {
    return [];
  }
  return Array.from(
    xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu),
    (match) =>
      extractParagraphText(match[1] ?? "").join("\n") || extractPlainXmlText(match[1] ?? ""),
  );
}

function extractWorkbookSheetNames(xml: string | undefined): Map<string, string> {
  const names = new Map<string, string>();
  if (!xml) {
    return names;
  }
  for (const match of xml.matchAll(/<sheet\b[^>]*>/gu)) {
    const tag = match[0];
    const id = firstXmlAttr(tag, "r:id");
    const name = firstXmlAttr(tag, "name");
    if (id && name) {
      names.set(id, decodeXmlEntities(name));
    }
  }
  return names;
}

function extractWorkbookRels(xml: string | undefined): Map<string, string> {
  const rels = new Map<string, string>();
  if (!xml) {
    return rels;
  }
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/gu)) {
    const tag = match[0];
    const id = firstXmlAttr(tag, "Id");
    const target = firstXmlAttr(tag, "Target");
    if (id && target) {
      rels.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
    }
  }
  return rels;
}

function extractXlsxCellText(cellXml: string, sharedStrings: readonly string[]): string {
  const type = firstXmlAttr(cellXml.match(/<c\b[^>]*>/u)?.[0] ?? "", "t");
  const inline = cellXml.match(/<is\b[^>]*>([\s\S]*?)<\/is>/u)?.[1];
  if (inline) {
    return extractPlainXmlText(inline);
  }
  const value = decodeXmlEntities(cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/u)?.[1] ?? "");
  if (type === "s") {
    const index = Number.parseInt(value, 10);
    return Number.isFinite(index) ? (sharedStrings[index] ?? "") : "";
  }
  if (type === "str") {
    return value;
  }
  if (type === "b") {
    return value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
  }
  return value;
}

async function extractXlsxContent(
  request: DocumentExtractionRequest,
): Promise<DocumentExtractionResult> {
  const zip = await loadOfficeZip(request, "XLSX");
  const sharedStrings = await loadSharedStrings(zip);
  const sheetNames = extractWorkbookSheetNames(await readZipTextFile(zip, "xl/workbook.xml"));
  const workbookRels = extractWorkbookRels(
    await readZipTextFile(zip, "xl/_rels/workbook.xml.rels"),
  );
  const sheetFiles = zip.file(/^xl\/worksheets\/sheet\d+\.xml$/u).sort(numericPathSort);
  const namesByPath = new Map<string, string>();
  for (const [id, name] of sheetNames) {
    const target = workbookRels.get(id);
    if (target) {
      namesByPath.set(target, name);
    }
  }

  const sheets: string[] = [];
  for (const [sheetIndex, sheetFile] of sheetFiles.entries()) {
    const xml = await sheetFile.async("string");
    const rows: string[] = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)) {
      const cells: string[] = [];
      let fallbackColumn = 0;
      for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b[^>]*>[\s\S]*?<\/c>/gu)) {
        const cellXml = cellMatch[0];
        const column = columnIndexFromCellRef(
          firstXmlAttr(cellXml.match(/<c\b[^>]*>/u)?.[0] ?? "", "r"),
          fallbackColumn,
        );
        while (cells.length < column) {
          cells.push("");
        }
        cells[column] = extractXlsxCellText(cellXml, sharedStrings);
        fallbackColumn = column + 1;
      }
      const trimmed = cells.map((cell) => cell ?? "");
      while (trimmed.length > 0 && !trimmed.at(-1)) {
        trimmed.pop();
      }
      if (trimmed.some((cell) => cell.trim())) {
        rows.push(
          `${firstXmlAttr(rowMatch[0], "r") ?? String(rows.length + 1)}\t${trimmed.join("\t")}`,
        );
      }
    }
    if (rows.length > 0) {
      const fallback = `Sheet ${sheetIndex + 1}`;
      sheets.push(
        [
          decodeXmlEntities(namesByPath.get(sheetFile.name) ?? fallback),
          "row\tvalues",
          ...rows,
        ].join("\n"),
      );
    }
  }

  return {
    text: clampExtractedText(normalizeExtractedText(sheets.join("\n\n"))),
    images: [],
  };
}

function extractDrawingText(xml: string): string[] {
  return Array.from(xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/gu), (match) => {
    const chunks = Array.from((match[1] ?? "").matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gu), (t) =>
      decodeXmlEntities(t[1] ?? ""),
    );
    return chunks.join("").trim();
  }).filter(Boolean);
}

async function extractPptxContent(
  request: DocumentExtractionRequest,
): Promise<DocumentExtractionResult> {
  const zip = await loadOfficeZip(request, "PPTX");
  const parts = [
    ...zip.file(/^ppt\/slides\/slide\d+\.xml$/u).sort(numericPathSort),
    ...zip.file(/^ppt\/notesSlides\/notesSlide\d+\.xml$/u).sort(numericPathSort),
  ];
  const sections: string[] = [];
  for (const file of parts) {
    const text = extractDrawingText(await file.async("string"));
    if (text.length > 0) {
      const isNotes = file.name.includes("/notesSlides/");
      const number = file.name.match(/(?:slide|notesSlide)(\d+)\.xml$/u)?.[1] ?? "?";
      const kind = isNotes ? "Notes" : "Slide";
      sections.push([`${kind} ${number} (${file.name})`, ...text].join("\n"));
    }
  }
  return {
    text: clampExtractedText(normalizeExtractedText(sections.join("\n\n"))),
    images: [],
  };
}

async function extractDocxContent(
  request: DocumentExtractionRequest,
): Promise<DocumentExtractionResult> {
  const zip = await loadOfficeZip(request, "DOCX");
  const paragraphs: string[] = [];
  for (const part of DOCX_TEXT_PARTS) {
    const xml = await readZipTextFile(zip, part);
    if (xml) {
      paragraphs.push(...extractDocxPartText(xml));
    }
  }

  const headerFooterFiles = zip
    .file(/^word\/(?:header|footer)\d+\.xml$/u)
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const file of headerFooterFiles) {
    const xml = await file.async("string");
    paragraphs.push(...extractDocxPartText(xml));
  }

  return {
    text: clampExtractedText(normalizeExtractedText(paragraphs.join("\n"))),
    images: [],
  };
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
    if (request.pageNumbers?.length && pages?.length === 0) {
      throw new Error(`No requested PDF pages exist in this ${pdf.pageCount}-page document.`);
    }
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
        for (const image of imageResult.images) {
          images.push(toDocumentImage(image));
          remainingPixels -= image.width * image.height;
        }
      }
      return { text, images };
    } catch (err) {
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

export function createPdfDocumentExtractor(): DocumentExtractorPlugin {
  return {
    id: "pdf",
    label: "PDF",
    mimeTypes: ["application/pdf"],
    autoDetectOrder: 10,
    extract: extractPdfContent,
  };
}

export function createDocxDocumentExtractor(): DocumentExtractorPlugin {
  return {
    id: "docx",
    label: "DOCX",
    mimeTypes: [DOCX_MIME_TYPE],
    autoDetectOrder: 20,
    extract: extractDocxContent,
  };
}

export function createXlsxDocumentExtractor(): DocumentExtractorPlugin {
  return {
    id: "xlsx",
    label: "XLSX",
    mimeTypes: [XLSX_MIME_TYPE],
    autoDetectOrder: 30,
    extract: extractXlsxContent,
  };
}

export function createPptxDocumentExtractor(): DocumentExtractorPlugin {
  return {
    id: "pptx",
    label: "PPTX",
    mimeTypes: [PPTX_MIME_TYPE],
    autoDetectOrder: 40,
    extract: extractPptxContent,
  };
}
