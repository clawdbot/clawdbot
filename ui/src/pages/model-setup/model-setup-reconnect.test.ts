/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import type { ModelSetupRouteData } from "./model-setup-page.ts";
import "./model-setup-page.ts";

type TestModelSetupPage = HTMLElement & {
  routeData?: ModelSetupRouteData;
  updateComplete: Promise<boolean>;
};

const detection: SystemAgentSetupDetectResult = {
  candidates: [],
  unavailableCandidates: [],
  manualProviders: [],
  authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
  prepareOptions: [],
  recommendedInstalls: [],
  workspace: "/tmp/workspace",
  setupComplete: false,
};

function createFixture() {
  const request = vi.fn<GatewayBrowserClient["request"]>();
  const client = { request } as unknown as GatewayBrowserClient;
  const listeners = new Set<(snapshot: ApplicationGateway["snapshot"]) => void>();
  const selectionListeners = new Set<() => void>();
  const connectedSnapshot = {
    client,
    phase: "connected" as const,
    offlineStable: false,
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.admin"] },
      features: { methods: ["openclaw.setup.detect", "openclaw.setup.verify"] },
    },
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  } satisfies ApplicationGateway["snapshot"];
  const gateway = {
    snapshot: connectedSnapshot as ApplicationGateway["snapshot"],
    connection: {
      gatewayUrl: "ws://localhost",
      token: "",
      bootstrapToken: "",
      password: "",
    },
    connectionRevision: 0,
    eventLog: [],
    connect: vi.fn(),
    setSessionKey: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    subscribe: (listener: (snapshot: ApplicationGateway["snapshot"]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } satisfies ApplicationGateway;
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const selection = { selectedId: "main", scopeId: "main" };
  const context = {
    gateway,
    agentSelection: {
      state: selection,
      subscribe: (listener: () => void) => {
        selectionListeners.add(listener);
        return () => selectionListeners.delete(listener);
      },
    },
    basePath: "",
    navigate: vi.fn(),
    runtimeConfig,
  } as unknown as ApplicationContext;
  const setGatewayPhase = (phase: "connected" | "reconnecting") => {
    gateway.snapshot = {
      ...connectedSnapshot,
      phase,
      hello: phase === "connected" ? { ...connectedSnapshot.hello } : null,
    };
    for (const listener of listeners) {
      listener(gateway.snapshot);
    }
  };
  const setAgent = (agentId: string) => {
    selection.selectedId = agentId;
    for (const listener of selectionListeners) {
      listener();
    }
  };
  return {
    context,
    request,
    runtimeConfig,
    setGatewayPhase,
    setAgent,
    detectCalls: () => request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
  };
}

async function mountPage(context: ApplicationContext): Promise<TestModelSetupPage> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-model-setup-page") as TestModelSetupPage;
  page.routeData = { firstRun: false };
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return page;
}

function selectedModelDetail(page: TestModelSetupPage): string | undefined {
  return page.querySelector(".model-setup__current-copy > .muted")?.textContent?.trim();
}

