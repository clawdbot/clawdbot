/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClawCatalogEntry,
  ClawLifecyclePlanResult,
  ClawsCatalogSearchResult,
  ClawsDoctorResult,
  ClawsStatusResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import "./claws-page.ts";

const status: ClawsStatusResult = {
  schemaVersion: "openclaw.clawsGatewayStatus.v1",
  records: [],
  summary: { claws: 0, healthy: 0, attention: 0, managed: 0, referenced: 0 },
};

const doctor: ClawsDoctorResult = {
  schemaVersion: "openclaw.clawsGatewayDoctor.v1",
  findings: [],
  summary: { info: 0, warnings: 0, errors: 0 },
};

const configurePlan: ClawLifecyclePlanResult = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "configure",
  planIntegrity: "sha256:configure",
  target: { agentId: "analyst" },
  actions: [],
  capabilities: [],
  blockers: [],
  riskAcknowledgementRequired: false,
};

type TestClawsPage = HTMLElement & {
  updateComplete: Promise<boolean>;
  query: string;
  catalogEntries: ClawCatalogEntry[];
  operationBusy: boolean;
  searchCatalog: () => Promise<void>;
  loadPlan: (pending: { operation: "configure"; target: string }) => Promise<void>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createHarness(params: { methods: string[]; request: GatewayBrowserClient["request"] }) {
  const client = { request: params.request } as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.admin"] },
      features: { methods: params.methods },
    },
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const context = {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    basePath: "",
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  return {
    context,
    disconnect() {
      snapshot = { ...snapshot, phase: "reconnecting" };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

async function mount(context: ApplicationContext): Promise<TestClawsPage> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-claws-page") as TestClawsPage;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return page;
}

describe("ClawsPage", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("uses the independently advertised configure plan method", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "claws.status") {
        return status;
      }
      if (method === "claws.doctor") {
        return doctor;
      }
      if (method === "claws.configure.plan") {
        return configurePlan;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createHarness({
      methods: ["claws.status", "claws.doctor", "claws.configure.plan"],
      request: request as GatewayBrowserClient["request"],
    });
    const page = await mount(harness.context);

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("claws.doctor", {}));
    await page.loadPlan({ operation: "configure", target: "analyst" });

    expect(request).toHaveBeenCalledWith("claws.configure.plan", { target: "analyst" });
  });

  it("drops catalog results returned after the Gateway disconnects", async () => {
    const search = deferred<ClawsCatalogSearchResult>();
    const request = vi.fn(async (method: string) => {
      if (method === "claws.status") {
        return status;
      }
      if (method === "claws.doctor") {
        return doctor;
      }
      if (method === "claws.catalog.search") {
        return await search.promise;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const harness = createHarness({
      methods: ["claws.status", "claws.doctor", "claws.catalog.search", "claws.catalog.detail"],
      request: request as GatewayBrowserClient["request"],
    });
    const page = await mount(harness.context);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("claws.doctor", {}));
    page.query = "analyst";
    const pending = page.searchCatalog();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.catalog.search", {
        query: "analyst",
      }),
    );

    harness.disconnect();
    search.resolve({
      schemaVersion: "openclaw.clawsCatalogSearch.v1",
      entries: [
        {
          packageName: "financial-analyst",
          displayName: "Financial Analyst",
          summary: "Market research",
          channel: "official",
          official: true,
          latestVersion: "1.0.0",
          downloads: 10,
          updatedAtMs: 1,
        },
      ],
    });
    await pending;

    expect(page.catalogEntries).toEqual([]);
    expect(page.operationBusy).toBe(false);
  });
});
