import { beforeEach, describe, expect, it, vi } from "vitest";
import { processAttachments, type AudioConvertPort } from "./inbound-attachments.js";

const downloadFileMock = vi.hoisted(() => vi.fn());
const resolveSTTConfigMock = vi.hoisted(() => vi.fn());
const transcribeAudioMock = vi.hoisted(() => vi.fn());

vi.mock("../utils/file-utils.js", () => ({
  downloadFile: downloadFileMock,
}));

vi.mock("../utils/platform.js", () => ({
  getQQBotMediaDir: () => "/tmp/openclaw-qqbot-downloads",
}));

vi.mock("../utils/stt.js", () => ({
  resolveSTTConfig: resolveSTTConfigMock,
  transcribeAudio: transcribeAudioMock,
}));

function createAudioConvert(overrides: Partial<AudioConvertPort> = {}): AudioConvertPort {
  return {
    convertSilkToWav: vi.fn(async () => null),
    formatDuration: (seconds: number) => `${seconds}s`,
    isVoiceAttachment: (att: { content_type: string; filename?: string }) =>
      att.content_type === "voice" || att.content_type.startsWith("audio/"),
    ...overrides,
  };
}

describe("engine/gateway/inbound-attachments", () => {
  let audioConvert: AudioConvertPort;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveSTTConfigMock.mockReturnValue(null);
    transcribeAudioMock.mockResolvedValue(null);
    audioConvert = createAudioConvert();
  });

  it("returns an empty result when no attachments are present", async () => {
    await expect(
      processAttachments(undefined, { accountId: "qq", cfg: {}, audioConvert }),
    ).resolves.toStrictEqual({
      attachmentInfo: "",
      imageUrls: [],
      imageMediaTypes: [],
      voiceAttachmentPaths: [],
      voiceAttachmentUrls: [],
      voiceAsrReferTexts: [],
      voiceTranscripts: [],
      voiceTranscriptSources: [],
      attachmentLocalPaths: [],
    });
  });

  it("uses remote image URL when image download fails", async () => {
    downloadFileMock.mockResolvedValue(null);

    const result = await processAttachments(
      [{ content_type: "image/png", url: "//cdn.example.test/a.png", filename: "a.png" }],
      { accountId: "qq", cfg: {}, audioConvert },
    );

    expect(downloadFileMock).toHaveBeenCalledWith(
      "https://cdn.example.test/a.png",
      "/tmp/openclaw-qqbot-downloads",
      "a.png",
    );
    expect(result.imageUrls).toEqual(["https://cdn.example.test/a.png"]);
    expect(result.imageMediaTypes).toEqual(["image/png"]);
    expect(result.attachmentLocalPaths).toEqual([null]);
  });

  it("prefers voice_wav_url for voice downloads and transcribes with configured STT", async () => {
    downloadFileMock.mockResolvedValue("/tmp/openclaw-qqbot-downloads/voice.wav");
    resolveSTTConfigMock.mockReturnValue({
      baseUrl: "https://stt.example.test",
      apiKey: "key",
      model: "whisper-1",
    });
    transcribeAudioMock.mockResolvedValue("transcribed voice");

    const result = await processAttachments(
      [
        {
          content_type: "voice",
          url: "https://cdn.example.test/voice.silk",
          filename: "voice.silk",
          voice_wav_url: "//cdn.example.test/voice.wav",
          asr_refer_text: "platform text",
        },
      ],
      { accountId: "qq", cfg: { channels: { qqbot: { stt: {} } } }, audioConvert },
    );

    expect(downloadFileMock).toHaveBeenCalledWith(
      "https://cdn.example.test/voice.wav",
      "/tmp/openclaw-qqbot-downloads",
    );
    expect(transcribeAudioMock).toHaveBeenCalledWith("/tmp/openclaw-qqbot-downloads/voice.wav", {
      channels: { qqbot: { stt: {} } },
    });
    expect(result.voiceAttachmentPaths).toEqual(["/tmp/openclaw-qqbot-downloads/voice.wav"]);
    expect(result.voiceAttachmentUrls).toEqual(["https://cdn.example.test/voice.wav"]);
    expect(result.voiceAsrReferTexts).toEqual(["platform text"]);
    expect(result.voiceTranscripts).toEqual(["transcribed voice"]);
    expect(result.voiceTranscriptSources).toEqual(["stt"]);
  });

  it("falls back to platform ASR text when voice download fails", async () => {
    downloadFileMock.mockResolvedValue(null);

    const result = await processAttachments(
      [
        {
          content_type: "voice",
          url: "https://cdn.example.test/voice.silk",
          filename: "voice.silk",
          asr_refer_text: "platform text",
        },
      ],
      { accountId: "qq", cfg: {}, audioConvert },
    );

    expect(result.voiceAttachmentUrls).toEqual(["https://cdn.example.test/voice.silk"]);
    expect(result.voiceTranscripts).toEqual(["platform text"]);
    expect(result.voiceTranscriptSources).toEqual(["asr"]);
    expect(result.attachmentLocalPaths).toEqual([null]);
  });
});
