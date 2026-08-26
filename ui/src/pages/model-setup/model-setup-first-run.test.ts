/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { ModelSetupPage, type ModelSetupRouteData } from "./model-setup-page.ts";

const detection: SystemAgentSetupDetectResult = {
  candidates: [],
  unavailableCandidates: [],
  manualProviders: [],
  authOptions: [],
  prepareOptions: [],
  recommendedInstalls: [],
  workspace: "/tmp/workspace",
  setupComplete: false,
};

function mutableGatewaySnapshot(snapshot: ApplicationGateway["snapshot"]) {
  return snapshot;
}

function createFirstRunContext(refreshError?: string) {
  const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
  const client = createTestGatewayClient(request);
  const listeners = new Set<(snapshot: ApplicationGateway["snapshot"]) => void>();
  const snapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: {
      type: "hello-ok",
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
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  } satisfies ApplicationGateway["snapshot"];
  const gateway = {
    snapshot: mutableGatewaySnapshot(snapshot),
    connection: {
      gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
      token: "test-token",
      password: "",
      bootstrapToken: "",
    },
    connectionRevision: 0,
    eventLog: [],
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe: (listener: (next: ApplicationGateway["snapshot"]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } satisfies ApplicationGateway;
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const runExternalMutation = vi.fn(
    async (task: (connectedClient: GatewayBrowserClient) => Promise<unknown>) => {
      try {
        const value = await task(client);
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
  const context = {
    gateway,
    agentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      subscribe: () => () => undefined,
    },
    basePath: "/openclaw",
    resourceBasePath: "/openclaw",
    navigate: vi.fn(),
    runtimeConfig: { ...runtimeConfig, runExternalMutation },
    // SAFETY: the first-run page consumes only the gateway, agent selection,
    // navigation, and runtime config fixtures defined above.
  } as unknown as ApplicationContext;
  return {
    client,
    context,
    request,
    snapshot,
    publishGatewaySnapshot: (next: ApplicationGateway["snapshot"]) => {
      gateway.snapshot = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
  };
}

async function mountPage(
  context: ApplicationContext,
  routeData: Omit<ModelSetupRouteData, "connection"> & { client: GatewayBrowserClient | null },
) {
  const provider = createApplicationContextProvider(context);
  const page = new ModelSetupPage();
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

function requestParameters(params: unknown) {
  if (!params || typeof params !== "object") {
    throw new Error("Expected Gateway request parameters.");
  }
  return params;
}

describe("ModelSetupPage first-run inference", () => {
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
    request.mockImplementation(async (method, params) => {
      if (method !== "openclaw.setup.activate") {
        throw new Error(`Unexpected method ${method}`);
      }
      const parameters = requestParameters(params);
      return "kind" in parameters && parameters.kind === "openai-api-key"
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
    page.requestUpdate();
    await page.updateComplete;
    expect(request).toHaveBeenCalledTimes(2);
    expect(context.navigate).toHaveBeenCalledOnce();
  });

  it("automatically activates newly discovered credentials when first-run setup is checked again", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/newly-available", true)],
        };
      }
      if (method === "openclaw.setup.activate") {
        return { ok: true, modelRef: "openai/newly-available", latencyMs: 42, lines: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: true,
    });
    const checkAgain = page.querySelector<HTMLButtonElement>(".model-setup__intro .btn");
    expect(checkAgain?.textContent).toContain("Check again");
    checkAgain?.click();

    await waitForFast(() => {
      expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        ["openclaw.setup.detect", { agentId: "main" }],
        [
          "openclaw.setup.activate",
          { agentId: "main", kind: "openai-api-key", modelRef: "openai/newly-available" },
        ],
      ]);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
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
    request.mockImplementation(async (method) => {
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
    request.mockImplementation(async (method) => {
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
    request.mockImplementation(async (method) => {
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
    });
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    });

    await waitForFast(() => {
      expect(
        request.mock.calls
          .map(([method]) => method)
          .filter((method) => method.startsWith("openclaw.setup.")),
      ).toEqual(["openclaw.setup.activate", "openclaw.setup.detect", "openclaw.setup.verify"]);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
  });

  it("finishes onboarding when the Gateway reconnects before its activation response", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    let resolveActivation:
      | ((result: { ok: true; modelRef: string; gatewayRestartRequired: true }) => void)
      | undefined;
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.activate") {
        return await new Promise<{
          ok: true;
          modelRef: string;
          gatewayRestartRequired: true;
        }>((resolve) => {
          resolveActivation = resolve;
        });
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
    await waitForFast(() => expect(resolveActivation).toBeTypeOf("function"));

    publishGatewaySnapshot({
      ...context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    });

    await waitForFast(() => {
      expect(
        request.mock.calls
          .map(([method]) => method)
          .filter((method) => method.startsWith("openclaw.setup.")),
      ).toEqual(["openclaw.setup.activate", "openclaw.setup.detect", "openclaw.setup.verify"]);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
    expect(context.navigate).not.toHaveBeenCalledWith("chat");
    resolveActivation?.({ ok: true, modelRef: "openai/new", gatewayRestartRequired: true });
  });

  it("does not repeat an unconfirmed activation after reconnect without an explicit retry", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    let resolveFirstActivation:
      | ((result: { ok: true; modelRef: string; gatewayRestartRequired: true }) => void)
      | undefined;
    let activationCount = 0;
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.activate") {
        activationCount += 1;
        if (activationCount === 1) {
          return await new Promise<{
            ok: true;
            modelRef: string;
            gatewayRestartRequired: true;
          }>((resolve) => {
            resolveFirstActivation = resolve;
          });
        }
        return { ok: true, modelRef: "openai/new", latencyMs: 31, lines: [] };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/new", true)],
        };
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
    await waitForFast(() => expect(resolveFirstActivation).toBeTypeOf("function"));

    publishGatewaySnapshot({
      ...context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("The model could not be activated");
      expect(page.textContent).toContain("Check again");
    });
    expect(activationCount).toBe(1);
    expect(context.navigate).not.toHaveBeenCalled();

    page.querySelector<HTMLButtonElement>(".model-setup__intro .btn")?.click();

    await waitForFast(() => {
      expect(activationCount).toBe(2);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
    resolveFirstActivation?.({ ok: true, modelRef: "openai/new", gatewayRestartRequired: true });
  });

  it("rejects a different committed model before verification or another activation", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    let resolveFirstActivation:
      | ((result: { ok: true; modelRef: string; gatewayRestartRequired: true }) => void)
      | undefined;
    let activationCount = 0;
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.activate") {
        activationCount += 1;
        if (activationCount === 1) {
          return await new Promise<{
            ok: true;
            modelRef: string;
            gatewayRestartRequired: true;
          }>((resolve) => {
            resolveFirstActivation = resolve;
          });
        }
        return { ok: true, modelRef: "openai/expected", latencyMs: 31, lines: [] };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          configuredModel: "anthropic/different",
          setupComplete: true,
          candidates: [candidate("openai-api-key", "openai/expected", true)],
        };
      }
      if (method === "openclaw.setup.verify") {
        return { ok: false, status: "auth", error: "The different model could not be verified" };
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
    await waitForFast(() => expect(resolveFirstActivation).toBeTypeOf("function"));

    publishGatewaySnapshot({
      ...context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("The model could not be activated");
      expect(page.textContent).toContain("openai/expected");
    });
    expect(
      request.mock.calls
        .map(([method]) => method)
        .filter((method) => method.startsWith("openclaw.setup.")),
    ).toEqual(["openclaw.setup.activate", "openclaw.setup.detect"]);
    expect(activationCount).toBe(1);
    expect(context.navigate).not.toHaveBeenCalled();
    resolveFirstActivation?.({
      ok: true,
      modelRef: "openai/expected",
      gatewayRestartRequired: true,
    });
  });

  it("does not accept a different verified model after a required Gateway restart", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    request.mockImplementation(async (method) => {
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
    });
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    });

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
    request.mockImplementation(async (method, params) => {
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [candidate("anthropic-api-key", "anthropic/fresh", true)],
        };
      }
      if (method === "openclaw.setup.activate") {
        const parameters = requestParameters(params);
        if (!("modelRef" in parameters)) {
          throw new Error("Model activation is missing its model reference.");
        }
        return { ok: true, modelRef: parameters.modelRef, latencyMs: 42, lines: [] };
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
});
