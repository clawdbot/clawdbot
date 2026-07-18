/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-routes.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../app/context.ts";
import "./onboarding-memory-import.ts";

type OnboardingMemoryImportElement = HTMLElement & {
  active: boolean;
  context: ApplicationContext<RouteId>;
  updateComplete: Promise<boolean>;
};

function waitForOnboardingMemoryImport(assertion: () => void) {
  return vi.waitFor(assertion, { interval: 1 });
}

const guardKey = "openclaw.onboarding.memory-import";

function createProvider(providerId: string, fingerprint: string) {
  return {
    providerId,
    label: providerId === "codex" ? "Codex" : "Claude Code",
    planFingerprint: fingerprint,
    found: true,
    source: `/tmp/${providerId}`,
    target: "/tmp/openclaw-research",
    summary: {
      total: 2,
      planned: 1,
      migrated: 0,
      skipped: 0,
      conflicts: 1,
      errors: 0,
      sensitive: 0,
    },
    items: [
      {
        id: `memory:${providerId}:MEMORY.md`,
        status: "planned" as const,
        source: `/tmp/${providerId}/MEMORY.md`,
      },
      {
        id: `memory:${providerId}:existing.md`,
        status: "conflict" as const,
        source: `/tmp/${providerId}/existing.md`,
      },
    ],
  };
}

function createPlan(providerIds = ["codex"]) {
  return {
    agentId: "research",
    workspace: "/tmp/openclaw-research",
    providers: providerIds.map((providerId, index) =>
      createProvider(providerId, String.fromCharCode(97 + index).repeat(64)),
    ),
  };
}

