/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
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
      label: "llama.cpp",
      hint: "Install a verified llama.cpp server and run a private GGUF model managed by OpenClaw",
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
  const gatewayListeners = new Set<(snapshot: ApplicationGateway["snapshot"]) => void>();
  const snapshot = {
    client,
    phase: "connected",
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.admin"] },
      features: {
        methods: [
          "config.set",
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
    subscribe: (listener: (snapshot: ApplicationGateway["snapshot"]) => void) => {
      gatewayListeners.add(listener);
      return () => gatewayListeners.delete(listener);
    },
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } as unknown as ApplicationGateway;
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  return {
    client,
    request,
    runtimeConfig,
    snapshot,
    publishGatewaySnapshot: (next: ApplicationGateway["snapshot"]) => {
      gateway.snapshot = next;
      for (const listener of gatewayListeners) {
        listener(next);
      }
    },
    context: {
      gateway,
      agentSelection: {
        state: { selectedId: "main", scopeId: "main" },
        subscribe: () => () => undefined,
      },
      basePath: "/openclaw",
      resourceBasePath: "/openclaw",
      navigate: vi.fn(),
      runtimeConfig,
    } as unknown as ApplicationContext,
  };
}

async function mountPage(
  context: ApplicationContext,
  routeData: Omit<ModelSetupRouteData, "connection"> & { client: GatewayBrowserClient | null },
): Promise<{ page: TestModelSetupPage; provider: ApplicationContextProvider }> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-model-setup-page") as TestModelSetupPage;
  const { client, ...data } = routeData;
  page.routeData = {
    ...data,
    connection: {
      client,
      hello: context.gateway.snapshot.hello,
      agentId: context.agentSelection.state.selectedId,
    },
  };
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider };
}

