import { beforeEach, describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import * as ttsRuntime from "../../tts/tts.js";
import { createTtsTool } from "./tts-tool.js";

let textToSpeechSpy: ReturnType<typeof vi.spyOn>;

describe("createTtsTool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    textToSpeechSpy = vi.spyOn(ttsRuntime, "textToSpeech");
  });

  it("uses SILENT_REPLY_TOKEN in guidance text", () => {
    const tool = createTtsTool();

    expect(tool.description).toContain(SILENT_REPLY_TOKEN);
  });

  it("stores audio delivery in details.media", async () => {
    textToSpeechSpy.mockResolvedValue({
      success: true,
      audioPath: "/tmp/reply.opus",
      provider: "test",
      voiceCompatible: true,
    });

    const tool = createTtsTool();
    const result = await tool.execute("call-1", { text: "hello" });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "Generated audio reply." }],
      details: {
        audioPath: "/tmp/reply.opus",
        provider: "test",
        media: {
          mediaUrl: "/tmp/reply.opus",
          trustedLocalMedia: true,
          audioAsVoice: true,
        },
      },
    });
    expect(JSON.stringify(result.content)).not.toContain("MEDIA:");
  });

  it("throws when synthesis fails so the agent records a tool error", async () => {
    textToSpeechSpy.mockResolvedValue({
      success: false,
      error: "TTS conversion failed: openai: not configured",
    });

    const tool = createTtsTool();

    await expect(tool.execute("call-1", { text: "hello" })).rejects.toThrow(
      "TTS conversion failed: openai: not configured",
    );
  });
});
