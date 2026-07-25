import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const MCP_METADATA_TEXT_LIMIT = 1_200;

/** Scrubs untrusted MCP metadata before exposing it to a model. */
export function sanitizeMcpMetadataText(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const scrubbed = normalized
    .replace(
      /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/gi,
      "[redacted MCP metadata instruction]",
    )
    .replace(
      /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/gi,
      "[redacted MCP metadata instruction]",
    )
    .replace(/system\s+prompt/gi, "system prompt");
  return scrubbed.length > MCP_METADATA_TEXT_LIMIT
    ? `${truncateUtf16Safe(scrubbed, MCP_METADATA_TEXT_LIMIT)}...`
    : scrubbed;
}
