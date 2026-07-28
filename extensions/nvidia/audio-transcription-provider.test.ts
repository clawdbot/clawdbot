import { afterEach, describe, expect, it } from "vitest";
import { nvidiaMediaUnderstandingProvider } from "./audio-transcription-provider.js";

describe("NVIDIA audio transcription provider", () => {
  const savedEnv = process.env.NVIDIA_ASR_BASE_URL;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.NVIDIA_ASR_BASE_URL;
    } else {
      process.env.NVIDIA_ASR_BASE_URL = savedEnv;
    }
  });

  it("uses normal credential resolution for hosted ASR", () => {
    delete process.env.NVIDIA_ASR_BASE_URL;

    expect(
      nvidiaMediaUnderstandingProvider.resolveAuth?.({
        provider: "nvidia",
        providerConfig: {},
      }),
    ).toBeUndefined();
  });

  it("allows keyless authentication only for a configured custom ASR origin", () => {
    expect(
      nvidiaMediaUnderstandingProvider.resolveAuth?.({
        provider: "nvidia",
        providerConfig: { baseUrl: "http://127.0.0.1:9000/v1" },
      }),
    ).toEqual({ kind: "none", source: "nvidia-self-hosted" });

    process.env.NVIDIA_ASR_BASE_URL = "https://speech.example/v1";
    expect(
      nvidiaMediaUnderstandingProvider.resolveAuth?.({
        provider: "nvidia",
        providerConfig: {},
      }),
    ).toEqual({ kind: "none", source: "nvidia-self-hosted" });
  });
});
