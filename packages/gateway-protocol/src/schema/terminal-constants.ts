/** Maximum size of one file staged through the operator terminal. */
export const MAX_TERMINAL_UPLOAD_BYTES = 16 * 1024 * 1024;

/** Base64 expansion of MAX_TERMINAL_UPLOAD_BYTES. */
export const MAX_TERMINAL_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_TERMINAL_UPLOAD_BYTES / 3) * 4;

/** Browser-provided file name bound before filesystem sanitization. */
export const MAX_TERMINAL_UPLOAD_NAME_LENGTH = 255;

function base64Value(code: number): number {
  if (code >= 65 && code <= 90) {
    return code - 65;
  }
  if (code >= 97 && code <= 122) {
    return code - 71;
  }
  if (code >= 48 && code <= 57) {
    return code + 4;
  }
  return code === 43 ? 62 : code === 47 ? 63 : -1;
}

export function terminalUploadDecodedSize(contentBase64: string): number {
  if (contentBase64.length === 0) {
    return 0;
  }
  const padding = contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0;
  return Math.floor(contentBase64.length / 4) * 3 - padding;
}

/** Validates canonical padded base64, including zero-valued unused bits. */
export function isCanonicalTerminalUploadBase64(contentBase64: string): boolean {
  if (
    contentBase64.length > MAX_TERMINAL_UPLOAD_BASE64_LENGTH ||
    contentBase64.length % 4 !== 0 ||
    terminalUploadDecodedSize(contentBase64) > MAX_TERMINAL_UPLOAD_BYTES
  ) {
    return false;
  }
  const padding = contentBase64.endsWith("==") ? 2 : contentBase64.endsWith("=") ? 1 : 0;
  const dataEnd = contentBase64.length - padding;
  for (let index = 0; index < dataEnd; index += 1) {
    if (base64Value(contentBase64.charCodeAt(index)) < 0) {
      return false;
    }
  }
  for (let index = dataEnd; index < contentBase64.length; index += 1) {
    if (contentBase64.charCodeAt(index) !== 61) {
      return false;
    }
  }
  if (padding > 0) {
    const finalValue = base64Value(contentBase64.charCodeAt(dataEnd - 1));
    const unusedBitsMask = padding === 2 ? 0b1111 : 0b11;
    if (finalValue < 0 || (finalValue & unusedBitsMask) !== 0) {
      return false;
    }
  }
  return true;
}
