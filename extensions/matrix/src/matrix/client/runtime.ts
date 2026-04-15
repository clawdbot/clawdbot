export function isBunRuntime(): boolean {
  const versions = process.versions as { bun?: string };
  return typeof versions.bun === "string";
}
