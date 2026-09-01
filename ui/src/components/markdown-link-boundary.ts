export function hasMarkdownLinkBoundaries(value: string, start: number, end: number): boolean {
  const before = value[start - 1];
  const after = value[end];
  return (
    (before === undefined || /\s/.test(before) || "([{<\"'`".includes(before)) &&
    (after === undefined || /\s/.test(after) || ".,;:!?)]}>\"'".includes(after))
  );
}
