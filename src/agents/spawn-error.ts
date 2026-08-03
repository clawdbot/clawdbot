export function summarizeSpawnError(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "error";
}
