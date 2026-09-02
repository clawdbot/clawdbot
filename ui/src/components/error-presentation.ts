export function formatWebUiIconErrorText(text: string): string {
  return text.replace(/^⚠️\s*/u, "").trim();
}
