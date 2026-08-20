/** Returns whether a Gemini Flash model accepts the MINIMAL thinking level. */
export function googleFlashSupportsMinimalThinking(modelId: string): boolean {
  const match = modelId.toLowerCase().match(/(?:^|\/)gemini-3\.(\d+)-flash(?:-|$)/);
  if (!match) {
    return true;
  }
  // Live Gemini API contract on 2026-08-13: gemini-3.7-flash rejects thinkingLevel
  // MINIMAL with HTTP 400 INVALID_ARGUMENT; 3.6 and earlier flash models accept it.
  return Number.parseInt(match[1] ?? "0", 10) < 7;
}
