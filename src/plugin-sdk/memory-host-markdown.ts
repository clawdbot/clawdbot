export function withTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

export function replaceManagedMarkdownBlock(params: {
  original: string;
  heading: string;
  startMarker: string;
  endMarker: string;
  body: string;
}): string {
  const normalizedOriginal = params.original ?? "";
  const managedBlock = [
    params.heading,
    params.startMarker,
    params.body.trim(),
    params.endMarker,
  ].join("\n");

  const startIndex = normalizedOriginal.indexOf(params.startMarker);
  const endIndex = normalizedOriginal.indexOf(params.endMarker);
  if (startIndex >= 0 && endIndex > startIndex) {
    const headingStart = normalizedOriginal.lastIndexOf(params.heading, startIndex);
    const replaceStart = headingStart >= 0 ? headingStart : startIndex;
    const replaceEnd = endIndex + params.endMarker.length;
    const before = normalizedOriginal.slice(0, replaceStart).trimEnd();
    const after = normalizedOriginal.slice(replaceEnd).trimStart();
    return [before, managedBlock, after].filter(Boolean).join("\n\n");
  }

  const trimmed = normalizedOriginal.trimEnd();
  return trimmed ? `${trimmed}\n\n${managedBlock}` : managedBlock;
}