function createApplyResult(providerId: string, migrated = 1, skipped = 0) {
  return {
    providerId,
    source: `/tmp/${providerId}`,
    summary: {
      total: migrated + skipped,
      planned: 0,
      migrated,
      skipped,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items: [],
  };
}

function createContext(
  request: ReturnType<typeof vi.fn>,
  options: { connected?: boolean; admin?: boolean; agentsLoaded?: boolean } = {},
) {
  const connected = options.connected ?? true;
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client: connected ? client : null,
    connected,
    reconnecting: false,
    hello: {
      auth: {
        role: "operator",
        scopes: options.admin === false ? ["operator.read"] : ["operator.admin"],
      },
    } as ApplicationGatewaySnapshot["hello"],
    assistantAgentId: "research",
    sessionKey: "agent:research:main",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  return {
    gateway: { snapshot, subscribe },
    agents: {
      state: {
        client: connected ? client : null,
        connected,
        agentsLoading: false,
        agentsError: null,
        agentsList:
          options.agentsLoaded === false
            ? null
            : {
                defaultId: "research",
                agents: [{ id: "research", name: "Research" }],
              },
      },
      ensureList: vi.fn(async () => null),
      subscribe,
    },
    agentSelection: {
      state: { selectedId: "research", scopeId: "research" },
      set: vi.fn(),
      setScope: vi.fn(),
      subscribe,
    },
    navigate: vi.fn(),
  } as unknown as ApplicationContext<RouteId>;
}

async function mount(
  context: ApplicationContext<RouteId>,
  active = true,
): Promise<OnboardingMemoryImportElement> {
  const element = document.createElement(
    "openclaw-onboarding-memory-import",
  ) as OnboardingMemoryImportElement;
  element.context = context;
  element.active = active;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("OnboardingMemoryImport", () => {
  it.each([
    { name: "onboarding is inactive", active: false, connected: true, admin: true },
    { name: "gateway is disconnected", active: true, connected: false, admin: true },
    { name: "operator lacks admin access", active: true, connected: true, admin: false },
  ])("stays hidden when $name", async ({ active, connected, admin }) => {
    const request = vi.fn();
    const element = await mount(createContext(request, { connected, admin }), active);

    await Promise.resolve();
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("waits for the agents list and triggers loading it", async () => {
    const request = vi.fn();
    const context = createContext(request, { agentsLoaded: false });
    await mount(context);

    await waitForOnboardingMemoryImport(() =>
      expect(context.agents.ensureList).toHaveBeenCalledTimes(1),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("sets the guard after a successful plan with no offers", async () => {
    const request = vi.fn(async () => createPlan([]));
    const element = await mount(createContext(request));

    await waitForOnboardingMemoryImport(() =>
      expect(sessionStorage.getItem(guardKey)).toBe("done"),
    );
    expect(request).toHaveBeenCalledWith("migrations.memory.plan", {
      agentId: "research",
      overwrite: false,
    });
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("keeps planning errors silent and unguarded", async () => {
    const request = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const element = await mount(createContext(request));

    await waitForOnboardingMemoryImport(() => expect(request).toHaveBeenCalledTimes(1));
    await element.updateComplete;
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(sessionStorage.getItem(guardKey)).toBeNull();
  });

  it("keeps provider-level planning errors unguarded", async () => {
    const provider = createProvider("codex", "a".repeat(64));
    const request = vi.fn(async () => ({
      ...createPlan([]),
      providers: [
        {
          ...provider,
          error: "scan unavailable",
          found: false,
          items: [],
          planFingerprint: undefined,
        },
      ],
    }));
    const element = await mount(createContext(request));

    await waitForOnboardingMemoryImport(() => expect(request).toHaveBeenCalledTimes(1));
    await element.updateComplete;
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(sessionStorage.getItem(guardKey)).toBeNull();
  });

  it("discards a plan when its gateway changes before display", async () => {
    let resolvePlan!: (plan: ReturnType<typeof createPlan>) => void;
    const request = vi.fn(
      async () =>
        await new Promise<ReturnType<typeof createPlan>>((resolve) => {
          resolvePlan = resolve;
        }),
    );
    const context = createContext(request);
    const element = await mount(context);
    await waitForOnboardingMemoryImport(() => expect(request).toHaveBeenCalledTimes(1));

    context.gateway.snapshot.client = createContext(vi.fn()).gateway.snapshot.client;
    resolvePlan(createPlan());

    await Promise.resolve();
    await element.updateComplete;
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(sessionStorage.getItem(guardKey)).toBeNull();
  });

  it("sends frozen provider plans with fresh idempotency keys", async () => {
    const request = vi.fn(async (method: string, params?: { providerId?: string }) => {
      if (method === "migrations.memory.plan") {
        return createPlan(["codex", "claude"]);
      }
      return createApplyResult(params?.providerId ?? "unknown");
    });
    const randomUuid = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    const element = await mount(createContext(request));
    await waitForOnboardingMemoryImport(() =>
      expect(
        element.querySelector<HTMLButtonElement>(
          "[data-test-id='onboarding-memory-import-import']",
        ),
      ).not.toBeNull(),
    );

    element
      .querySelector<HTMLButtonElement>("[data-test-id='onboarding-memory-import-import']")
      ?.click();

    await waitForOnboardingMemoryImport(() => expect(request).toHaveBeenCalledTimes(3));
    const applyCalls = request.mock.calls.filter(
      ([method]) => method === "migrations.memory.apply",
    );
    expect(applyCalls.map(([, params]) => params)).toEqual([
      {
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        agentId: "research",
        providerId: "codex",
        planFingerprint: "a".repeat(64),
        itemIds: ["memory:codex:MEMORY.md"],
        overwrite: false,
      },
      {
        idempotencyKey: "00000000-0000-4000-8000-000000000002",
        agentId: "research",
        providerId: "claude",
        planFingerprint: "b".repeat(64),
        itemIds: ["memory:claude:MEMORY.md"],
        overwrite: false,
      },
    ]);
    expect(randomUuid).toHaveBeenCalledTimes(2);
  });

  it("drops a displayed plan when the gateway context changes", async () => {
    const originalRequest = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      return createApplyResult("codex");
    });
    const replacementRequest = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      return createApplyResult("codex");
    });
    const element = await mount(createContext(originalRequest));
    await waitForOnboardingMemoryImport(() =>
      expect(
        element.querySelector<HTMLButtonElement>(
          "[data-test-id='onboarding-memory-import-import']",
        ),
      ).not.toBeNull(),
    );

    // A new gateway client invalidates the frozen offer: the stale plan must
    // never be applied through the old binding. The offer replans instead.
    element.context = createContext(replacementRequest);
    await element.updateComplete;
    await waitForOnboardingMemoryImport(() => expect(replacementRequest).toHaveBeenCalled());
    expect(replacementRequest.mock.calls[0]?.[0]).toBe("migrations.memory.plan");
    expect(originalRequest).toHaveBeenCalledTimes(1);

    await waitForOnboardingMemoryImport(() =>
      expect(
        element.querySelector<HTMLButtonElement>(
          "[data-test-id='onboarding-memory-import-import']",
        ),
      ).not.toBeNull(),
    );
    element
      .querySelector<HTMLButtonElement>("[data-test-id='onboarding-memory-import-import']")
      ?.click();
    await waitForOnboardingMemoryImport(() =>
      expect(
        replacementRequest.mock.calls.filter((call) => call[0] === "migrations.memory.apply"),
      ).toHaveLength(1),
    );
    expect(
      originalRequest.mock.calls.filter((call) => call[0] === "migrations.memory.apply"),
    ).toHaveLength(0);
  });

  it("shows partial apply failures inline", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "migrations.memory.plan") {
        return createPlan();
      }
      const result = createApplyResult("codex");
      result.summary.errors = 1;
      result.summary.total = 2;
      return result;
    });
    const element = await mount(createContext(request));
    await waitForOnboardingMemoryImport(() =>
      expect(
        element.querySelector<HTMLButtonElement>(
          "[data-test-id='onboarding-memory-import-import']",
        ),
      ).not.toBeNull(),
    );

    element
      .querySelector<HTMLButtonElement>("[data-test-id='onboarding-memory-import-import']")
      ?.click();

    await waitForOnboardingMemoryImport(() => expect(element.textContent).toContain("1 failed"));
    expect(element.textContent).toContain("Migrated 1");
  });

  it("sets the guard when skipped", async () => {
    const request = vi.fn(async () => createPlan());
    const element = await mount(createContext(request));
    await waitForOnboardingMemoryImport(() =>
      expect(
        element.querySelector<HTMLButtonElement>("[data-test-id='onboarding-memory-import-skip']"),
      ).not.toBeNull(),
    );

    element
      .querySelector<HTMLButtonElement>("[data-test-id='onboarding-memory-import-skip']")
      ?.click();

    await element.updateComplete;
    expect(sessionStorage.getItem(guardKey)).toBe("done");
    expect(element.querySelector("openclaw-modal-dialog")).toBeNull();
  });

  it("continues with later providers after a provider error", async () => {
    const request = vi.fn(async (method: string, params?: { providerId?: string }) => {
      if (method === "migrations.memory.plan") {
        return createPlan(["codex", "claude"]);
      }
      if (params?.providerId === "codex") {
        throw new Error("Codex import unavailable");
      }
      return createApplyResult("claude", 1, 0);
    });
    const element = await mount(createContext(request));
    await waitForOnboardingMemoryImport(() =>
      expect(
        element.querySelector<HTMLButtonElement>(
          "[data-test-id='onboarding-memory-import-import']",
        ),
      ).not.toBeNull(),
    );

    element
      .querySelector<HTMLButtonElement>("[data-test-id='onboarding-memory-import-import']")
      ?.click();

    await waitForOnboardingMemoryImport(() =>
      expect(
        element.querySelector<HTMLButtonElement>(
          "[data-test-id='onboarding-memory-import-continue']",
        ),
      ).not.toBeNull(),
    );
    const applyProviders = request.mock.calls
      .filter(([method]) => method === "migrations.memory.apply")
      .map(([, params]) => (params as { providerId: string }).providerId);
    expect(applyProviders).toEqual(["codex", "claude"]);
    expect(element.textContent).toContain("Codex import unavailable");
    expect(element.textContent).toContain("Migrated 1, skipped 0");
  });
});
