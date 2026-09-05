export function createTimeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.code = "ETIMEDOUT";
  return error;
}
