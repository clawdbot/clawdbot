import OpenAI from "openai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startQaMockOpenAiServer } from "./server.js";

beforeEach(() => vi.stubEnv("OPENAI_CUSTOM_HEADERS", undefined));
afterEach(() => vi.unstubAllEnvs());

it.each([
  {
    name: "plain answer",
    prompt: "Reply exactly: QA-SDK-STREAM",
    text: "QA-SDK-STREAM",
    status: "completed",
    preview: "",
  },
  {
    name: "preview followed by different final text",
    prompt: "Final-only marker streaming QA check. Reply exactly: QA-SDK-FINAL",
    text: "QA-SDK-FINAL",
    status: "completed",
    preview: "QA streaming preview in progress",
  },
  {
    name: "reasoning followed by an answer",
    prompt: "QA thinking visibility check max: answer exactly THINKING-MAX-OK.",
    text: "THINKING-MAX-OK",
    status: "completed",
    preview: "THINKING-MAX-OK",
  },
  {
    name: "partial answer followed by failure",
    prompt: "Telegram visible partial failure QA check",
    text: "TELEGRAM-VISIBLE-PARTIAL-BEFORE-FAILURE",
    status: "failed",
    preview: "TELEGRAM-VISIBLE-PARTIAL-BEFORE-FAILURE",
  },
])("accumulates $name through the SDK stream", async ({ prompt, text, status, preview }) => {
  const server = await startQaMockOpenAiServer({ finalOnlyMarkerPauseMs: 1 });
  try {
    const client = new OpenAI({
      baseURL: `${server.baseUrl}/v1`,
      apiKey: "qa-synthetic-key",
      adminAPIKey: null,
      organization: null,
      project: null,
      maxRetries: 0,
    });
    const stream = client.responses.stream({ model: "qa-model", input: prompt });
    let streamedText = "";
    const finishedTexts: string[] = [];
    stream.on("response.output_text.delta", ({ delta }) => (streamedText += delta));
    stream.on("response.output_text.done", (event) => finishedTexts.push(event.text));
    const response = await stream.finalResponse();
    expect(response.status).toBe(status);
    expect(response.output_text).toBe(text);
    expect(streamedText).toBe(preview);
    expect(finishedTexts).toEqual(status === "completed" ? [text] : []);
  } finally {
    await server.stop();
  }
});
