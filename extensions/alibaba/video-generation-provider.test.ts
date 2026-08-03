// Alibaba tests cover video generation provider plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import {
  expectDashscopeVideoTaskPoll,
  expectExplicitVideoGenerationCapabilities,
  expectSuccessfulDashscopeVideoResult,
  mockSuccessfulDashscopeVideoTask,
} from "openclaw/plugin-sdk/provider-test-contracts";
import {
  DASHSCOPE_WAN_VIDEO_MODELS,
  DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
} from "openclaw/plugin-sdk/video-generation";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const {
  resolveApiKeyForProviderMock,
  postJsonRequestMock,
  fetchWithTimeoutMock,
  fetchWithTimeoutGuardedMock,
  resolveProviderHttpRequestConfigMock,
  sanitizeConfiguredModelProviderRequestMock,
} = getProviderHttpMocks();

let alibabaVideoGenerationProvider: typeof import("./video-generation-provider.js").alibabaVideoGenerationProvider;

beforeAll(async () => {
  ({ alibabaVideoGenerationProvider } = await import("./video-generation-provider.js"));
});

installProviderHttpMockCleanup();

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.unstubAllEnvs();
});

function clearAlibabaAuthEnvironment(): void {
  for (const name of ["MODELSTUDIO_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"]) {
    vi.stubEnv(name, "");
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function requireFirstPostJsonRequest(label: string): Record<string, unknown> {
  const [call] = postJsonRequestMock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return requireRecord(call[0], label);
}

describe("alibaba video generation provider", () => {
  it("declares explicit mode capabilities", () => {
    expectExplicitVideoGenerationCapabilities(alibabaVideoGenerationProvider);
    expect(alibabaVideoGenerationProvider).toMatchObject({
      id: "alibaba",
      label: "Alibaba Model Studio",
      defaultModel: DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
      models: [...DASHSCOPE_WAN_VIDEO_MODELS],
    });
  });

  it.each(["sk-ws-alibaba-standard-key", "sk-alibaba-legacy-standard-key"])(
    "advertises Wan video generation with config-only Standard API key %s",
    (apiKey) => {
      clearAlibabaAuthEnvironment();

      expect(
        alibabaVideoGenerationProvider.isConfigured?.({
          cfg: {
            models: {
              providers: {
                alibaba: {
                  apiKey,
                  baseUrl: "https://dashscope-intl.aliyuncs.com",
                  models: [],
                },
              },
            },
          },
        }),
      ).toBe(true);
    },
  );

  it("does not use Qwen Coding Plan credentials for Alibaba video discovery", () => {
    clearAlibabaAuthEnvironment();

    expect(
      alibabaVideoGenerationProvider.isConfigured?.({
        cfg: {
          models: {
            providers: {
              qwen: {
                apiKey: "qwen-coding-plan-key",
                baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it.each(["", "oauth:alibaba", "custom-local", "secretref-managed"])(
    "does not advertise a non-secret Alibaba credential marker %j",
    (apiKey) => {
      clearAlibabaAuthEnvironment();

      expect(
        alibabaVideoGenerationProvider.isConfigured?.({
          cfg: {
            models: {
              providers: {
                alibaba: {
                  apiKey,
                  baseUrl: "https://dashscope-intl.aliyuncs.com",
                  models: [],
                },
              },
            },
          },
        }),
      ).toBe(false);
    },
  );

  it("tracks whether an allowed Alibaba API-key SecretRef resolves", () => {
    clearAlibabaAuthEnvironment();
    vi.stubEnv("ALIBABA_QA_CONFIG_KEY", "resolved-alibaba-config-key");

    const cfg = {
      models: {
        providers: {
          alibaba: {
            apiKey: {
              source: "env" as const,
              provider: "alibaba-test-env",
              id: "ALIBABA_QA_CONFIG_KEY",
            },
            baseUrl: "https://dashscope-intl.aliyuncs.com",
            models: [],
          },
        },
      },
      secrets: {
        defaults: { env: "alibaba-test-env" },
        providers: {
          "alibaba-test-env": {
            source: "env" as const,
            allowlist: ["ALIBABA_QA_CONFIG_KEY"],
          },
        },
      },
    };

    expect(alibabaVideoGenerationProvider.isConfigured?.({ cfg })).toBe(true);
    vi.stubEnv("ALIBABA_QA_CONFIG_KEY", "");
    expect(alibabaVideoGenerationProvider.isConfigured?.({ cfg })).toBe(false);
  });

  it("preserves Alibaba environment API-key discovery", () => {
    clearAlibabaAuthEnvironment();
    vi.stubEnv("MODELSTUDIO_API_KEY", "alibaba-environment-key");

    expect(alibabaVideoGenerationProvider.isConfigured?.({ cfg: {} })).toBe(true);
  });

  it("does not advertise an inherited Qwen Coding Plan API key", () => {
    clearAlibabaAuthEnvironment();
    vi.stubEnv("QWEN_API_KEY", "sk-sp-qwen-coding-plan-key");

    expect(alibabaVideoGenerationProvider.isConfigured?.({ cfg: {} })).toBe(false);
  });

  it("keeps explicit Standard config above an inherited Coding Plan environment key", () => {
    clearAlibabaAuthEnvironment();
    vi.stubEnv("QWEN_API_KEY", "sk-sp-qwen-coding-plan-key");

    expect(
      alibabaVideoGenerationProvider.isConfigured?.({
        cfg: {
          models: {
            providers: {
              alibaba: {
                auth: "api-key",
                apiKey: "sk-ws-alibaba-standard-key",
                baseUrl: "https://dashscope-intl.aliyuncs.com",
                models: [],
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it.each([
    ["sk-ws-alibaba-profile", "sk-sp-qwen-environment", true],
    ["sk-sp-alibaba-profile", "sk-ws-qwen-environment", false],
  ])("preserves actual profile precedence for %s", async (profileKey, envKey, expected) => {
    clearAlibabaAuthEnvironment();
    vi.stubEnv("QWEN_API_KEY", envKey);
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-alibaba-wan-auth-"));

    try {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "alibaba:standard": {
              type: "api_key",
              provider: "alibaba",
              key: profileKey,
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );

      expect(alibabaVideoGenerationProvider.isConfigured?.({ cfg: {}, agentDir })).toBe(expected);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      await fs.rm(agentDir, { force: true, recursive: true });
    }
  });

  it("rejects a resolved Coding Plan API key before submitting a Wan request", async () => {
    resolveApiKeyForProviderMock.mockResolvedValueOnce({ apiKey: "sk-sp-qwen-coding-plan-key" });

    await expect(
      alibabaVideoGenerationProvider.generateVideo({
        provider: "alibaba",
        model: "wan2.6-t2v",
        prompt: "animate this shot",
        cfg: {},
      }),
    ).rejects.toThrow(/Standard DashScope endpoint.*same-region Standard API key/i);

    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });

  it("submits async Wan generation, polls task status, and downloads the resulting video", async () => {
    mockSuccessfulDashscopeVideoTask({ postJsonRequestMock, fetchWithTimeoutMock });

    const provider = alibabaVideoGenerationProvider;
    const result = await provider.generateVideo({
      provider: "alibaba",
      model: "wan2.6-r2v-flash",
      prompt: "animate this shot",
      cfg: {},
      inputImages: [{ url: "https://example.com/ref.png" }],
      durationSeconds: 6,
      audio: true,
      watermark: false,
    });

    expect(postJsonRequestMock).toHaveBeenCalledOnce();
    const request = requireFirstPostJsonRequest("DashScope request");
    expect(request.url).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    );
    const body = requireRecord(request.body, "DashScope request body");
    expect(body.model).toBe("wan2.6-r2v-flash");
    const input = requireRecord(body.input, "DashScope request input");
    expect(input.prompt).toBe("animate this shot");
    expect(input.img_url).toBe("https://example.com/ref.png");
    const parameters = requireRecord(body.parameters, "DashScope request parameters");
    expect(parameters.duration).toBe(6);
    expect(parameters.enable_audio).toBe(true);
    expect(parameters.watermark).toBe(false);
    expectDashscopeVideoTaskPoll(fetchWithTimeoutMock);
    expectSuccessfulDashscopeVideoResult(result);
  });

  it("applies configured request policy to DashScope video requests", async () => {
    const requestPolicy = {
      allowPrivateNetwork: true,
      headers: { "X-DashScope-Route": "alibaba-policy" },
    };
    const dispatcherPolicy = { mode: "env-proxy" as const };
    resolveProviderHttpRequestConfigMock.mockImplementationOnce((params) => {
      const headers = new Headers(params.defaultHeaders);
      for (const [key, value] of Object.entries(params.request?.headers ?? {})) {
        headers.set(key, value);
      }
      return {
        baseUrl: params.baseUrl ?? params.defaultBaseUrl,
        allowPrivateNetwork: params.request?.allowPrivateNetwork === true,
        headers,
        dispatcherPolicy,
      };
    });
    mockSuccessfulDashscopeVideoTask({ postJsonRequestMock, fetchWithTimeoutMock });

    const provider = alibabaVideoGenerationProvider;
    await provider.generateVideo({
      provider: "alibaba",
      model: "wan2.6-t2v",
      prompt: "animate this shot",
      cfg: {
        models: {
          providers: {
            alibaba: {
              baseUrl: "https://dashscope-intl.aliyuncs.com",
              models: [],
              request: requestPolicy,
            },
          },
        },
      },
    });

    expect(sanitizeConfiguredModelProviderRequestMock).toHaveBeenCalledWith(requestPolicy);
    expect(resolveProviderHttpRequestConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "alibaba",
        capability: "video",
        transport: "http",
        request: requestPolicy,
      }),
    );
    const request = requireFirstPostJsonRequest("DashScope request with request policy");
    expect(request.allowPrivateNetwork).toBe(true);
    expect(request.dispatcherPolicy).toBe(dispatcherPolicy);
    expect(request.headers).toBeInstanceOf(Headers);
    expect((request.headers as Headers).get("x-dashscope-route")).toBe("alibaba-policy");
    expect(fetchWithTimeoutGuardedMock).toHaveBeenNthCalledWith(
      1,
      "https://dashscope-intl.aliyuncs.com/api/v1/tasks/task-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
      expect.any(Number),
      fetch,
      {
        ssrfPolicy: { allowPrivateNetwork: true },
        dispatcherPolicy,
      },
    );
    expect(fetchWithTimeoutGuardedMock).toHaveBeenNthCalledWith(
      2,
      "https://example.com/out.mp4",
      { method: "GET" },
      expect.any(Number),
      fetch,
      {
        ssrfPolicy: { allowPrivateNetwork: true },
        dispatcherPolicy,
      },
    );
  });

  it("fails fast when reference inputs are local buffers instead of remote URLs", async () => {
    const provider = alibabaVideoGenerationProvider;

    await expect(
      provider.generateVideo({
        provider: "alibaba",
        model: "wan2.6-i2v",
        prompt: "animate this local frame",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow(
      "Alibaba Wan video generation currently requires remote http(s) URLs for reference images/videos.",
    );
    expect(postJsonRequestMock).not.toHaveBeenCalled();
  });
});
