import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _setComfyFetchGuardForTesting,
  buildComfyImageGenerationProvider,
} from "./image-generation-provider.js";
import {
  buildComfyConfig,
  buildLegacyComfyConfig,
  mockComfyCloudJobResponses,
  mockComfyProviderApiKey,
  parseComfyJsonBody,
} from "./test-helpers.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

function parseJsonBody(call: number): Record<string, unknown> {
  return parseComfyJsonBody(fetchWithSsrFGuardMock, call);
}

describe("comfy image-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _setComfyFetchGuardForTesting(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("treats local comfy workflows as configured without an API key", () => {
    const provider = buildComfyImageGenerationProvider();
    expect(
      provider.isConfigured?.({
        cfg: buildComfyConfig({
          workflow: {
            "6": { inputs: { text: "" } },
          },
          promptNodeId: "6",
        }),
      }),
    ).toBe(true);
  });

  it("falls back to legacy models.providers comfy config when plugin config is absent", () => {
    const provider = buildComfyImageGenerationProvider();
    expect(
      provider.isConfigured?.({
        cfg: buildLegacyComfyConfig({
          workflow: {
            "6": { inputs: { text: "" } },
          },
          promptNodeId: "6",
        }),
      }),
    ).toBe(true);
  });

  it("treats cloud comfy workflows as configured with a plugin config API key", () => {
    const provider = buildComfyImageGenerationProvider();
    expect(
      provider.isConfigured?.({
        cfg: buildComfyConfig({
          mode: "cloud",
          apiKey: "comfy-test-key",
          image: {
            workflow: {
              "6": { inputs: { text: "" } },
            },
            promptNodeId: "6",
          },
        }),
      }),
    ).toBe(true);
  });

  it("treats cloud comfy workflows as configured with a plugin config env SecretRef", () => {
    vi.stubEnv("COMFY_TEST_API_KEY", "comfy-secret-ref-key");
    const provider = buildComfyImageGenerationProvider();
    expect(
      provider.isConfigured?.({
        cfg: buildComfyConfig({
          mode: "cloud",
          apiKey: { source: "env", provider: "default", id: "COMFY_TEST_API_KEY" },
          image: {
            workflow: {
              "6": { inputs: { text: "" } },
            },
            promptNodeId: "6",
          },
        }),
      }),
    ).toBe(true);
  });

  it("submits a local workflow, waits for history, and downloads images", async () => {
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ prompt_id: "local-prompt-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            "local-prompt-1": {
              outputs: {
                "9": {
                  images: [{ filename: "generated.png", subfolder: "", type: "output" }],
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
        response: new Response(Buffer.from("png-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildComfyImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "draw a lobster",
      cfg: buildComfyConfig({
        workflow: {
          "6": { inputs: { text: "" } },
          "9": { inputs: {} },
        },
        promptNodeId: "6",
        outputNodeId: "9",
      }),
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: "http://127.0.0.1:8188/prompt",
        auditContext: "comfy-image-generate",
      }),
    );
    expect(parseJsonBody(1)).toEqual({
      prompt: {
        "6": { inputs: { text: "draw a lobster" } },
        "9": { inputs: {} },
      },
    });
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "http://127.0.0.1:8188/history/local-prompt-1",
        auditContext: "comfy-history",
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: "http://127.0.0.1:8188/view?filename=generated.png&subfolder=&type=output",
        auditContext: "comfy-image-download",
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "generated.png",
          metadata: {
            nodeId: "9",
            promptId: "local-prompt-1",
          },
        },
      ],
      model: "workflow",
      metadata: {
        promptId: "local-prompt-1",
        outputNodeIds: ["9"],
      },
    });
  });

  it("uploads reference images for local edit workflows", async () => {
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ name: "upload.png" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ prompt_id: "local-edit-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(
          JSON.stringify({
            "local-edit-1": {
              outputs: {
                "9": {
                  images: [{ filename: "edited.png", subfolder: "", type: "output" }],
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
        response: new Response(Buffer.from("edited-data"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildComfyImageGenerationProvider();
    await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "turn this into a poster",
      cfg: buildComfyConfig({
        workflow: {
          "6": { inputs: { text: "" } },
          "7": { inputs: { image: "" } },
          "9": { inputs: {} },
        },
        promptNodeId: "6",
        inputImageNodeId: "7",
        outputNodeId: "9",
      }),
      inputImages: [
        {
          buffer: Buffer.from("source"),
          mimeType: "image/png",
          fileName: "source.png",
        },
      ],
    });

    const uploadRequest = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(uploadRequest?.url).toBe("http://127.0.0.1:8188/upload/image");
    expect(uploadRequest?.auditContext).toBe("comfy-image-upload");
    expect(uploadRequest?.init?.method).toBe("POST");
    const uploadForm = uploadRequest?.init?.body;
    expect(uploadForm).toBeInstanceOf(FormData);
    expect(uploadForm?.get("type")).toBe("input");
    expect(uploadForm?.get("overwrite")).toBe("true");

    expect(parseJsonBody(2)).toEqual({
      prompt: {
        "6": { inputs: { text: "turn this into a poster" } },
        "7": { inputs: { image: "upload.png" } },
        "9": { inputs: {} },
      },
    });
  });

  it("uses cloud endpoints, auth headers, and partner-node extra_data", async () => {
    mockComfyProviderApiKey();
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    mockComfyCloudJobResponses(fetchWithSsrFGuardMock, {
      body: Buffer.from("cloud-data"),
      contentType: "image/png",
      filename: "cloud.png",
      outputKind: "images",
      promptId: "cloud-job-1",
      redirectLocation: "https://cdn.example.com/cloud.png",
    });

    const provider = buildComfyImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "cloud workflow prompt",
      cfg: buildComfyConfig({
        mode: "cloud",
        workflow: {
          "6": { inputs: { text: "" } },
          "9": { inputs: {} },
        },
        promptNodeId: "6",
        outputNodeId: "9",
      }),
    });

    const submitRequest = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(submitRequest?.url).toBe("https://cloud.comfy.org/api/prompt");
    expect(submitRequest?.auditContext).toBe("comfy-image-generate");
    const submitHeaders = new Headers(submitRequest?.init?.headers);
    expect(submitHeaders.get("x-api-key")).toBe("comfy-test-key");
    expect(parseJsonBody(1)).toEqual({
      prompt: {
        "6": { inputs: { text: "cloud workflow prompt" } },
        "9": { inputs: {} },
      },
      extra_data: {
        api_key_comfy_org: "comfy-test-key",
      },
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: "https://cloud.comfy.org/api/job/cloud-job-1/status",
        auditContext: "comfy-status",
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: "https://cloud.comfy.org/api/history_v2/cloud-job-1",
        auditContext: "comfy-history",
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        url: "https://cloud.comfy.org/api/view?filename=cloud.png&subfolder=&type=output",
        auditContext: "comfy-image-download",
      }),
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        url: "https://cdn.example.com/cloud.png",
        auditContext: "comfy-image-download",
      }),
    );
    expect(result.metadata).toEqual({
      promptId: "cloud-job-1",
      outputNodeIds: ["9"],
    });
  });

  it("uses plugin config env SecretRef auth for cloud workflows", async () => {
    vi.stubEnv("COMFY_TEST_API_KEY", "comfy-secret-ref-key");
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    mockComfyCloudJobResponses(fetchWithSsrFGuardMock, {
      body: Buffer.from("cloud-data"),
      contentType: "image/png",
      filename: "cloud.png",
      outputKind: "images",
      promptId: "cloud-secret-ref-1",
      redirectLocation: "https://cdn.example.com/cloud.png",
    });

    const provider = buildComfyImageGenerationProvider();
    await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "cloud workflow prompt",
      cfg: buildComfyConfig({
        mode: "cloud",
        apiKey: { source: "env", provider: "default", id: "COMFY_TEST_API_KEY" },
        workflow: {
          "6": { inputs: { text: "" } },
          "9": { inputs: {} },
        },
        promptNodeId: "6",
        outputNodeId: "9",
      }),
    });

    const submitRequest = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    const submitHeaders = new Headers(submitRequest?.init?.headers);
    expect(submitHeaders.get("x-api-key")).toBe("comfy-secret-ref-key");
    expect(parseJsonBody(1)).toMatchObject({
      extra_data: {
        api_key_comfy_org: "comfy-secret-ref-key",
      },
    });
  });

  it("uses provider auth fallback for cloud workflows without plugin config API keys", async () => {
    vi.stubEnv("COMFY_API_KEY", "stale-env-key");
    mockComfyProviderApiKey("profile-key");
    _setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    mockComfyCloudJobResponses(fetchWithSsrFGuardMock, {
      body: Buffer.from("cloud-data"),
      contentType: "image/png",
      filename: "cloud.png",
      outputKind: "images",
      promptId: "cloud-profile-1",
      redirectLocation: "https://cdn.example.com/cloud.png",
    });

    const provider = buildComfyImageGenerationProvider();
    await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "cloud workflow prompt",
      cfg: buildComfyConfig({
        mode: "cloud",
        workflow: {
          "6": { inputs: { text: "" } },
          "9": { inputs: {} },
        },
        promptNodeId: "6",
        outputNodeId: "9",
      }),
    });

    const submitRequest = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    const submitHeaders = new Headers(submitRequest?.init?.headers);
    expect(submitHeaders.get("x-api-key")).toBe("profile-key");
    expect(parseJsonBody(1)).toMatchObject({
      extra_data: {
        api_key_comfy_org: "profile-key",
      },
    });
  });
});
