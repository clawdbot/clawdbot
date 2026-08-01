import { describe, expect, it } from "vitest";
import { nvidiaMediaUnderstandingProvider } from "./audio-transcription-provider.js";

describe("NVIDIA audio transcription provider", () => {
  it("uses normal credential resolution for hosted ASR", () => {
    expect(
      nvidiaMediaUnderstandingProvider.resolveAuth?.({
        provider: "nvidia",
      }),
    ).toBeUndefined();

    expect(
      nvidiaMediaUnderstandingProvider.resolveAuth?.({
        provider: "nvidia",
        providerConfig: {
          baseUrl: "https://1598d209-5e27-4d3c-8079-4751568b1081.invocation.api.nvcf.nvidia.com/v1",
          models: [],
        },
      }),
    ).toBeUndefined();
  });

  it("allows keyless authentication only for a configured custom ASR origin", () => {
    expect(
      nvidiaMediaUnderstandingProvider.resolveAuth?.({
        provider: "nvidia",
        providerConfig: { baseUrl: "http://127.0.0.1:9000/v1", models: [] },
      }),
    ).toEqual({ kind: "none", source: "nvidia-self-hosted" });

    expect(
      nvidiaMediaUnderstandingProvider.resolveAuth?.({
        provider: "nvidia",
        effectiveBaseUrl: "http://127.0.0.1:9001/v1",
      }),
    ).toEqual({ kind: "none", source: "nvidia-self-hosted" });

    expect(
      nvidiaMediaUnderstandingProvider.resolveAuth?.({
        provider: "nvidia",
        providerConfig: { baseUrl: "https://integrate.api.nvidia.com/v1", models: [] },
      }),
    ).toBeUndefined();
  });
});
