import { extensionForMime } from "openclaw/plugin-sdk/media-mime";

const WHATSAPP_DEFAULT_DOCUMENT_FILE_NAME = "file";

export function resolveWhatsAppDefaultDocumentFileName(mimetype?: string): string {
  const extension = extensionForMime(mimetype);
  return extension
    ? `${WHATSAPP_DEFAULT_DOCUMENT_FILE_NAME}${extension}`
    : WHATSAPP_DEFAULT_DOCUMENT_FILE_NAME;
}

export function resolveWhatsAppDocumentFileName(params: {
  fileName?: string;
  mimetype?: string;
}): string {
  const fallbackName = resolveWhatsAppDefaultDocumentFileName(params.mimetype);
  // eslint-disable-next-line no-control-regex
  const stripped = params.fileName?.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return stripped || fallbackName;
}
