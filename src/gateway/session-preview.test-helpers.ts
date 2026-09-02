/**
 * Transcript preview fixtures shared by session preview tests.
 */
export function createToolSummaryPreviewTranscriptLines(sessionId: string): string[] {
  return [
    JSON.stringify({ type: "session", version: 1, id: sessionId }),
    JSON.stringify({ message: { role: "user", content: "Hello" } }),
    JSON.stringify({ message: { role: "assistant", content: "Hi" } }),
    JSON.stringify({
      message: { role: "assistant", content: [{ type: "toolcall", name: "weather" }] },
    }),
    JSON.stringify({ message: { role: "assistant", content: "Forecast ready" } }),
  ];
}
