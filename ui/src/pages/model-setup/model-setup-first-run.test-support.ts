/* @vitest-environment jsdom */

import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { ModelSetupPage, type ModelSetupRouteData } from "./model-setup-page.ts";

export const detection: SystemAgentSetupDetectResult = {
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

export function createFirstRunContext(refreshError?: string, beforeRefresh?: () => Promise<void>) {
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
        await beforeRefresh?.();
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

export async function mountPage(
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

export function candidate(
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

export function requestParameters(params: unknown) {
  if (!params || typeof params !== "object") {
    throw new Error("Expected Gateway request parameters.");
  }
  return params;
}
