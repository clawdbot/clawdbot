// Comfy tests cover image generation provider plugin behavior.
import type { LookupAddress } from "node:dns";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setComfyFetchGuardForTesting,
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

type FetchGuardRequest = {
  url?: unknown;
  auditContext?: unknown;
  timeoutMs?: unknown;
  policy?: unknown;
  init?: {
    method?: unknown;
    headers?: HeadersInit;
    body?: BodyInit | null;
  };
};
type RealGuardParams = Parameters<typeof fetchWithSsrFGuard>[0];
type RealGuardFetchImpl = NonNullable<RealGuardParams["fetchImpl"]>;
type RealGuardLookupFn = NonNullable<RealGuardParams["lookupFn"]>;
type RealGuardHarness = {
  fetchUrls: string[];
  guardCalls: RealGuardParams[];
};

type RealComfyFetchOptions = {
  dns: Record<string, string>;
  promptId?: string;
  redirectLocation?: string;
  body?: Buffer;
  contentType?: string;
};

function fetchRequest(call: number): FetchGuardRequest {
  const request = fetchWithSsrFGuardMock.mock.calls[call - 1]?.[0] as FetchGuardRequest | undefined;
  if (!request) {
    throw new Error(`expected Comfy fetch call ${call}`);
  }
  return request;
}

function parseJsonBody(call: number): Record<string, unknown> {
  return parseComfyJsonBody(fetchWithSsrFGuardMock, call);
}