function createFirstRunContext(refreshError?: string) {
  const created = createContext();
  const runExternalMutation = vi.fn(
    async (task: (client: GatewayBrowserClient) => Promise<unknown>) => {
      try {
        const value = await task(created.client);
        return {
          ok: true as const,
          value,
          refresh: refreshError
            ? { ok: false as const, error: refreshError }
            : { ok: true as const },
        };
      } catch (error) {
        return {
          ok: false as const,
          reason: "error" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  return {
    ...created,
    context: {
      ...created.context,
      runtimeConfig: { ...created.context.runtimeConfig, runExternalMutation },
    } as ApplicationContext,
    runExternalMutation,
  };
}

function candidate(
  kind: SystemAgentSetupDetectResult["candidates"][number]["kind"],
  modelRef: string,
  credentials?: boolean,
): SystemAgentSetupDetectResult["candidates"][number] {
  return {
    kind,
    label: kind,
    detail: "Available on this Gateway",
    modelRef,
    recommended: false,
    ...(credentials === undefined ? {} : { credentials }),
  };
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

  it("automatically falls through definitive first-run candidate failures in Gateway order", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method !== "openclaw.setup.activate") {
        throw new Error(`Unexpected method ${method}`);
      }
      return (params as { kind: string }).kind === "openai-api-key"
        ? { ok: false, status: "auth", error: "Saved OpenAI key expired" }
        : { ok: true, modelRef: "provider-auto/model", latencyMs: 42, lines: [] };
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [
            candidate("claude-cli", "claude-cli/signed-out", false),
            candidate("openai-api-key", "openai/expired", true),
            candidate("provider-auto:local", "provider-auto/model"),
          ],
        },
      },
      client,
      firstRun: true,
    });

    await waitForFast(() => {
      expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        [
          "openclaw.setup.activate",
          { agentId: "main", kind: "openai-api-key", modelRef: "openai/expired" },
        ],
        [
          "openclaw.setup.activate",
          { agentId: "main", kind: "provider-auto:local", modelRef: "provider-auto/model" },
        ],
      ]);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
    (page as unknown as { requestUpdate: () => void }).requestUpdate();
    await page.updateComplete;
    expect(request).toHaveBeenCalledTimes(2);
    expect(context.navigate).toHaveBeenCalledOnce();
  });

  it("stops first-run activation after an ambiguous transport failure", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockRejectedValue(new Error("Activation connection dropped after dispatch"));

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [
            candidate("openai-api-key", "openai/first", true),
            candidate("anthropic-api-key", "anthropic/second", true),
          ],
        },
      },
      client,
      firstRun: true,
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("Activation connection dropped after dispatch");
    });
    expect(request).toHaveBeenCalledOnce();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("verifies an existing first-run model before entering chat or offering continuation", async () => {
    const { context, client, request } = createFirstRunContext();
    let resolveVerification:
      | ((result: { ok: true; modelRef: string; latencyMs: number }) => void)
      | undefined;
    request.mockImplementation(async (method: string) => {
      if (method !== "openclaw.setup.verify") {
        throw new Error(`Unexpected method ${method}`);
      }
      return await new Promise<{ ok: true; modelRef: string; latencyMs: number }>((resolve) => {
        resolveVerification = resolve;
      });
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: { ...detection, configuredModel: "openai/existing", setupComplete: true },
      },
      client,
      firstRun: true,
    });

    await waitForFast(() => expect(resolveVerification).toBeTypeOf("function"));
    expect(page.textContent).not.toContain("Continue setup");
    expect(context.navigate).not.toHaveBeenCalled();
    resolveVerification?.({ ok: true, modelRef: "openai/existing", latencyMs: 42 });

    await waitForFast(() => expect(context.navigate).toHaveBeenCalledWith("chat"));
    expect(request).toHaveBeenCalledOnce();
  });

  it("explains how to recover when an existing model cannot be verified by this Gateway", async () => {
    const { context, client, request, snapshot } = createFirstRunContext();
    snapshot.hello.features.methods = snapshot.hello.features.methods.filter(
      (method) => method !== "openclaw.setup.verify",
    );

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: { ...detection, configuredModel: "openai/existing", setupComplete: true },
      },
      client,
      firstRun: true,
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("The Gateway is running an older OpenClaw version");
      expect(page.textContent).toContain("Update");
      expect(page.textContent).toContain("Reconnect");
    });
    expect(page.textContent).not.toContain("Continue setup");
    expect(request).not.toHaveBeenCalled();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("repairs definitively failed existing setup with a different credentialed candidate", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.verify") {
        return { ok: false, status: "auth", error: "The saved login expired" };
      }
      if (method === "openclaw.setup.activate") {
        return { ok: true, modelRef: "anthropic/replacement", latencyMs: 37, lines: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          configuredModel: "openai/existing",
          setupComplete: true,
          candidates: [
            candidate("existing-model", "openai/existing", true),
            candidate("openai-api-key", "openai/existing", true),
            candidate("anthropic-api-key", "anthropic/replacement", true),
          ],
        },
      },
      client,
      firstRun: true,
    });

    await waitForFast(() => {
      expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        ["openclaw.setup.verify", { agentId: "main" }],
        [
          "openclaw.setup.activate",
          { agentId: "main", kind: "anthropic-api-key", modelRef: "anthropic/replacement" },
        ],
      ]);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
  });

  it("does not replace a configured model after ambiguous first-run verification failure", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockRejectedValue(new Error("Gateway verification connection dropped"));

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          configuredModel: "openai/existing",
          setupComplete: true,
          candidates: [candidate("anthropic-api-key", "anthropic/replacement", true)],
        },
      },
      client,
      firstRun: true,
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("Gateway verification connection dropped");
    });
    expect(page.textContent).not.toContain("Continue setup");
    expect(request).toHaveBeenCalledOnce();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("keeps a successfully committed first-run setup visible when config refresh fails", async () => {
    const { context, client, request } = createFirstRunContext(
      "config.get failed after model commit",
    );
    request.mockResolvedValue({ ok: true, modelRef: "openai/new", latencyMs: 42, lines: [] });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/new", true)],
        },
      },
      client,
      firstRun: true,
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("Connection verified");
      expect(page.textContent).toContain("config.get failed after model commit");
    });
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("waits for the replacement Gateway to verify a committed model before onboarding", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.activate") {
        return {
          ok: true,
          modelRef: "openai/new",
          latencyMs: 42,
          lines: [],
          gatewayRestartRequired: true,
        };
      }
      if (method === "openclaw.setup.detect") {
        return { ...detection, configuredModel: "openai/new", setupComplete: true };
      }
      if (method === "openclaw.setup.verify") {
        return { ok: true, modelRef: "openai/new", latencyMs: 31 };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/new", true)],
        },
      },
      client,
      firstRun: true,
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("The Gateway is restarting");
    });
    expect(context.navigate).not.toHaveBeenCalled();
    expect(page.textContent).not.toContain("Continue setup");

    publishGatewaySnapshot({
      ...context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    } as ApplicationGateway["snapshot"]);
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    } as ApplicationGateway["snapshot"]);

    await waitForFast(() => {
      expect(
        request.mock.calls
          .map(([method]) => method)
          .filter((method) => method.startsWith("openclaw.setup.")),
      ).toEqual(["openclaw.setup.activate", "openclaw.setup.detect", "openclaw.setup.verify"]);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
  });

  it("does not accept a different verified model after a required Gateway restart", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.activate") {
        return { ok: true, modelRef: "openai/expected", gatewayRestartRequired: true };
      }
      if (method === "openclaw.setup.detect") {
        return { ...detection, configuredModel: "openai/different", setupComplete: true };
      }
      if (method === "openclaw.setup.verify") {
        return { ok: true, modelRef: "openai/different", latencyMs: 31 };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/expected", true)],
        },
      },
      client,
      firstRun: true,
    });
    await waitForFast(() => expect(page.textContent).toContain("The Gateway is restarting"));

    publishGatewaySnapshot({
      ...context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    } as ApplicationGateway["snapshot"]);
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    } as ApplicationGateway["snapshot"]);

    await waitForFast(() => {
      expect(page.textContent).toContain("The model could not be activated");
      expect(page.textContent).toContain("openai/expected");
    });
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("does not automatically verify or activate models from ordinary settings", async () => {
    const { context, client, request } = createFirstRunContext();

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          configuredModel: "openai/existing",
          setupComplete: true,
          candidates: [candidate("anthropic-api-key", "anthropic/replacement", true)],
        },
      },
      client,
      firstRun: false,
    });

    expect(page.textContent).toContain("anthropic/replacement");
    expect(request).not.toHaveBeenCalled();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("does not automatically activate when the Gateway does not advertise activation", async () => {
    const { context, client, request, snapshot } = createFirstRunContext();
    snapshot.hello.features.methods = snapshot.hello.features.methods.filter(
      (method) => method !== "openclaw.setup.activate",
    );

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/detected", true)],
        },
      },
      client,
      firstRun: true,
    });

    expect(page.textContent).toContain("openai/detected");
    expect(request).not.toHaveBeenCalled();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("does not continue a stale first-run activation after leaving the onboarding route", async () => {
    const { context, client, request } = createFirstRunContext();
    let resolveActivation:
      | ((result: { ok: false; status: "auth"; error: string }) => void)
      | undefined;
    request.mockImplementation(
      async () =>
        await new Promise<{ ok: false; status: "auth"; error: string }>((resolve) => {
          resolveActivation = resolve;
        }),
    );

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [
            candidate("openai-api-key", "openai/first", true),
            candidate("anthropic-api-key", "anthropic/second", true),
          ],
        },
      },
      client,
      firstRun: true,
    });
    await waitForFast(() => expect(resolveActivation).toBeTypeOf("function"));

    page.routeData = { ...page.routeData!, firstRun: false };
    await page.updateComplete;
    resolveActivation?.({ ok: false, status: "auth", error: "The first login expired" });

    await waitForFast(() => expect(page.textContent).toContain("The first login expired"));
    expect(request).toHaveBeenCalledOnce();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("redetects before activating when stale first-run route data replaces ready state", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [candidate("anthropic-api-key", "anthropic/fresh", true)],
        };
      }
      if (method === "openclaw.setup.activate") {
        const { modelRef } = params as { modelRef: string };
        return { ok: true, modelRef, latencyMs: 42, lines: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/stale", true)],
        },
      },
      client,
      firstRun: false,
    });

    page.routeData = {
      ...page.routeData!,
      firstRun: true,
      connection: {
        ...page.routeData!.connection,
        hello: { ...page.routeData!.connection.hello! },
      },
    };
    await page.updateComplete;

    await waitForFast(() => {
      expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        ["openclaw.setup.detect", { agentId: "main" }],
        [
          "openclaw.setup.activate",
          { agentId: "main", kind: "anthropic-api-key", modelRef: "anthropic/fresh" },
        ],
      ]);
    });
    expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
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

  it("redacts secrets in displayed detection failures", async () => {
    const { context, client, request, runtimeConfig } = createContext();
    request.mockRejectedValue(new Error("OPENAI_API_KEY=sk-1234567890abcdef"));
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });

    await (page as unknown as { detect: () => Promise<unknown> }).detect();

    expect(page.textContent).toContain("OPENAI_API_KEY=sk-123...cdef");
    expect(page.textContent).not.toContain("sk-1234567890abcdef");
    runtimeConfig.dispose();
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

    await waitForFast(() => {
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

    await waitForFast(() => {
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

    await waitForFast(() => {
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.prepare.start",
        { sessionId: expect.any(String), agentId: "main", authChoice: "llama-cpp" },
        { timeoutMs: null },
      );
      expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
      expect(page.textContent).toContain("Downloading model: 25%");
    });
  });

  it("verifies a prepared local provider model before showing success", async () => {
    const choiceId = "vendor/local:v1%beta?x#y";
    const preparedDetection: SystemAgentSetupDetectResult = {
      ...detection,
      prepareOptions: [
        {
          id: choiceId,
          brandId: "llama-cpp",
          label: "llama.cpp",
          hint: "Install a verified llama.cpp server and run a private GGUF model managed by OpenClaw",
        },
      ],
    };
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
        return {
          done: true,
          status: "done",
          preparedModelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
        };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...preparedDetection,
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
              kind: "provider-auto:vendor%2Flocal%3Av1%25beta%3Fx%23y",
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
      state: { phase: "ready", result: preparedDetection },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>(`[data-prepare-choice="${choiceId}"] button`)?.click();

    await waitForFast(() => {
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.activate",
        {
          agentId: "main",
          kind: "provider-auto:vendor%2Flocal%3Av1%25beta%3Fx%23y",
          modelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(page.textContent).toContain("Connection verified");
      expect(page.textContent).toContain("llama-cpp/gemma-4-e4b-it-q4_k_m");
      expect(page.textContent).toContain("Verified in 731 ms");
    });
    expect(request).not.toHaveBeenCalledWith(
      "openclaw.setup.detect",
      expect.anything(),
      expect.anything(),
    );
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

    await waitForFast(() => {
      expect(page.textContent).toContain(
        "llama.cpp did not expose a usable local model. Review the setup result, then retry.",
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

  it("owns the complete wizard action between draft flush and authoritative refresh", async () => {
    const { context, client, request, runtimeConfig } = createContext();
    const order: string[] = [];
    let config: Record<string, unknown> = { pending: false };
    let hash = "hash-1";
    request.mockImplementation(async (method: string, params?: unknown) => {
      order.push(method);
      if (method === "config.get") {
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
        config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hash = "hash-2";
        return { hash };
      }
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "wizard-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        config = { ...config, configuredModel: "provider/model" };
        hash = "hash-3";
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          configuredModel: "provider/model",
          setupComplete: true,
        };
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
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();

    await waitForFast(() => {
      expect(order).toEqual([
        "config.set",
        "openclaw.setup.auth.start",
        "wizard.next",
        "config.get",
        "openclaw.setup.detect",
      ]);
      expect(page.textContent).toContain("Connection verified");
    });
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
    runtimeConfig.dispose();
  });

  it("drops a queued wizard action when setup access changes before dispatch", async () => {
    const { context, client, request, runtimeConfig, snapshot } = createContext();
    let releaseConfigSet: ((value: { hash: string }) => void) | undefined;
    request.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          config: {},
          sourceConfig: {},
          raw: "{}",
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        return await new Promise<{ hash: string }>((resolve) => {
          releaseConfigSet = resolve;
        });
      }
      throw new Error(`Unexpected method ${method}`);
    });
    await runtimeConfig.ensureLoaded();
    runtimeConfig.patchForm(["pending"], true);
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(releaseConfigSet).toBeTypeOf("function"));
    snapshot.hello.auth.scopes = ["operator.read"];
    releaseConfigSet?.({ hash: "hash-2" });

    await waitForFast(() => expect(page.textContent).toContain("Model setup request failed."));
    expect(request).not.toHaveBeenCalledWith(
      "openclaw.setup.auth.start",
      expect.anything(),
      expect.anything(),
    );
    runtimeConfig.dispose();
  });

  it("keeps autonomous gateway progress inside the wizard mutation lane", async () => {
    const { context, client, request, runtimeConfig } = createContext();
    const order: string[] = [];
    let nextCount = 0;
    let releaseProgress: ((value: unknown) => void) | undefined;
    request.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        order.push("config.get");
        return {
          config: {},
          sourceConfig: {},
          raw: "{}",
          hash: "hash-1",
          valid: true,
          issues: [],
        };
      }
      order.push(method);
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "wizard-session", done: false, status: "running" };
      }
      if (method === "wizard.next" && nextCount++ === 0) {
        return {
          done: false,
          status: "running",
          step: { id: "download", type: "progress", message: "Downloading", executor: "gateway" },
        };
      }
      if (method === "wizard.next") {
        return await new Promise((resolve) => {
          releaseProgress = resolve;
        });
      }
      if (method === "wizard.cancel") {
        return {};
      }
      if (method === "openclaw.setup.detect") {
        return { ...detection, configuredModel: "provider/model", setupComplete: true };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    await runtimeConfig.ensureLoaded();
    order.length = 0;
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(releaseProgress).toBeTypeOf("function"));

    const competingMutation = runtimeConfig.runExternalMutation(async () => {
      order.push("competing-mutation");
    });
    await Promise.resolve();
    expect(order).not.toContain("competing-mutation");

    page.querySelector<HTMLButtonElement>("openclaw-modal-dialog .btn")?.click();
    await page.updateComplete;
    await Promise.resolve();
    expect(order).not.toContain("competing-mutation");

    releaseProgress?.({ done: true, status: "done" });
    await competingMutation;
    expect(order.indexOf("competing-mutation")).toBeGreaterThan(order.indexOf("config.get"));
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

    await waitForFast(() => {
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

    await waitForFast(() => {
      expect(page.textContent).toContain("Connection verified");
      expect(page.textContent).toContain("config.get failed after model commit");
    });
  });

  it("coordinates wizard requests and keeps an authoritative refresh warning visible", async () => {
    const { context: baseContext, client, request } = createContext();
    const runExternalMutation = vi.fn(
      async (task: (client: GatewayBrowserClient) => Promise<unknown>) => ({
        ok: true as const,
        value: await task(client),
        refresh: { ok: false as const, error: "config.get failed after wizard commit" },
      }),
    );
    const context = {
      ...baseContext,
      runtimeConfig: {
        ...baseContext.runtimeConfig,
        runExternalMutation,
      },
    } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "wizard-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return {
          done: false,
          status: "running",
          step: { id: "token", type: "text", message: "Paste token" },
        };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();

    await waitForFast(() => {
      expect(runExternalMutation).toHaveBeenCalledTimes(1);
      expect(page.textContent).toContain("config.get failed after wizard commit");
      expect(page.textContent).toContain("Paste token");
    });
    page.querySelector<HTMLButtonElement>("openclaw-modal-dialog .btn")?.click();
    await page.updateComplete;
    expect(page.textContent).toContain("config.get failed after wizard commit");
  });
});
