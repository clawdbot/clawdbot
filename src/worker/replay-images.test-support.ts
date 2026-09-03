import type { WorkerTranscriptMessage } from "../../packages/gateway-protocol/src/schema/worker-admission.js";

export function createWorkerImageHistory(userImage = false): WorkerTranscriptMessage[] {
  const messages: WorkerTranscriptMessage[] = [
    { role: "user", content: [{ type: "text", text: "Inspect this desktop." }], timestamp: 0 },
  ];
  for (let index = 0; index < 7; index++) {
    const toolName = index === 0 ? "computer" : "browser";
    const toolCallId = `image-${index}`;
    const content = [
      { type: "text" as const, text: `Observation ${index}` },
      {
        type: "image" as const,
        data: String.fromCharCode(65 + index).repeat(4 * 1024 * 1024),
        mimeType: "image/png",
      },
    ];
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
      api: "openai-responses",
      provider: "test",
      model: "test-model",
      stopReason: "toolUse",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: index * 2 + 1,
    });
    messages.push({
      role: "toolResult",
      toolCallId,
      toolName,
      content: userImage && index === 1 ? [{ type: "text", text: "Image follows." }] : content,
      isError: false,
      timestamp: index * 2 + 2,
    });
    if (userImage && index === 1) {
      messages.push({ role: "user", content, timestamp: index * 2 + 2 });
    }
  }
  return messages;
}
