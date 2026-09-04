/**
 * @typedef {{ text: string, truncatedChars: number }} BoundedTail
 */

/**
 * @param {BoundedTail} state
 * @param {unknown} chunk
 * @param {number} maxChars
 * @returns {BoundedTail}
 */
export function appendBoundedTail(state, chunk, maxChars) {
  const nextText = state.text + String(chunk);
  const droppedChars = Math.max(0, nextText.length - maxChars);
  return {
    text: droppedChars > 0 ? nextText.slice(droppedChars) : nextText,
    truncatedChars: state.truncatedChars + droppedChars,
  };
}
