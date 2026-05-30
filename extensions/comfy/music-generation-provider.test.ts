import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildComfyMusicGenerationProvider } from "./music-generation-provider.js";
import { setComfyFetchGuardForTesting } from "./workflow-runtime.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

describe("comfy music-generation provider", () => {
  afterEach(() => {
    setComfyFetchGuardForTesting(null);
    vi.clearAllMocks();
  });

  it("registers the workflow model", () => {
    const provider = buildComfyMusicGenerationProvider();

    expect(provider.defaultModel).toBe("workflow");
    expect(provider.models).toEqual(["workflow"]);
    expectExplicitMusicGenerationCapabilities(provider);
  });

  it("runs a music workflow and returns audio outputs", async () => {
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ prompt_id: "music-job-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            "music-job-1": {
              outputs: {
                "9": {
                  audio: [{ filename: "song.mp3", subfolder: "", type: "output" }],
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("music-bytes"), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildComfyMusicGenerationProvider();
    const result = await provider.generateMusic({
      provider: "comfy",
      model: "workflow",
      prompt: "gentle ambient synth loop",
      cfg: {
        plugins: {
          entries: {
            comfy: {
              config: {
                music: {
                  workflow: {
                    "6": { inputs: { text: "" } },
                    "9": { inputs: {} },
                  },
                  promptNodeId: "6",
                  outputNodeId: "9",
                },
              },
            },
          },
        },
      } as never,
    });

    expect(result).toEqual({
      model: "workflow",
      tracks: [
        {
          buffer: Buffer.from("music-bytes"),
          mimeType: "audio/mpeg",
          fileName: "song.mp3",
        },
      ],
      metadata: {
        promptId: "music-job-1",
        outputNodeIds: ["9"],
        inputImageCount: 0,
      },
    });
  });

  it("rejects generated music downloads that exceed the configured media cap", async () => {
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ prompt_id: "music-job-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            "music-job-1": {
              outputs: {
                "9": {
                  audio: [{ filename: "song.mp3", subfolder: "", type: "output" }],
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("too-large"), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildComfyMusicGenerationProvider();
    await expect(
      provider.generateMusic({
        provider: "comfy",
        model: "workflow",
        prompt: "gentle ambient synth loop",
        cfg: {
          plugins: {
            entries: {
              comfy: {
                config: {
                  music: {
                    workflow: {
                      "6": { inputs: { text: "" } },
                      "9": { inputs: {} },
                    },
                    promptNodeId: "6",
                    outputNodeId: "9",
                  },
                },
              },
            },
          },
          agents: { defaults: { mediaMaxMb: 0.000001 } },
        } as never,
      }),
    ).rejects.toThrow("Comfy music output download exceeds 1 bytes");
  });
});