describe("ModelSetupPage detection ownership", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("starts one detection when the visit arrives after mounting on a connected Gateway", async () => {
    const { context, request, runtimeConfig } = createFixture();
    request.mockResolvedValue(detection);
    const provider = createApplicationContextProvider(context);
    const page = document.createElement("openclaw-model-setup-page") as TestModelSetupPage;
    provider.append(page);
    document.body.append(provider);
    await page.updateComplete;

    expect(request).not.toHaveBeenCalled();
    page.routeData = { firstRun: false };
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
      expect(page.querySelector('[data-auth-choice="provider-auth"]')).not.toBeNull();
    });
    runtimeConfig.dispose();
  });

  it("keeps pending detection owned through an equivalent route-data refresh", async () => {
    const { context, request, runtimeConfig, detectCalls } = createFixture();
    const detected = createDeferred<SystemAgentSetupDetectResult>();
    request.mockReturnValue(detected.promise);
    const page = await mountPage(context);
    await vi.waitFor(() => expect(detectCalls()).toHaveLength(1));
    const signal = detectCalls()[0]?.[2]?.signal;
    try {
      page.routeData = { firstRun: false };
      await page.updateComplete;
      expect(detectCalls()).toHaveLength(1);
      expect(signal?.aborted).toBe(false);
      detected.resolve(detection);
      await vi.waitFor(() =>
        expect(page.querySelector('[data-auth-choice="provider-auth"]')).not.toBeNull(),
      );
      expect(detectCalls()).toHaveLength(1);
    } finally {
      detected.resolve(detection);
      runtimeConfig.dispose();
    }
  });

  it("waits for the connected Gateway when the page mounts during reconnect", async () => {
    const { context, request, runtimeConfig, setGatewayPhase, detectCalls } = createFixture();
    request.mockImplementation(async (method) =>
      method === "openclaw.setup.detect" ? detection : {},
    );
    setGatewayPhase("reconnecting");
    const page = await mountPage(context);

    expect(page.querySelector('[data-auth-choice="provider-auth"]')).toBeNull();
    expect(request).not.toHaveBeenCalled();
    setGatewayPhase("connected");
    await vi.waitFor(() => {
      expect(detectCalls()).toHaveLength(1);
      expect(page.querySelector('[data-auth-choice="provider-auth"]')).not.toBeNull();
    });
    runtimeConfig.dispose();
  });

  it.each(["reconnect", "agent", "remount", "reattach"] as const)(
    "cancels stale detection on %s and accepts only the replacement result",
    async (change) => {
      const { context, request, runtimeConfig, setGatewayPhase, setAgent, detectCalls } =
        createFixture();
      const stale = createDeferred<SystemAgentSetupDetectResult>();
      let signal: AbortSignal | undefined;
      request.mockImplementationOnce(async (_method, _params, options) => {
        signal = options?.signal;
        return stale.promise;
      });
      request.mockImplementation(async (method) =>
        method === "openclaw.setup.detect"
          ? { ...detection, configuredModel: "provider/current-model", setupComplete: true }
          : {},
      );
      let page = await mountPage(context);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(page.querySelector(".model-setup__loading")).not.toBeNull();
      if (change === "reconnect") {
        setGatewayPhase("reconnecting");
        setGatewayPhase("connected");
      } else if (change === "agent") {
        setAgent("research");
      } else if (change === "remount") {
        page.remove();
        page = await mountPage(context);
      } else {
        const provider = page.parentElement!;
        page.remove();
        page.routeData = { firstRun: false };
        provider.append(page);
      }
      await vi.waitFor(() => expect(selectedModelDetail(page)).toBe("current-model"));
      expect(signal?.aborted).toBe(true);
      expect(detectCalls()).toHaveLength(2);
      expect(detectCalls().at(-1)).toEqual([
        "openclaw.setup.detect",
        { agentId: change === "agent" ? "research" : "main" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ]);
      // A server can finish after local cancellation; it cannot publish into the next visit.
      stale.resolve({ ...detection, configuredModel: "provider/stale-model", setupComplete: true });
      await vi.waitFor(() => expect(request.mock.settledResults[0]?.type).toBe("fulfilled"));
      await page.updateComplete;
      expect(selectedModelDetail(page)).toBe("current-model");
      runtimeConfig.dispose();
    },
  );

  it("cancels a stale wizard when reconnect phases resolve before Lit renders", async () => {
    const { context, request, runtimeConfig, setGatewayPhase } = createFixture();
    let oldWizardSignal: AbortSignal | undefined;
    request.mockImplementation(async (method, _params, options) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "wizard-before-reconnect", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        oldWizardSignal = options?.signal;
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      return method === "openclaw.setup.detect" ? detection : {};
    });
    const page = await mountPage(context);
    await vi.waitFor(() =>
      expect(page.querySelector('[data-auth-choice="provider-auth"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(oldWizardSignal).toBeInstanceOf(AbortSignal));

    setGatewayPhase("reconnecting");
    setGatewayPhase("connected");
    await vi.waitFor(() => {
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
      ).toHaveLength(2);
    });
    expect(oldWizardSignal?.aborted).toBe(true);
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
    runtimeConfig.dispose();
  });

  it("suppresses a late wizard completion but retains its reconnect refresh warning", async () => {
    const { context, request, runtimeConfig, setGatewayPhase } = createFixture();
    let releaseWizard: ((value: unknown) => void) | undefined;
    request.mockImplementation(async (method) => {
      if (method === "config.get") {
        return { config: {}, sourceConfig: {}, raw: "{}", hash: "hash-1", valid: true, issues: [] };
      }
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "wizard-before-reconnect", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return await new Promise((resolve) => {
          // The server can commit after the local request was invalidated.
          releaseWizard = resolve;
        });
      }
      if (method === "openclaw.setup.detect") {
        return { ...detection, configuredModel: "provider/current-model", setupComplete: true };
      }
      return {};
    });
    await runtimeConfig.ensureLoaded();
    const page = await mountPage(context);
    await vi.waitFor(() =>
      expect(page.querySelector('[data-auth-choice="provider-auth"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(releaseWizard).toBeTypeOf("function"));

    setGatewayPhase("reconnecting");
    setGatewayPhase("connected");
    releaseWizard?.({ done: true, status: "done" });

    await vi.waitFor(() => {
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(page.textContent).toContain(
        "Connection changed before the configuration update was refreshed.",
      );
      expect(selectedModelDetail(page)).toBe("current-model");
    });
    runtimeConfig.dispose();
  });
});
