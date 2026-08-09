// Comfy tests cover music generation provider plugin behavior.
import { expectExplicitMusicGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildComfyMusicGenerationProvider } from "./music-generation-provider.js";
import { setComfyFetchGuardForTesting } from "./test-support.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

describe("comfy music-generation provider", () => {
  afterEach(() => {
    setComfyFetchGuardForTesting(null);
    vi.clearAllMocks();
    vi.useRealTimers();
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

  it.each([
    {
      label: "forwards the explicit caller budget when the plugin has no timeout",
      requestTimeoutMs: 1_250,
      configuredTimeoutMs: undefined,
      expectedTimeoutMs: 1_250,
    },
    {
      label: "prefers the explicit caller budget over the plugin timeout",
      requestTimeoutMs: 1_250,
      configuredTimeoutMs: 9_000,
      expectedTimeoutMs: 1_250,
    },
    {
      label: "uses the plugin timeout when the caller does not supply a budget",
      requestTimeoutMs: undefined,
      configuredTimeoutMs: 4_200,
      expectedTimeoutMs: 4_200,
    },
  ])("$label", async ({ requestTimeoutMs, configuredTimeoutMs, expectedTimeoutMs }) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ prompt_id: "music-timeout-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            "music-timeout-1": {
              outputs: {
                "9": {
                  audio: [{ filename: "song.mp3", subfolder: "", type: "output" }],
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
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

    await buildComfyMusicGenerationProvider().generateMusic({
      provider: "comfy",
      model: "workflow",
      prompt: "bounded music workflow",
      ...(requestTimeoutMs === undefined ? {} : { timeoutMs: requestTimeoutMs }),
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
                  ...(configuredTimeoutMs === undefined ? {} : { timeoutMs: configuredTimeoutMs }),
                },
              },
            },
          },
        },
      } as never,
    });

    expect(fetchWithSsrFGuardMock.mock.calls.map(([request]) => request.timeoutMs)).toEqual([
      expectedTimeoutMs,
      expectedTimeoutMs,
      expectedTimeoutMs,
    ]);
  });
});