function mockLocalImageResponses(promptId = "local-prompt-1") {
  fetchWithSsrFGuardMock
    .mockResolvedValueOnce({
      response: new Response(JSON.stringify({ prompt_id: promptId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(async () => {}),
    })
    .mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({
          [promptId]: {
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
}

const COMFY_SERVICE_HOST_LOCAL_POLICY = {
  allowedOrigins: ["http://comfyui:8188"],
  hostnameAllowlist: ["comfyui"],
};

const COMFY_SERVICE_HOST_EXPLICIT_PRIVATE_NETWORK_POLICY = {
  allowedOrigins: ["http://comfyui:8188"],
};

const COMFY_PUBLIC_LOCAL_HOST_POLICY = {
  hostnameAllowlist: ["images.example.com"],
};

function testWorkflowConfig(config: Record<string, unknown> = {}) {
  return {
    workflow: {
      "6": { inputs: { text: "" } },
      "9": { inputs: {} },
    },
    promptNodeId: "6",
    outputNodeId: "9",
    ...config,
  };
}

function toFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function generatedHistory(promptId: string) {
  return {
    [promptId]: {
      outputs: {
        "9": {
          images: [{ filename: "generated.png", subfolder: "", type: "output" }],
        },
      },
    },
  };
}

function createLookupFn(dns: Record<string, string>): RealGuardLookupFn {
  return (async (hostname: string, options?: unknown) => {
    const normalized = hostname.toLowerCase().replace(/\.+$/u, "");
    const address = dns[normalized] ?? "93.184.216.34";
    const record: LookupAddress = {
      address,
      family: address.includes(":") ? 6 : 4,
    };
    if (
      typeof options === "object" &&
      options !== null &&
      (options as { all?: unknown }).all === true
    ) {
      return [record];
    }
    return record;
  }) as RealGuardLookupFn;
}

function installRealComfyFetchGuard(options: RealComfyFetchOptions): RealGuardHarness {
  const promptId = options.promptId ?? "real-guard-prompt-1";
  const body = options.body ?? Buffer.from("png-data");
  const contentType = options.contentType ?? "image/png";
  const fetchUrls: string[] = [];
  const guardCalls: RealGuardParams[] = [];
  const lookupFn = createLookupFn(options.dns);
  const fetchImpl: RealGuardFetchImpl = async (input) => {
    const url = toFetchUrl(input);
    fetchUrls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/prompt")) {
      return jsonResponse({ prompt_id: promptId });
    }
    if (parsed.pathname === `/api/job/${promptId}/status`) {
      return jsonResponse({ status: "completed" });
    }
    if (
      parsed.pathname === `/history/${promptId}` ||
      parsed.pathname === `/api/history_v2/${promptId}`
    ) {
      return jsonResponse(generatedHistory(promptId));
    }
    if (parsed.pathname === "/view" || parsed.pathname === "/api/view") {
      if (options.redirectLocation) {
        return new Response(null, {
          status: 302,
          headers: { location: options.redirectLocation },
        });
      }
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { "content-type": contentType },
      });
    }
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { "content-type": contentType },
    });
  };

  setComfyFetchGuardForTesting(async (params) => {
    guardCalls.push(params);
    return await fetchWithSsrFGuard({
      ...params,
      fetchImpl,
      lookupFn,
    });
  });
  return { fetchUrls, guardCalls };
}

describe("comfy image-generation provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setComfyFetchGuardForTesting(null);
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
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
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

    const submitRequest = fetchRequest(1);
    expect(submitRequest.url).toBe("http://127.0.0.1:8188/prompt");
    expect(submitRequest.auditContext).toBe("comfy-image-generate");
    expect(parseJsonBody(1)).toEqual({
      prompt: {
        "6": { inputs: { text: "draw a lobster" } },
        "9": { inputs: {} },
      },
    });
    const historyRequest = fetchRequest(2);
    expect(historyRequest.url).toBe("http://127.0.0.1:8188/history/local-prompt-1");
    expect(historyRequest.auditContext).toBe("comfy-history");
    const downloadRequest = fetchRequest(3);
    expect(downloadRequest.url).toBe(
      "http://127.0.0.1:8188/view?filename=generated.png&subfolder=&type=output",
    );
    expect(downloadRequest.auditContext).toBe("comfy-image-download");
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

  it("honors local private-network access for service-discovery hostnames", async () => {
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    mockLocalImageResponses("compose-prompt-1");

    const provider = buildComfyImageGenerationProvider();
    await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "draw a lobster",
      cfg: buildComfyConfig({
        baseUrl: "http://comfyui:8188",
        workflow: {
          "6": { inputs: { text: "" } },
          "9": { inputs: {} },
        },
        promptNodeId: "6",
        outputNodeId: "9",
      }),
    });

    const submitRequest = fetchRequest(1);
    expect(submitRequest.url).toBe("http://comfyui:8188/prompt");
    expect(submitRequest.policy).toEqual(COMFY_SERVICE_HOST_LOCAL_POLICY);
    expect(fetchRequest(2).policy).toEqual(COMFY_SERVICE_HOST_LOCAL_POLICY);
    expect(fetchRequest(3).policy).toEqual(COMFY_SERVICE_HOST_LOCAL_POLICY);
  });

  it("keeps local public-looking hostnames strict without explicit private-network access", async () => {
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    mockLocalImageResponses("public-host-prompt-1");

    const provider = buildComfyImageGenerationProvider();
    await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "draw a lobster",
      cfg: buildComfyConfig({
        baseUrl: "http://images.example.com:8188",
        workflow: {
          "6": { inputs: { text: "" } },
          "9": { inputs: {} },
        },
        promptNodeId: "6",
        outputNodeId: "9",
      }),
    });

    expect(fetchRequest(1).url).toBe("http://images.example.com:8188/prompt");
    expect(fetchRequest(1).policy).toEqual(COMFY_PUBLIC_LOCAL_HOST_POLICY);
  });

  it("keeps cloud service-discovery hostnames strict without explicit private-network access", async () => {
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    mockComfyCloudJobResponses(fetchWithSsrFGuardMock, {
      body: Buffer.from("cloud-data"),
      contentType: "image/png",
      filename: "cloud.png",
      outputKind: "images",
      promptId: "strict-cloud-job-1",
      redirectLocation: "https://cdn.example.com/cloud.png",
    });

    const provider = buildComfyImageGenerationProvider();
    await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "cloud workflow prompt",
      cfg: buildComfyConfig({
        mode: "cloud",
        apiKey: "comfy-test-key",
        baseUrl: "http://comfyui:8188",
        workflow: {
          "6": { inputs: { text: "" } },
          "9": { inputs: {} },
        },
        promptNodeId: "6",
        outputNodeId: "9",
      }),
    });

    expect(fetchRequest(1).url).toBe("http://comfyui:8188/api/prompt");
    expect(fetchRequest(1).policy).toBeUndefined();
  });

  it("honors explicit cloud private-network access for service-discovery hostnames", async () => {
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    mockComfyCloudJobResponses(fetchWithSsrFGuardMock, {
      body: Buffer.from("cloud-data"),
      contentType: "image/png",
      filename: "cloud.png",
      outputKind: "images",
      promptId: "private-cloud-job-1",
      redirectLocation: "https://cdn.example.com/cloud.png",
    });

    const provider = buildComfyImageGenerationProvider();
    await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "cloud workflow prompt",
      cfg: buildComfyConfig({
        mode: "cloud",
        apiKey: "comfy-test-key",
        baseUrl: "http://comfyui:8188",
        allowPrivateNetwork: true,
        workflow: {
          "6": { inputs: { text: "" } },
          "9": { inputs: {} },
        },
        promptNodeId: "6",
        outputNodeId: "9",
      }),
    });

    expect(fetchRequest(1).url).toBe("http://comfyui:8188/api/prompt");
    expect(fetchRequest(1).policy).toEqual(COMFY_SERVICE_HOST_EXPLICIT_PRIVATE_NETWORK_POLICY);
    expect(fetchRequest(2).policy).toEqual(COMFY_SERVICE_HOST_EXPLICIT_PRIVATE_NETWORK_POLICY);
    expect(fetchRequest(3).policy).toEqual(COMFY_SERVICE_HOST_EXPLICIT_PRIVATE_NETWORK_POLICY);
    expect(fetchRequest(4).policy).toEqual(COMFY_SERVICE_HOST_EXPLICIT_PRIVATE_NETWORK_POLICY);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(4);
  });

  it("allows local single-label hostnames that resolve to RFC1918 addresses", async () => {
    const harness = installRealComfyFetchGuard({
      dns: { comfyui: "10.0.0.25" },
    });

    const provider = buildComfyImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "draw a lobster",
      cfg: buildComfyConfig(
        testWorkflowConfig({
          baseUrl: "http://comfyui:8188",
        }),
      ),
    });

    expect(harness.fetchUrls).toContain("http://comfyui:8188/prompt");
    expect(result.images[0]?.buffer).toEqual(Buffer.from("png-data"));
  });

  it("blocks local public-looking FQDNs resolving private without explicit opt-in", async () => {
    const harness = installRealComfyFetchGuard({
      dns: { "images.example.com": "10.0.0.25" },
    });

    const provider = buildComfyImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "draw a lobster",
        cfg: buildComfyConfig(
          testWorkflowConfig({
            baseUrl: "http://images.example.com:8188",
          }),
        ),
      }),
    ).rejects.toThrow("Blocked: resolves to private/internal/special-use IP address");
    expect(harness.fetchUrls).toEqual([]);
  });

  it("allows local private-DNS FQDNs with explicit opt-in", async () => {
    const harness = installRealComfyFetchGuard({
      dns: { "comfy.private.example.com": "10.0.0.25" },
    });

    const provider = buildComfyImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "draw a lobster",
      cfg: buildComfyConfig(
        testWorkflowConfig({
          baseUrl: "http://comfy.private.example.com:8188",
          allowPrivateNetwork: true,
        }),
      ),
    });

    expect(harness.fetchUrls).toContain("http://comfy.private.example.com:8188/prompt");
    expect(result.images[0]?.buffer).toEqual(Buffer.from("png-data"));
  });

  it("blocks explicit private-DNS FQDNs resolving to metadata addresses", async () => {
    const harness = installRealComfyFetchGuard({
      dns: { "comfy.private.example.com": "169.254.169.254" },
    });

    const provider = buildComfyImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "draw a lobster",
        cfg: buildComfyConfig(
          testWorkflowConfig({
            baseUrl: "http://comfy.private.example.com:8188",
            allowPrivateNetwork: true,
          }),
        ),
      }),
    ).rejects.toThrow("Blocked: resolves to private/internal/special-use IP address");
    expect(harness.fetchUrls).toEqual([]);
  });

  it.each([
    [
      "subdomain",
      "http://assets.comfyui:8188/generated.png",
      { comfyui: "10.0.0.25", "assets.comfyui": "10.0.0.26" },
    ],
    [
      "different hostname",
      "http://other-comfy:8188/generated.png",
      { comfyui: "10.0.0.25", "other-comfy": "10.0.0.26" },
    ],
    [
      "same hostname private alternate port",
      "http://comfyui:8288/generated.png",
      { comfyui: "10.0.0.25" },
    ],
    [
      "public CDN hostname",
      "https://cdn.example.com/generated.png",
      { comfyui: "10.0.0.25", "cdn.example.com": "93.184.216.34" },
    ],
  ])("blocks local output redirects to %s", async (_label, redirectLocation, dns) => {
    const harness = installRealComfyFetchGuard({
      dns,
      redirectLocation,
    });

    const provider = buildComfyImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "draw a lobster",
        cfg: buildComfyConfig(
          testWorkflowConfig({
            baseUrl: "http://comfyui:8188",
          }),
        ),
      }),
    ).rejects.toThrow("Blocked");
    expect(harness.fetchUrls).not.toContain(redirectLocation);
  });

  it("blocks local public FQDN redirects to other public hosts", async () => {
    const redirectLocation = "https://cdn.example.com/generated.png";
    const harness = installRealComfyFetchGuard({
      dns: {
        "comfy.example.com": "93.184.216.34",
        "cdn.example.com": "93.184.216.35",
      },
      redirectLocation,
    });

    const provider = buildComfyImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "draw a lobster",
        cfg: buildComfyConfig(
          testWorkflowConfig({
            baseUrl: "https://comfy.example.com",
          }),
        ),
      }),
    ).rejects.toThrow("Blocked hostname (not in allowlist)");
    expect(harness.fetchUrls).not.toContain(redirectLocation);
  });

  it("allows explicit private cloud origins redirecting to public CDNs", async () => {
    const harness = installRealComfyFetchGuard({
      dns: {
        "private-comfy.example.com": "10.0.0.25",
        "cdn.example.com": "93.184.216.34",
      },
      redirectLocation: "https://cdn.example.com/generated.png",
      body: Buffer.from("cdn-data"),
    });

    const provider = buildComfyImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "comfy",
      model: "workflow",
      prompt: "cloud workflow prompt",
      cfg: buildComfyConfig(
        testWorkflowConfig({
          mode: "cloud",
          apiKey: "comfy-test-key",
          baseUrl: "https://private-comfy.example.com",
          allowPrivateNetwork: true,
        }),
      ),
    });

    expect(harness.fetchUrls).toContain("https://cdn.example.com/generated.png");
    expect(harness.guardCalls).toHaveLength(4);
    expect(result.images[0]?.buffer).toEqual(Buffer.from("cdn-data"));
  });

  it.each([
    [
      "private DNS destination",
      "http://other-private.example.com/generated.png",
      {
        "private-comfy.example.com": "10.0.0.25",
        "other-private.example.com": "10.0.0.26",
      },
    ],
    [
      "metadata destination",
      "http://169.254.169.254/latest/meta-data",
      { "private-comfy.example.com": "10.0.0.25" },
    ],
  ])("blocks explicit private cloud redirects to %s", async (_label, redirectLocation, dns) => {
    const harness = installRealComfyFetchGuard({
      dns,
      redirectLocation,
    });

    const provider = buildComfyImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "cloud workflow prompt",
        cfg: buildComfyConfig(
          testWorkflowConfig({
            mode: "cloud",
            apiKey: "comfy-test-key",
            baseUrl: "https://private-comfy.example.com",
            allowPrivateNetwork: true,
          }),
        ),
      }),
    ).rejects.toThrow("Blocked");
    expect(harness.fetchUrls).not.toContain(redirectLocation);
  });

  it("caps oversized local workflow timeouts", async () => {
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(MAX_TIMER_TIMEOUT_MS + 1);
    fetchWithSsrFGuardMock
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ prompt_id: "local-prompt-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ "local-prompt-1": { outputs: {} } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        release: vi.fn(async () => {}),
      });

    try {
      const provider = buildComfyImageGenerationProvider();
      await expect(
        provider.generateImage({
          provider: "comfy",
          model: "workflow",
          prompt: "draw a bounded timer",
          cfg: buildComfyConfig({
            workflow: {
              "6": { inputs: { text: "" } },
              "9": { inputs: {} },
            },
            promptNodeId: "6",
            outputNodeId: "9",
            timeoutMs: Number.MAX_SAFE_INTEGER,
          }),
        }),
      ).rejects.toThrow("Comfy workflow did not finish within 2147000s");

      expect(fetchRequest(1).timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
      expect(fetchRequest(2).timeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("rejects generated image downloads that exceed the configured media cap", async () => {
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
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
        response: new Response(Buffer.from("too-large"), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
        release: vi.fn(async () => {}),
      });

    const provider = buildComfyImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "comfy",
        model: "workflow",
        prompt: "draw a lobster",
        cfg: {
          ...buildComfyConfig({
            workflow: {
              "6": { inputs: { text: "" } },
              "9": { inputs: {} },
            },
            promptNodeId: "6",
            outputNodeId: "9",
          }),
          agents: { defaults: { mediaMaxMb: 0.000001 } },
        } as never,
      }),
    ).rejects.toThrow("Comfy image output download exceeds 1 bytes");
  });

  it("reports malformed local workflow submit JSON as a provider error", async () => {
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response("{ nope", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release,
    });

    const provider = buildComfyImageGenerationProvider();
    await expect(
      provider.generateImage({
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
      }),
    ).rejects.toThrow("Comfy workflow submit failed: malformed JSON response");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uploads reference images for local edit workflows", async () => {
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
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

    const uploadRequest = fetchRequest(1);
    expect(uploadRequest?.url).toBe("http://127.0.0.1:8188/upload/image");
    expect(uploadRequest?.auditContext).toBe("comfy-image-upload");
    expect(uploadRequest?.init?.method).toBe("POST");
    const uploadForm = uploadRequest?.init?.body;
    if (!(uploadForm instanceof FormData)) {
      throw new Error("expected Comfy upload request body to be FormData");
    }
    expect(uploadForm.get("type")).toBe("input");
    expect(uploadForm.get("overwrite")).toBe("true");

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
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
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

    const submitRequest = fetchRequest(1);
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

    const statusRequest = fetchRequest(2);
    expect(statusRequest.url).toBe("https://cloud.comfy.org/api/job/cloud-job-1/status");
    expect(statusRequest.auditContext).toBe("comfy-status");
    const historyRequest = fetchRequest(3);
    expect(historyRequest.url).toBe("https://cloud.comfy.org/api/history_v2/cloud-job-1");
    expect(historyRequest.auditContext).toBe("comfy-history");
    const viewRequest = fetchRequest(4);
    expect(viewRequest.url).toBe(
      "https://cloud.comfy.org/api/view?filename=cloud.png&subfolder=&type=output",
    );
    expect(viewRequest.auditContext).toBe("comfy-image-download");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(4);
    expect(result.metadata).toEqual({
      promptId: "cloud-job-1",
      outputNodeIds: ["9"],
    });
  });

  it("uses plugin config env SecretRef auth for cloud workflows", async () => {
    vi.stubEnv("COMFY_TEST_API_KEY", "comfy-secret-ref-key");
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
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

    const submitRequest = fetchRequest(1);
    const submitHeaders = new Headers(submitRequest?.init?.headers);
    expect(submitHeaders.get("x-api-key")).toBe("comfy-secret-ref-key");
    const requestBody = parseJsonBody(1);
    const extraData = requestBody.extra_data as { api_key_comfy_org?: unknown } | undefined;
    expect(extraData?.api_key_comfy_org).toBe("comfy-secret-ref-key");
  });

  it("uses provider auth fallback for cloud workflows without plugin config API keys", async () => {
    vi.stubEnv("COMFY_API_KEY", "stale-env-key");
    mockComfyProviderApiKey("profile-key");
    setComfyFetchGuardForTesting(fetchWithSsrFGuardMock);
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

    const submitRequest = fetchRequest(1);
    const submitHeaders = new Headers(submitRequest?.init?.headers);
    expect(submitHeaders.get("x-api-key")).toBe("profile-key");
    const requestBody = parseJsonBody(1);
    const extraData = requestBody.extra_data as { api_key_comfy_org?: unknown } | undefined;
    expect(extraData?.api_key_comfy_org).toBe("profile-key");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
