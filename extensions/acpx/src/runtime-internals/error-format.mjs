export function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message || error.name || "Error";
  }
  return String(error);
}
