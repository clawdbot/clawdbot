// Control UI chat module implements stream text behavior.
export function trimAccumulatedStreamPrefix(text: string, previousText: string | null): string {
  if (!previousText || !text.startsWith(previousText)) {
    return text;
  }
  return text.slice(previousText.length).trimStart();
}
