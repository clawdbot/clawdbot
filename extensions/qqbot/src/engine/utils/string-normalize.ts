// Filename normalization specific to QQ Bot's upload API.

/**
 * Normalize filenames into a UTF-8 form that the QQ Bot API accepts reliably.
 *
 * Decodes percent-escaped names, converts Unicode to NFC, and strips
 * ASCII control characters.
 */
export function sanitizeFileName(name: string): string {
  if (!name) {
    return name;
  }
  let result = name.trim();
  if (result.includes("%")) {
    try {
      result = decodeURIComponent(result);
    } catch {
      // Keep the raw value if it is not valid percent-encoding.
    }
  }
  result = result.normalize("NFC");
  result = result.replace(/\p{Cc}/gu, "");
  return result;
}
