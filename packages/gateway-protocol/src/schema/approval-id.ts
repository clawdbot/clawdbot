// Gateway protocol approval IDs stay exact and safe for encoded deep-link path segments.
export const APPROVAL_ID_WELL_FORMED_UNICODE_PATTERN =
  "^(?!\\.{1,2}$)(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$";

/** Whether an approval id is non-empty, path-stable, and contains no unpaired UTF-16 surrogate. */
export function isWellFormedApprovalId(value: string): boolean {
  if (value.length === 0 || value === "." || value === "..") {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return false;
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
