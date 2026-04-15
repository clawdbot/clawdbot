import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectExplicitVideoGenerationCapabilities } from "../../test/helpers/media-generation/provider-capability-assertions.js";
import {
  _setComfyFetchGuardForTesting,
  buildComfyVideoGenerationProvider,
} from "./video-generation-provider.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

function parseJsonBody(call: number): Record<string, unknown> {
  const request = fetchWithSsrFGuardMock.mock.calls[call - 1]?.[0];
  expect(request?.init?.body).toBeTruthy();
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
}

function buildComfyConfig(config: Record<string, unknown>): OpenClawConfig {
  return {
    models: {
      providers: {
        comfy: config,
      },
    },
  } as unknown as OpenClawConfig;
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

    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "http://127.0.0.1:8188/prompt",
        auditContext: "comfy-video-generate",
      }),
    );
    expect(parseJsonBody(1)).toEqual({
      prompt: {
        "6": { inputs: { text: "animate a lobster" } },
        "9": { inputs: {} },
      },
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "http://127.0.0.1:8188/history/local-video-1",
        auditContext: "comfy-history",
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: "http://127.0.0.1:8188/view?filename=generated.mp4&subfolder=&type=output",
        auditContext: "comfy-video-download",
      }),
    );
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
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "comfy-test-key",
      source: "env",
      mode: "api-key",
    });
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ prompt_id: "cloud-video-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ status: "completed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            "cloud-video-1": {
              outputs: {
                "9": {
                  gifs: [{ filename: "cloud.mp4", subfolder: "", type: "output" }],
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
        response: new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.com/cloud.mp4" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(Buffer.from("cloud-video-data"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
        release: vi.fn(async () => {}),
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

    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "https://cloud.comfy.org/api/prompt",
        auditContext: "comfy-video-generate",
      }),
    );
    expect(result.metadata).toEqual({
      promptId: "cloud-video-1",
      outputNodeIds: ["9"],
    });
  });
});
