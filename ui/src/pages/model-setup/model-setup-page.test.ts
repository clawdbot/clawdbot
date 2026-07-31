/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/index.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import type { ModelSetupRouteData } from "./model-setup-page.ts";
import "./model-setup-page.ts";

type TestModelSetupPage = HTMLElement & {
  routeData?: ModelSetupRouteData;
  updateComplete: Promise<boolean>;
};

const recommendedIconUrl = "https://cdn.simpleicons.org/ollama";
const customIconUrl = "https://cdn.example.com/acme.png";

const detection: SystemAgentSetupDetectResult = {
  candidates: [],
  unavailableCandidates: [],
  manualProviders: [],
  authOptions: [],
  prepareOptions: [
    {
      id: "ollama",
      brandId: "ollama",
      label: "Ollama",
      hint: "Connect to an Ollama server and select a cloud or local model",
    },
    {
      id: "llama-cpp",
      brandId: "llama-cpp",
      label: "Local model (llama.cpp)",
      hint: "Download and run a private GGUF model",
    },
    {
      id: "lmstudio",
      brandId: "lmstudio",
      label: "LM Studio",
      hint: "Connect to a running LM Studio server and use an already loaded model",
    },
  ],
  recommendedInstalls: [
    {
      id: "ollama",
      brandId: "ollama",
      label: "Ollama",
      hint: "Run open models locally",
      website: "https://ollama.com/download",
      icon: recommendedIconUrl,
    },
  ],
  workspace: "/tmp/workspace",
  setupComplete: false,
};

function createContext() {
  const request = vi.fn<GatewayBrowserClient["request"]>();
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: "connected",
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.admin"] },
      features: {
        methods: [
          "openclaw.setup.detect",
          "openclaw.setup.verify",
          "openclaw.setup.activate",
          "openclaw.setup.prepare.start",
        ],
      },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gateway = {
    snapshot,
    connection: {
      gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
      token: "test-token",
      password: "",
      bootstrapToken: "",
    },
    eventLog: [],
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe: () => () => undefined,
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } as unknown as ApplicationGateway;
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  return {
    client,
    request,
    runtimeConfig,
    context: {
      gateway,
      basePath: "/openclaw",
      navigate: vi.fn(),
      runtimeConfig,
    } as unknown as ApplicationContext,
  };
}

async function mountPage(
  context: ApplicationContext,
  routeData: ModelSetupRouteData,
): Promise<{ page: TestModelSetupPage; provider: ApplicationContextProvider }> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-model-setup-page") as TestModelSetupPage;
  page.routeData = routeData;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider };
}

