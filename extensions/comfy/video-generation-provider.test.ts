import { expectExplicitVideoGenerationCapabilities } from "openclaw/plugin-sdk/provider-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildComfyConfig,
  mockComfyCloudJobResponses,
  mockComfyProviderApiKey,
  parseComfyJsonBody,
} from "./test-helpers.js";
import {
  _setComfyFetchGuardForTesting,
  buildComfyVideoGenerationProvider,
} from "./video-generation-provider.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

function parseJsonBody(call: number): Record<string, unknown> {
  return parseComfyJsonBody(fetchWithSsrFGuardMock, call);
}

function fetchGuardParams(call: number): { url?: unknown; auditContext?: unknown } {
  const params = fetchWithSsrFGuardMock.mock.calls[call]?.[0];
  if (!params || typeof params !== "object") {
    throw new Error(`expected Comfy fetch guard call ${call}`);
  }
  return params as { url?: unknown; auditContext?: unknown };
}

describe("comfy video-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _setComfyFetchGuardForTesting(null);
    vi.restoreAllMocks();
  });

  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(buildComfyVideoGenerationProvider());
  });

  it("treats local comfy video workflows as configured without an API key", () => {
    const provider = buildComfyVideoGenerationProvider();
    expect(
      provider.isConfigured?.({
        cfg: buildComfyConfig({
          video: {
            workflow: {
              "6": { inputs: { text: "" } },
            },
            promptNodeId: "6",
          },
        }),
      }),
    ).toBe(true);
  });

  it("submits a local workflow, waits for history, and downloads videos", async () => {
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ prompt_id: "local-video-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            "local-video-1": {
              outputs: {
                "9": {
                  gifs: [{ filename: "generated.mp4", subfolder: "", type: "output" }],
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
        response: new Response(Buffer.from("mp4-data"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildComfyVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "comfy",
      model: "workflow",
      prompt: "animate a lobster",
      cfg: buildComfyConfig({
        video: {
          workflow: {
            "6": { inputs: { text: "" } },
            "9": { inputs: {} },
          },
          promptNodeId: "6",
          outputNodeId: "9",
        },
      }),
    });

    expect(fetchGuardParams(0).url).toBe("http://127.0.0.1:8188/prompt");
    expect(fetchGuardParams(0).auditContext).toBe("comfy-video-generate");
    expect(parseJsonBody(1)).toEqual({
      prompt: {
        "6": { inputs: { text: "animate a lobster" } },
        "9": { inputs: {} },
      },
    });
    expect(fetchGuardParams(1).url).toBe("http://127.0.0.1:8188/history/local-video-1");
    expect(fetchGuardParams(1).auditContext).toBe("comfy-history");
    expect(fetchGuardParams(2).url).toBe(
      "http://127.0.0.1:8188/view?filename=generated.mp4&subfolder=&type=output",
    );
    expect(fetchGuardParams(2).auditContext).toBe("comfy-video-download");
    expect(result).toEqual({
      videos: [
        {
          buffer: Buffer.from("mp4-data"),
          mimeType: "video/mp4",
          fileName: "generated.mp4",
          metadata: {
            nodeId: "9",
            promptId: "local-video-1",
          },
        },
      ],
      model: "workflow",
      metadata: {
        promptId: "local-video-1",
        outputNodeIds: ["9"],
      },
    });
  });

  it("uses cloud endpoints for video workflows", async () => {
    mockComfyProviderApiKey();
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    mockComfyCloudJobResponses(fetchWithSsrFGuardMock, {
      body: Buffer.from("cloud-video-data"),
      contentType: "video/mp4",
      filename: "cloud.mp4",
      outputKind: "gifs",
      promptId: "cloud-video-1",
      redirectLocation: "https://cdn.example.com/cloud.mp4",
    });

    const provider = buildComfyVideoGenerationProvider();
    const result = await provider.generateVideo({
      provider: "comfy",
      model: "workflow",
      prompt: "cloud video workflow",
      cfg: buildComfyConfig({
        mode: "cloud",
        video: {
          workflow: {
            "6": { inputs: { text: "" } },
            "9": { inputs: {} },
          },
          promptNodeId: "6",
          outputNodeId: "9",
        },
      }),
    });

    expect(fetchGuardParams(0).url).toBe("https://cloud.comfy.org/api/prompt");
    expect(fetchGuardParams(0).auditContext).toBe("comfy-video-generate");
    expect(result.metadata).toEqual({
      promptId: "cloud-video-1",
      outputNodeIds: ["9"],
    });
  });
});
