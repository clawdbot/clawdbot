/** Promise-based sleep that preserves the native global timer contract. */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
