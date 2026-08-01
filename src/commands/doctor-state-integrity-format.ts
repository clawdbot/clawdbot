import path from "node:path";

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function formatFilePreview(paths: string[], limit = 3): string {
  const names = paths.slice(0, limit).map((filePath) => path.basename(filePath));
  const remaining = paths.length - names.length;
  return remaining > 0 ? `${names.join(", ")}, and ${remaining} more` : names.join(", ");
}
