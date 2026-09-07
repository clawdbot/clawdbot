import type { DocumentExtractionMetadata } from "../plugins/document-extractor-types.js";

export function renderDocumentTruncationNotice(
  metadata?: DocumentExtractionMetadata,
  explicitSelectionLimit?: number,
): string | undefined {
  const reasons: string[] = [];
  if (explicitSelectionLimit !== undefined) {
    reasons.push(`requested page selection limited to ${explicitSelectionLimit} pages`);
  }
  if (metadata?.pages?.truncated) {
    reasons.push(
      metadata.pages.selection === "automatic"
        ? `${metadata.pages.processed.length} of ${metadata.pages.total} pages processed`
        : `some requested pages omitted; ${metadata.pages.processed.length} pages processed`,
    );
  }
  if (metadata?.textTruncated) {
    reasons.push("text truncated");
  }
  if (metadata?.imagesTruncated) {
    reasons.push("image rendering truncated");
  }
  return reasons.length > 0 ? `[Partial document: ${reasons.join("; ")}.]` : undefined;
}
