/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const context = {
    gateway,
    agentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      subscribe: () => () => undefined,
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
  return { client, context, request, runtimeConfig, setGatewayPhase };
}

async function mountPage(
  context: ApplicationContext,
  client: GatewayBrowserClient,
  hello: ApplicationGateway["snapshot"]["hello"] = context.gateway.snapshot.hello,
): Promise<TestModelSetupPage> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-model-setup-page") as TestModelSetupPage;
  page.routeData = {
    state: { phase: "ready", result: detection },
    connection: { client, hello, agentId: context.agentSelection.state.selectedId },
    firstRun: false,
  };
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return page;
}

function selectedModelDetail(page: TestModelSetupPage): string | undefined {
  return page.querySelector(".model-setup__current-copy > .muted")?.textContent?.trim();
}

describe("ModelSetupPage Gateway reconnect ownership", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("recovers when stale route data settles after mounting under a connected gateway", async () => {
    const { context, request, runtimeConfig } = createFixture();
    request.mockImplementation(async (method) =>
      method === "openclaw.setup.detect" ? detection : {},
    );
    const provider = createApplicationContextProvider(context);
    const page = document.createElement("openclaw-model-setup-page") as TestModelSetupPage;
    provider.append(page);
    document.body.append(provider);
    await page.updateComplete;

    expect(request).not.toHaveBeenCalled();

    page.routeData = {
      state: { phase: "loading" },
      connection: { client: null, hello: null, agentId: null },
      firstRun: false,
    };
    await page.updateComplete;

    await vi.waitFor(() => {
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
      ).toHaveLength(1);
      expect(page.querySelector('[data-auth-choice="provider-auth"]')).not.toBeNull();
    });
    runtimeConfig.dispose();
  });

  it("does not expose stale route data when the page mounts during reconnect", async () => {
    const { client, context, request, runtimeConfig, setGatewayPhase } = createFixture();
    request.mockImplementation(async (method) =>
      method === "openclaw.setup.detect" ? detection : {},
    );

    const previousHello = context.gateway.snapshot.hello;
    setGatewayPhase("reconnecting");
    const page = await mountPage(context, client, previousHello);

    expect(page.querySelector('[data-auth-choice="provider-auth"]')).toBeNull();
    expect(request).not.toHaveBeenCalled();

    setGatewayPhase("connected");
    await vi.waitFor(() => {
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
      ).toHaveLength(1);
    });
    runtimeConfig.dispose();
  });

  it("clears stale setup actions and reloads detection after reconnecting the same client", async () => {
    const { client, context, request, runtimeConfig, setGatewayPhase } = createFixture();
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [
            {
              kind: "existing-model",
              label: "Recovered model",
              detail: "Loaded after reconnect",
              modelRef: "provider/recovered",
              recommended: true,
              credentials: true,
            },
          ],
        };
      }
      return {};
    });
    const page = await mountPage(context, client);
    const owner = page as unknown as {
      activationState: { phase: string; targetId?: string; modelRef?: string };
      verifyState: { phase: string };
    };
    owner.activationState = { phase: "testing", targetId: "old", modelRef: "provider/old" };
    owner.verifyState = { phase: "checking" };
    await page.updateComplete;

    setGatewayPhase("reconnecting");
    await page.updateComplete;

    expect(owner.activationState.phase).toBe("idle");
    expect(owner.verifyState.phase).toBe("idle");
    expect(page.querySelector('[data-auth-choice="provider-auth"]')).toBeNull();

    setGatewayPhase("connected");
    await vi.waitFor(() => expect(page.textContent).toContain("Recovered model"));
    expect(
      request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
    ).toHaveLength(1);
    runtimeConfig.dispose();
  });

  it("reloads stale route data when the same client reconnected before page mount", async () => {
    const { client, context, request, runtimeConfig, setGatewayPhase } = createFixture();
    const staleHello = context.gateway.snapshot.hello;
    request.mockImplementation(async (method) =>
      method === "openclaw.setup.detect"
        ? { ...detection, configuredModel: "provider/fresh-model", setupComplete: true }
        : {},
    );
    setGatewayPhase("reconnecting");
    setGatewayPhase("connected");

    const page = await mountPage(context, client, staleHello);

    await vi.waitFor(() => expect(selectedModelDetail(page)).toBe("fresh-model"));
    expect(
      request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
    ).toHaveLength(1);
    runtimeConfig.dispose();
  });

  it("cancels a stale wizard when reconnect phases resolve before Lit renders", async () => {
    const { client, context, request, runtimeConfig, setGatewayPhase } = createFixture();
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
      if (method === "openclaw.setup.detect") {
        return detection;
      }
      return {};
    });
    const page = await mountPage(context, client);
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(oldWizardSignal).toBeInstanceOf(AbortSignal));

    setGatewayPhase("reconnecting");
    setGatewayPhase("connected");
    await vi.waitFor(() => {
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
      ).toHaveLength(1);
    });
    expect(oldWizardSignal?.aborted).toBe(true);
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
    runtimeConfig.dispose();
  });

  it("suppresses a late wizard completion but retains its reconnect refresh warning", async () => {
    const { client, context, request, runtimeConfig, setGatewayPhase } = createFixture();
    let releaseWizard: ((value: unknown) => void) | undefined;
    request.mockImplementation(async (method) => {
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
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "wizard-before-reconnect", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return await new Promise((resolve) => {
          // The server can finish a cancellation-locked commit after the local
          // request was invalidated, so deliberately ignore the abort signal.
          releaseWizard = resolve;
        });
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          configuredModel: "provider/current-model",
          setupComplete: true,
        };
      }
      return {};
    });
    await runtimeConfig.ensureLoaded();
    const page = await mountPage(context, client);
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

  it("rejects a route completion produced before a same-client reconnect", async () => {
    const { client, context, request, runtimeConfig, setGatewayPhase } = createFixture();
    request.mockImplementation(async (method) =>
      method === "openclaw.setup.detect"
        ? {
            ...detection,
            configuredModel: "provider/current-model",
            setupComplete: true,
          }
        : {},
    );
    const page = await mountPage(context, client);
    const staleConnection = page.routeData?.connection;

    setGatewayPhase("reconnecting");
    setGatewayPhase("connected");
    await vi.waitFor(() => expect(selectedModelDetail(page)).toBe("current-model"));
    page.routeData = {
      state: {
        phase: "ready",
        result: {
          ...detection,
          configuredModel: "provider/stale-model",
          setupComplete: true,
        },
      },
      connection: staleConnection!,
      firstRun: false,
    };
    await page.updateComplete;

    expect(selectedModelDetail(page)).not.toBe("stale-model");
    await vi.waitFor(() => expect(selectedModelDetail(page)).toBe("current-model"));
    expect(
      request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
    ).toHaveLength(1);
    runtimeConfig.dispose();
  });
});