describe("ModelSetupPage catalog icons", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses bundled brand icons without enqueueing their remote artwork", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { context, client } = createContext();
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });

    expect(
      page.querySelector('.model-setup__recommendation [data-provider-icon="ollama"]'),
    ).not.toBeNull();
    expect(page.querySelector(".model-setup__recommendation img")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(page.innerHTML).not.toContain(recommendedIconUrl);
  });

  it("loads unknown wire icons through the authenticated same-origin catalog proxy", async () => {
    const NativeUrl = URL;
    const createObjectURL = vi.fn(() => "blob:acme-icon");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { context, client } = createContext();
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          recommendedInstalls: [
            {
              id: "acme",
              label: "Acme",
              hint: "Install the Acme runtime",
              website: "https://example.com/acme",
              icon: customIconUrl,
            },
          ],
        },
      },
      client,
      firstRun: false,
    });

    await vi.waitFor(() => {
      expect(
        page
          .querySelector<HTMLImageElement>(".model-setup__recommendation img")
          ?.getAttribute("src"),
      ).toBe("blob:acme-icon");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/openclaw/__openclaw__/catalog-icon/${encodeURIComponent(customIconUrl)}`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(page.innerHTML).not.toContain(customIconUrl);

    page.remove();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:acme-icon");
  });

  it("keeps legacy known-provider artwork on the authenticated proxy path", async () => {
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => "blob:legacy-ollama");
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { context, client } = createContext();
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          recommendedInstalls: detection.recommendedInstalls?.map(
            ({ brandId: _brandId, ...entry }) => entry,
          ),
        },
      },
      client,
      firstRun: false,
    });

    await vi.waitFor(() => {
      expect(
        page
          .querySelector<HTMLImageElement>(".model-setup__recommendation img")
          ?.getAttribute("src"),
      ).toBe("blob:legacy-ollama");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/openclaw/__openclaw__/catalog-icon/${encodeURIComponent(recommendedIconUrl)}`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(page.querySelector(".model-setup__recommendation [data-provider-icon]")).toBeNull();
  });

  it("starts a prepare wizard from the download affordance", async () => {
    const { context, client, request } = createContext();
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.prepare.start") {
        return { sessionId: "prepare-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return {
          done: false,
          status: "running",
          step: {
            id: "download",
            type: "progress",
            message: "Downloading model: 25%",
          },
        };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-prepare-choice="llama-cpp"] button')?.click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.prepare.start",
        { sessionId: expect.any(String), authChoice: "llama-cpp" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
      expect(page.textContent).toContain("Downloading model: 25%");
    });
  });

  it("verifies a prepared local provider model before showing success", async () => {
    const { context: baseContext, client, request } = createContext();
    const runtimeConfig = {
      runExternalMutation: vi.fn(async (task) => ({
        ok: true as const,
        value: await task(client),
        refresh: { ok: true as const },
      })),
    } as unknown as ApplicationContext["runtimeConfig"];
    const context = { ...baseContext, runtimeConfig } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.prepare.start") {
        return { sessionId: "prepare-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [
            {
              kind: "existing-model",
              label: "Existing llama.cpp model",
              detail: "Already configured",
              modelRef: "llama-cpp/custom",
              recommended: false,
              credentials: true,
            },
            {
              kind: "provider-auto:llama-cpp",
              brandId: "llama-cpp",
              label: "llama.cpp",
              detail: "Gemma 4 E4B downloaded",
              modelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
              recommended: true,
              credentials: true,
            },
          ],
        };
      }
      if (method === "openclaw.setup.activate") {
        return {
          ok: true,
          modelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
          latencyMs: 731,
          lines: ["Model ready"],
        };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-prepare-choice="llama-cpp"] button')?.click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.activate",
        {
          kind: "provider-auto:llama-cpp",
          modelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(page.textContent).toContain("Connection verified");
      expect(page.textContent).toContain("llama-cpp/gemma-4-e4b-it-q4_k_m");
      expect(page.textContent).toContain("Verified in 731 ms");
    });
  });

  it("keeps an incomplete provider setup visible instead of claiming success", async () => {
    const { context, client, request } = createContext();
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.prepare.start") {
        return { sessionId: "prepare-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          configuredModel: "llama-cpp/persisted-before-verification",
          setupComplete: true,
        };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-prepare-choice="llama-cpp"] button')?.click();

    await vi.waitFor(() => {
      expect(page.textContent).toContain(
        "Local model (llama.cpp) did not expose a usable local model. Review the setup result, then retry.",
      );
    });
    expect(page.textContent).not.toContain("llama-cpp/persisted-before-verification");
    expect(page.textContent).not.toContain("Connection verified");
    expect(request).not.toHaveBeenCalledWith(
      "openclaw.setup.activate",
      expect.anything(),
      expect.anything(),
    );
  });

  it("flushes a pending config draft before one-shot activation and refreshes afterward", async () => {
    vi.useFakeTimers();
    const { context, client, request, runtimeConfig } = createContext();
    const order: string[] = [];
    let config: Record<string, unknown> = { pending: false };
    let hash = "hash-1";
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        order.push(method);
        return {
          config,
          sourceConfig: config,
          raw: JSON.stringify(config),
          hash,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        order.push(method);
        config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hash = "hash-2";
        return { hash };
      }
      if (method === "openclaw.setup.activate") {
        order.push(method);
        config = { ...config, configuredModel: "openai/gpt-5" };
        hash = "hash-3";
        return { ok: true, modelRef: "openai/gpt-5", latencyMs: 42, lines: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    await runtimeConfig.ensureLoaded();
    order.length = 0;
    runtimeConfig.patchForm(["pending"], true);
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [
            {
              kind: "codex-cli",
              brandId: "openai",
              label: "Codex CLI",
              detail: "Signed in locally",
              modelRef: "openai/gpt-5",
              recommended: true,
              credentials: true,
            },
          ],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-candidate-kind="codex-cli"] button')?.click();

    await vi.waitFor(() => {
      expect(order).toEqual(["config.set", "openclaw.setup.activate", "config.get"]);
    });
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
    expect(runtimeConfig.state.configForm).toMatchObject({
      pending: true,
      configuredModel: "openai/gpt-5",
    });
    runtimeConfig.dispose();
  });

  it("does not activate a stale candidate through a replacement connection", async () => {
    const { context: baseContext, client } = createContext();
    const replacementRequest = vi.fn();
    const replacementClient = {
      request: replacementRequest,
    } as unknown as GatewayBrowserClient;
    const context = {
      ...baseContext,
      runtimeConfig: {
        runExternalMutation: vi.fn(async (task) => {
          try {
            return {
              ok: true as const,
              value: await task(replacementClient),
              refresh: { ok: true as const },
            };
          } catch (error) {
            return { ok: false as const, reason: "error" as const, error: String(error) };
          }
        }),
      } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [
            {
              kind: "codex-cli",
              brandId: "openai",
              label: "Codex CLI",
              detail: "Signed in locally",
              modelRef: "openai/gpt-5",
              recommended: true,
              credentials: true,
            },
          ],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-candidate-kind="codex-cli"] button')?.click();

    await vi.waitFor(() => {
      expect(page.textContent).toContain("Connection changed before model activation started.");
    });
    expect(replacementRequest).not.toHaveBeenCalled();
  });

  it("keeps a committed activation successful while surfacing a config refresh warning", async () => {
    const { context: baseContext, client } = createContext();
    const context = {
      ...baseContext,
      runtimeConfig: {
        runExternalMutation: vi.fn(async () => ({
          ok: true as const,
          value: { ok: true, modelRef: "openai/gpt-5", latencyMs: 42, lines: [] },
          refresh: { ok: false as const, error: "config.get failed after model commit" },
        })),
      } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [
            {
              kind: "codex-cli",
              brandId: "openai",
              label: "Codex CLI",
              detail: "Signed in locally",
              modelRef: "openai/gpt-5",
              recommended: true,
              credentials: true,
            },
          ],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-candidate-kind="codex-cli"] button')?.click();

    await vi.waitFor(() => {
      expect(page.textContent).toContain("Connection verified");
      expect(page.textContent).toContain("config.get failed after model commit");
    });
  });
});
