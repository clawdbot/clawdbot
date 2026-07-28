/** Escape text so it can be embedded literally inside a RegExp constructor pattern. */
export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
