/**
 * Escape text so it can be embedded literally inside a RegExp constructor pattern.
 * @param {string} value
 * @returns {string}
 */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
