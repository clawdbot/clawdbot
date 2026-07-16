export function truncateSlackText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  if (max <= 1) {
    return trimmed.slice(0, max);
  }
  return `${trimmed.slice(0, max - 1)}…`;
}
