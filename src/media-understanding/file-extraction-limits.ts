// Resolves inbound attachment text-extraction limits for media-understanding.
import type { OpenClawConfig } from "../config/types.js";
import {
  type InputFileLimits,
  type InputFileLimitsConfig,
  resolveInputFileLimits,
} from "../media/input-files.js";

// Inbound channel/UI attachments are managed media already accepted under the
// agent's media size cap (chat.send's mediaMaxMb / DEFAULT_CHAT_ATTACHMENT_MAX_MB).
// Size inbound file extraction to that cap and the agent's PDF page budget rather
// than the smaller OpenResponses input_file defaults (5 MB / 4 pages); otherwise
// large managed PDFs reach text-only/locked-down agents as a bare attachment
// marker instead of bounded document text. An explicit `responses.files` operator
// config still wins per-field, and the byte/page ceilings bound host-side cost.
const INBOUND_FILE_EXTRACTION_DEFAULT_MAX_MB = 20;
const INBOUND_FILE_EXTRACTION_MAX_BYTES_CAP = 25 * 1024 * 1024;
const INBOUND_FILE_EXTRACTION_DEFAULT_MAX_PAGES = 20;
const INBOUND_FILE_EXTRACTION_MAX_PAGES_CAP = 150;

type InboundFileExtractionDefaults = {
  mediaMaxMb?: number;
  pdfMaxPages?: number;
};

/** Resolved inbound file limits plus whether the operator pinned an explicit MIME allowlist. */
export type FileExtractionLimits = InputFileLimits & {
  allowedMimesConfigured: boolean;
};

function positiveExtractionLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveInboundFileExtractionMaxBytes(
  defaults: InboundFileExtractionDefaults | undefined,
): number {
  const maxMb =
    positiveExtractionLimit(defaults?.mediaMaxMb) ?? INBOUND_FILE_EXTRACTION_DEFAULT_MAX_MB;
  return Math.min(Math.floor(maxMb * 1024 * 1024), INBOUND_FILE_EXTRACTION_MAX_BYTES_CAP);
}

function resolveInboundFileExtractionMaxPages(
  defaults: InboundFileExtractionDefaults | undefined,
): number {
  const pages =
    positiveExtractionLimit(defaults?.pdfMaxPages) ?? INBOUND_FILE_EXTRACTION_DEFAULT_MAX_PAGES;
  return Math.min(Math.trunc(pages), INBOUND_FILE_EXTRACTION_MAX_PAGES_CAP);
}

/** Builds inbound attachment extraction limits, sized to the agent's media/PDF config. */
export function resolveFileExtractionLimits(cfg: OpenClawConfig): FileExtractionLimits {
  const files = cfg.gateway?.http?.endpoints?.responses?.files;
  const allowedMimesConfigured = Boolean(files?.allowedMimes?.length);
  const defaults = cfg.agents?.defaults;
  const inboundFiles: InputFileLimitsConfig = {
    ...files,
    maxBytes: files?.maxBytes ?? resolveInboundFileExtractionMaxBytes(defaults),
    pdf: {
      ...files?.pdf,
      maxPages: files?.pdf?.maxPages ?? resolveInboundFileExtractionMaxPages(defaults),
    },
  };
  return {
    ...resolveInputFileLimits(inboundFiles),
    allowedMimesConfigured,
  };
}
