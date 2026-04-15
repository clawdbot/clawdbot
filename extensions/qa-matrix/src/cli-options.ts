export function collectString(value: string, previous: string[]) {
  const trimmed = value.trim();
  return trimmed ? [...previous, trimmed] : previous;
}
